import { describe, expect, it, vi } from "vitest";
import type { PendingClipboardImage, SavedClipboardImage } from "../../../clipboard";
import { createOverlayClipboardImageController } from "./overlay-clipboard-image-controller";
import { createOverlayInteractionState } from "../state/overlay-interaction-state.svelte";

function createPending(
  previewUrl: string,
  blob = new Blob(["image"], { type: "image/png" }),
): PendingClipboardImage {
  return {
    blob,
    previewUrl,
    mimeType: blob.type || "image/png",
    size: blob.size,
  };
}

function createController(options: {
  draftOpen?: boolean;
  visible?: boolean;
  readImageFromClipboardImpl?: () => Promise<Blob | null>;
  getImageFromPasteEventImpl?: () => Blob | null;
  saveClipboardImageImpl?: (
    image: PendingClipboardImage,
    distro: string,
  ) => Promise<SavedClipboardImage>;
} = {}) {
  const state = createOverlayInteractionState();
  let pendingCounter = 0;
  const deps = {
    getDistro: () => "Ubuntu",
    getVisible: () => options.visible ?? true,
    getDraftOpen: () => options.draftOpen ?? false,
    focusDraft: vi.fn(),
    focusOutput: vi.fn(),
    routeInsertedText: vi.fn(),
    setNotice: vi.fn(),
    t: (key: string) => key,
    createPendingClipboardImage: vi.fn((blob: Blob) => {
      pendingCounter += 1;
      return createPending(`blob:${pendingCounter}`, blob);
    }),
    revokePendingClipboardImage: vi.fn(),
    readImageFromClipboard: vi.fn(options.readImageFromClipboardImpl ?? (async () => null)),
    getImageFromPasteEvent: vi.fn(options.getImageFromPasteEventImpl ?? (() => null)),
    saveClipboardImage: vi.fn(
      options.saveClipboardImageImpl
        ?? (async () => ({
          hostPath: "C:\\temp\\image.png",
          wslPath: "/tmp/image.png",
          filename: "image.png",
        })),
    ),
    formatPathForAgentInput: vi.fn((path: string) => `${path} `),
  };
  const controller = createOverlayClipboardImageController(state, deps);

  return {
    controller,
    deps,
    state,
  };
}

