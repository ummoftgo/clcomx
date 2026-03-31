import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../i18n";
import PreviewTerminal from "./PreviewTerminal.svelte";
import { TEST_IDS } from "../testids";

describe("PreviewTerminal draft controls", () => {
  beforeEach(() => {
    initializeI18n("ko", "ko-KR");
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
  });

  it("toggles draft and auxiliary controls", async () => {
    const onAuxStateChange = vi.fn();

    render(PreviewTerminal, {
      sessionId: "preview-a",
      visible: true,
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/home/user/work/project",
      ptyId: -1,
      onAuxStateChange,
    });

    expect(screen.getByTestId(TEST_IDS.draftTextarea)).toBeInTheDocument();

    await fireEvent.click(screen.getByTestId(TEST_IDS.draftToggle));
    expect(screen.queryByTestId(TEST_IDS.draftTextarea)).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId(TEST_IDS.draftToggle));
    expect(screen.getByTestId(TEST_IDS.draftTextarea)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /닫기|close/i }));
    expect(screen.queryByTestId(TEST_IDS.draftTextarea)).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId(TEST_IDS.auxTerminalToggle));
    expect(onAuxStateChange).toHaveBeenCalled();
  });

  it("keeps draft and auxiliary terminal mutually exclusive", async () => {
    render(PreviewTerminal, {
      sessionId: "preview-b",
      visible: true,
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/home/user/work/project",
      ptyId: -1,
    });

    expect(screen.getByTestId(TEST_IDS.draftTextarea)).toBeInTheDocument();

    await fireEvent.click(screen.getByTestId(TEST_IDS.auxTerminalToggle));
    expect(screen.queryByTestId(TEST_IDS.draftTextarea)).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId(TEST_IDS.draftToggle));
    expect(screen.getByTestId(TEST_IDS.draftTextarea)).toBeInTheDocument();
    expect(screen.queryByText("Preview only. No shell process is attached.")).not.toBeInTheDocument();
  });

  it("preserves the resized draft height after closing and reopening", async () => {
    const { container } = render(PreviewTerminal, {
      sessionId: "preview-c",
      visible: true,
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/home/user/work/project",
      ptyId: -1,
    });

    const panel = container.querySelector<HTMLDivElement>(".draft-panel");
    const handle = container.querySelector<HTMLButtonElement>(".draft-resize-handle");
    expect(panel).not.toBeNull();
    expect(handle).not.toBeNull();

    Object.defineProperty(panel!, "scrollHeight", {
      configurable: true,
      get: () => 112,
    });
    panel!.getBoundingClientRect = () =>
      ({
        height: 112,
      }) as DOMRect;

    await fireEvent.pointerDown(handle!, { button: 0, clientY: 360, pointerId: 1 });
    await fireEvent.pointerMove(window, { clientY: 280, pointerId: 1 });
    await fireEvent.pointerUp(window, { pointerId: 1 });

    const resizedHeight = panel!.style.height;
    expect(resizedHeight).not.toBe("");

    await fireEvent.click(screen.getByTestId(TEST_IDS.draftToggle));
    expect(screen.queryByTestId(TEST_IDS.draftTextarea)).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId(TEST_IDS.draftToggle));

    const reopenedPanel = container.querySelector<HTMLDivElement>(".draft-panel");
    const reopenedHandle = container.querySelector<HTMLButtonElement>(".draft-resize-handle");
    expect(reopenedPanel?.style.height).toBe(resizedHeight);

    Object.defineProperty(reopenedPanel!, "scrollHeight", {
      configurable: true,
      get: () => 112,
    });
    reopenedPanel!.getBoundingClientRect = () =>
      ({
        height: 112,
      }) as DOMRect;

    await fireEvent.pointerDown(reopenedHandle!, { button: 0, clientY: 360, pointerId: 2 });
    await fireEvent.pointerMove(window, { clientY: 520, pointerId: 2 });
    await fireEvent.pointerUp(window, { pointerId: 2 });

    expect(reopenedPanel?.style.height).toBe("112px");
  });
});
