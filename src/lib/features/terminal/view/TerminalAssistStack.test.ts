import { fireEvent, render, screen } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { initializeSettings } from "../../../stores/settings.svelte";
import { TEST_IDS } from "../../../testids";
import { DEFAULT_SETTINGS } from "../../../types";
import TerminalAssistStack from "./TerminalAssistStack.svelte";

type AssistStackProps = ComponentProps<typeof TerminalAssistStack>;

function createProps(): AssistStackProps {
  return {
    draftOpen: true,
    draftTitle: "Draft",
    draftValue: "echo test",
    draftHeightPx: 160,
    draftElement: null,
    draftPanelElement: null,
    auxInitialized: true,
    auxVisible: true,
    auxBusy: false,
    auxHeightPercent: 35,
    auxCurrentPath: "/workspace",
    auxSpawnError: null,
    auxLoadingState: "connecting",
    auxLoadingLabel: "Connecting",
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

describe("TerminalAssistStack", () => {
  beforeEach(() => {
    initializeSettings(DEFAULT_SETTINGS);
    initializeI18n("ko", "ko-KR");
  });

  it("composes draft, aux, and assist panels with handler wiring", async () => {
    const props = createProps();
    const { container } = render(TerminalAssistStack, props);

    expect(screen.getByTestId(TEST_IDS.draftTextarea)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.auxTerminalShell)).toBeInTheDocument();
    expect(screen.getByText("Connecting")).toBeInTheDocument();

    const draftResizeHandle = container.querySelector<HTMLButtonElement>(".draft-resize-handle");
    const auxResizeHandle = container.querySelector<HTMLButtonElement>(".aux-resize-handle");
    expect(draftResizeHandle).not.toBeNull();
    expect(auxResizeHandle).not.toBeNull();

    await fireEvent.click(screen.getByTestId(TEST_IDS.draftInsertButton));
    expect(props.onInsertDraft).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByTestId(TEST_IDS.draftSendButton));
    expect(props.onSendDraft).toHaveBeenCalledTimes(1);

    await fireEvent.pointerDown(draftResizeHandle!);
    expect(props.onDraftResizeStart).toHaveBeenCalledTimes(1);

    await fireEvent.pointerDown(auxResizeHandle!);
    expect(props.onAuxResizeStart).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "파일 열기" }));
    expect(props.onOpenFile).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "에디터" }));
    expect(props.onOpenEditor).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByTestId(TEST_IDS.auxTerminalToggle));
    expect(props.onToggleAux).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByTestId(TEST_IDS.draftToggle));
    expect(props.onToggleDraft).toHaveBeenCalledTimes(1);
  });

  it("keeps assist actions visible when draft and aux panels are hidden", async () => {
    const props = createProps();
    props.draftOpen = false;
    props.auxInitialized = false;
    props.auxVisible = false;
    render(TerminalAssistStack, props);

    expect(screen.queryByTestId(TEST_IDS.draftTextarea)).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.auxTerminalShell)).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "파일 열기" }));
    expect(props.onOpenFile).toHaveBeenCalledTimes(1);
  });

  it("shows aux error body instead of loading overlay when spawn fails", () => {
    const props = createProps();
    props.auxSpawnError = "spawn failed";
    render(TerminalAssistStack, props);

    expect(screen.getByText(/spawn failed/)).toBeInTheDocument();
    expect(screen.queryByText("Connecting")).not.toBeInTheDocument();
  });

  it("hides aux loading overlay when loading is idle", () => {
    const props = createProps();
    props.auxLoadingState = null;
    render(TerminalAssistStack, props);

    expect(screen.queryByText("Connecting")).not.toBeInTheDocument();
  });
});