function createPasteEvent() {
  return {
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

describe("overlay-clipboard-image-controller", () => {
  it("opens clipboard image previews and revokes the previous preview", () => {
    const { controller, deps, state } = createController();
    state.pendingClipboardImage = createPending("blob:old");
    state.clipboardError = "previous error";

    const blob = new Blob(["next"], { type: "image/png" });
    controller.openClipboardPreview(blob);

    expect(deps.createPendingClipboardImage).toHaveBeenCalledWith(blob);
    expect(deps.revokePendingClipboardImage).toHaveBeenCalledWith(expect.objectContaining({ previewUrl: "blob:old" }));
    expect(state.pendingClipboardImage).toMatchObject({ previewUrl: "blob:1" });
    expect(state.clipboardError).toBeNull();
  });

  it("resets image state, revokes the pending preview, and restores focus", () => {
    const draftRuntime = createController({ draftOpen: true });
    draftRuntime.state.pendingClipboardImage = createPending("blob:draft");
    draftRuntime.state.clipboardError = "failed";

    draftRuntime.controller.resetClipboardImage(true);

    expect(draftRuntime.deps.revokePendingClipboardImage).toHaveBeenCalledWith(expect.objectContaining({ previewUrl: "blob:draft" }));
    expect(draftRuntime.state.pendingClipboardImage).toBeNull();
    expect(draftRuntime.state.clipboardError).toBeNull();
    expect(draftRuntime.deps.focusDraft).toHaveBeenCalledTimes(1);

    const outputRuntime = createController({ draftOpen: false });
    outputRuntime.state.pendingClipboardImage = createPending("blob:output");
    outputRuntime.controller.resetClipboardImage(true);

    expect(outputRuntime.deps.focusOutput).toHaveBeenCalledTimes(1);
  });

  it("shows a notice and restores focus when the system clipboard has no image", async () => {
    const { controller, deps } = createController({
      draftOpen: true,
      readImageFromClipboardImpl: async () => null,
    });

    await controller.handlePasteImageFromClipboard();

    expect(deps.setNotice).toHaveBeenCalledWith("terminal.assist.clipboardNoImage");
    expect(deps.focusDraft).toHaveBeenCalledTimes(1);
  });

  it("shows a notice and restores focus when reading the system clipboard fails", async () => {
    const { controller, deps } = createController({
      readImageFromClipboardImpl: async () => {
        throw new Error("clipboard denied");
      },
    });

    await controller.handlePasteImageFromClipboard();

    expect(deps.setNotice).toHaveBeenCalledWith("clipboard denied");
    expect(deps.focusOutput).toHaveBeenCalledTimes(1);
  });

  it("opens a preview from the system clipboard when an image is available", async () => {
    const blob = new Blob(["clipboard"], { type: "image/png" });
    const { controller, state } = createController({
      readImageFromClipboardImpl: async () => blob,
    });

    await controller.handlePasteImageFromClipboard();

    expect(state.pendingClipboardImage).toMatchObject({ previewUrl: "blob:1" });
  });

  it("saves a pending image, inserts the formatted path, and clears image state", async () => {
    const pendingImage = createPending("blob:pending");
    const { controller, deps, state } = createController();
    state.pendingClipboardImage = pendingImage;

    await controller.confirmClipboardImage();

    expect(deps.saveClipboardImage).toHaveBeenCalledWith(pendingImage, "Ubuntu");
    expect(deps.formatPathForAgentInput).toHaveBeenCalledWith("/tmp/image.png");
    expect(deps.routeInsertedText).toHaveBeenCalledWith("/tmp/image.png ");
    expect(deps.revokePendingClipboardImage).toHaveBeenCalledWith(pendingImage);
    expect(state.pendingClipboardImage).toBeNull();
    expect(state.clipboardBusy).toBe(false);
    expect(deps.focusOutput).toHaveBeenCalledTimes(1);
  });

  it("keeps the pending image and surfaces an error when save fails", async () => {
    const pendingImage = createPending("blob:pending");
    const { controller, state } = createController({
      saveClipboardImageImpl: async () => {
        throw new Error("save failed");
      },
    });
    state.pendingClipboardImage = pendingImage;

    await controller.confirmClipboardImage();

    expect(state.pendingClipboardImage).toMatchObject({ previewUrl: pendingImage.previewUrl });
    expect(state.clipboardError).toBe("save failed");
    expect(state.clipboardBusy).toBe(false);
  });

  it("opens previews from draft and terminal paste events while respecting terminal visibility", () => {
    const blob = new Blob(["paste"], { type: "image/png" });
    const draft = createController({
      getImageFromPasteEventImpl: () => blob,
    });
    const draftEvent = createPasteEvent();

    draft.controller.handleDraftPaste(draftEvent);

    expect(draftEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(draft.state.pendingClipboardImage).toMatchObject({ previewUrl: "blob:1" });

    const visibleTerminal = createController({
      visible: true,
      getImageFromPasteEventImpl: () => blob,
    });
    const visibleTerminalEvent = createPasteEvent();

    visibleTerminal.controller.handleTerminalPaste(visibleTerminalEvent);

    expect(visibleTerminalEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(visibleTerminal.state.pendingClipboardImage).toMatchObject({ previewUrl: "blob:1" });

    const hiddenTerminal = createController({
      visible: false,
      getImageFromPasteEventImpl: () => blob,
    });
    const terminalEvent = createPasteEvent();

    hiddenTerminal.controller.handleTerminalPaste(terminalEvent);

    expect(terminalEvent.preventDefault).not.toHaveBeenCalled();
    expect(hiddenTerminal.state.pendingClipboardImage).toBeNull();
  });
});
