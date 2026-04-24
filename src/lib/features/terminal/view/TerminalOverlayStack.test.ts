import { fireEvent, render, screen, within } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingClipboardImage } from "../../../clipboard";
import { initializeI18n } from "../../../i18n";
import { contextMenuItemTestId, TEST_IDS, editorPickerItemTestId } from "../../../testids";
import TerminalOverlayStack from "./TerminalOverlayStack.svelte";

type OverlayStackProps = ComponentProps<typeof TerminalOverlayStack>;

function createPendingImage(): PendingClipboardImage {
  return {
    blob: new Blob(["image"], { type: "image/png" }),
    previewUrl: "blob:terminal-overlay-test",
    mimeType: "image/png",
    size: 5,
  };
}

function createProps(): OverlayStackProps {
  return {
    linkMenuVisible: false,
    linkMenuX: 16,
    linkMenuY: 24,
    linkMenuItems: [
      {
        kind: "item",
        id: "copy-path",
        label: "Copy path",
      },
    ],
    pendingClipboardImage: null,
    clipboardBusy: false,
    clipboardError: null,
    editorPickerVisible: false,
    editorPickerTitle: "Open with",
    editorPickerDescription: "Choose an editor",
    editorPickerEmptyLabel: "No editors",
    defaultEditorId: "code",
    editors: [
      {
        id: "code",
        label: "VS Code",
      },
    ],
    interruptConfirmVisible: false,
    onLinkMenuSelect: vi.fn(),
    onCloseLinkMenu: vi.fn(),
    onCancelClipboardImage: vi.fn(),
    onConfirmClipboardImage: vi.fn(),
    onEditorSelect: vi.fn(),
    onCloseEditorPicker: vi.fn(),
    onCloseInterruptConfirm: vi.fn(),
    onConfirmInterrupt: vi.fn(),
  };
}

describe("TerminalOverlayStack", () => {
  beforeEach(() => {
    initializeI18n("ko", "ko-KR");
  });

  it("forwards context menu selection and close events", async () => {
    const props = createProps();
    render(TerminalOverlayStack, {
      ...props,
      linkMenuVisible: true,
    });

    const menu = screen.getByTestId(TEST_IDS.contextMenu);
    await fireEvent.click(within(menu).getByTestId(contextMenuItemTestId("copy-path")));
    expect(props.onLinkMenuSelect).toHaveBeenCalledWith(props.linkMenuItems[0]);
    expect(props.onCloseLinkMenu).toHaveBeenCalledTimes(1);
  });

  it("forwards image paste modal actions", async () => {
    const props = createProps();
    render(TerminalOverlayStack, {
      ...props,
      pendingClipboardImage: createPendingImage(),
    });

    await fireEvent.click(screen.getByTestId(TEST_IDS.imagePasteConfirm));
    expect(props.onConfirmClipboardImage).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByTestId(TEST_IDS.imagePasteCancel));
    expect(props.onCancelClipboardImage).toHaveBeenCalledTimes(1);
  });

  it("forwards editor picker selection and close events", async () => {
    const props = createProps();
    render(TerminalOverlayStack, {
      ...props,
      editorPickerVisible: true,
    });

    await fireEvent.click(screen.getByTestId(editorPickerItemTestId("code")));
    expect(props.onEditorSelect).toHaveBeenCalledWith(props.editors[0]);

    await fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(props.onCloseEditorPicker).toHaveBeenCalledTimes(1);
  });

  it("forwards interrupt confirm modal actions", async () => {
    const props = createProps();
    render(TerminalOverlayStack, {
      ...props,
      interruptConfirmVisible: true,
    });

    await fireEvent.click(screen.getByRole("button", { name: "Ctrl+C 보내기" }));
    expect(props.onConfirmInterrupt).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(props.onCloseInterruptConfirm).toHaveBeenCalledTimes(1);
  });
});
