import { render, screen } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { initializeSettings } from "../../../stores/settings.svelte";
import { TEST_IDS } from "../../../testids";
import { DEFAULT_SETTINGS } from "../../../types";
import TerminalRuntimeSurface from "./TerminalRuntimeSurface.svelte";

type RuntimeSurfaceProps = ComponentProps<typeof TerminalRuntimeSurface>;

function createProps(): RuntimeSurfaceProps {
  return {
    viewMode: "terminal",
    linkHovering: false,
    outputElement: undefined,
    spawnError: null,
    clipboardNotice: null,
    terminalLoadingState: null,
    terminalLoadingLabel: "Connecting",
    draftOpen: false,
    draftTitle: "Draft",
    draftValue: "",
    draftHeightPx: null,
    draftElement: null,
    draftPanelElement: null,
    auxInitialized: false,
    auxVisible: false,
    auxBusy: false,
    auxHeightPercent: 35,
    auxCurrentPath: "/workspace",
    auxSpawnError: null,
    auxLoadingState: null,
    auxLoadingLabel: "Aux loading",
    auxTitle: "Aux",
    auxPathLabel: "Current path",
    auxOutputElement: null,
    assistPanelElement: null,
    onDraftResizeStart: vi.fn(),
    onCloseDraft: vi.fn(),
    onDraftInput: vi.fn(),
    onDraftKeydown: vi.fn(),
    onDraftPaste: vi.fn(),
    onInsertDraft: vi.fn(),
    onSendDraft: vi.fn(),
    onAuxResizeStart: vi.fn(),
    onCloseAux: vi.fn(),
    onPasteImage: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenEditor: vi.fn(),
    onToggleAux: vi.fn(),
    onToggleDraft: vi.fn(),
  };
}

describe("TerminalRuntimeSurface", () => {
  beforeEach(() => {
    initializeSettings(DEFAULT_SETTINGS);
    initializeI18n("ko", "ko-KR");
  });

  it("keeps the terminal output mounted while hiding the runtime surface", async () => {
    const props = createProps();
    const view = render(TerminalRuntimeSurface, props);

    expect(screen.getByTestId(TEST_IDS.terminalOutput)).toBeInTheDocument();
    expect(view.container.querySelector(".terminal-runtime--hidden")).toBeNull();

    await view.rerender({
      ...props,
      viewMode: "editor",
    });

    expect(screen.getByTestId(TEST_IDS.terminalOutput)).toBeInTheDocument();
    expect(view.container.querySelector(".terminal-runtime--hidden")).toBeInTheDocument();
  });

  it("renders link hover, clipboard notice, and loading feedback", () => {
    const props = createProps();
    render(TerminalRuntimeSurface, {
      ...props,
      linkHovering: true,
      clipboardNotice: "Copied",
      terminalLoadingState: "connecting",
      terminalLoadingLabel: "Connecting",
    });

    expect(screen.getByTestId(TEST_IDS.terminalOutput)).toHaveClass("terminal-output--link-hover");
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.getByText("Connecting")).toBeInTheDocument();
  });

  it("prioritizes spawn errors over the loading overlay", () => {
    const props = createProps();
    render(TerminalRuntimeSurface, {
      ...props,
      spawnError: "spawn failed",
      terminalLoadingState: "connecting",
      terminalLoadingLabel: "Connecting",
    });

    expect(screen.getByText(/spawn failed/)).toBeInTheDocument();
    expect(screen.queryByText("Connecting")).not.toBeInTheDocument();
  });
});
