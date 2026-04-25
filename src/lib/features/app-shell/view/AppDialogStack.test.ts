import { fireEvent, render, screen, within } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { TEST_IDS } from "../../../testids";
import AppDialogStack from "./AppDialogStack.svelte";

type AppDialogStackProps = ComponentProps<typeof AppDialogStack>;

function createProps(overrides: Partial<AppDialogStackProps> = {}): AppDialogStackProps {
  return {
    showDirtyTabDialog: false,
    showCloseTabDialog: false,
    showDirtyAppDialog: false,
    showDirtyWindowCloseDialog: false,
    showCloseWindowDialog: false,
    hasPendingCloseSession: false,
    pendingCloseSessionTitle: "Demo",
    dirtyAppCloseCount: 0,
    dirtyWindowCloseCount: 0,
    renameDialogKind: null,
    renameDialogValue: "",
    useKoreanDirtyCopy: false,
    onDismissDirtyTab: vi.fn(),
    onContinueDirtyTabClose: vi.fn(),
    onDismissCloseTab: vi.fn(),
    onConfirmCloseTab: vi.fn(),
    onDismissDirtyApp: vi.fn(),
    onConfirmDirtyAppClose: vi.fn(),
    onDismissDirtyWindowClose: vi.fn(),
    onConfirmDirtyWindowClose: vi.fn(),
    onDismissCloseWindow: vi.fn(),
    onMoveWindowToMain: vi.fn(),
    onCloseWindowSessions: vi.fn(),
    onDismissRename: vi.fn(),
    onConfirmRename: vi.fn(),
    ...overrides,
  };
}

describe("AppDialogStack", () => {
  beforeEach(() => {
    initializeI18n("en", "en-US");
  });

  it("renders dirty tab copy only when a pending session exists", async () => {
    const props = createProps({
      showDirtyTabDialog: true,
      hasPendingCloseSession: true,
      pendingCloseSessionTitle: "Draft Tab",
      useKoreanDirtyCopy: true,
    });
    render(AppDialogStack, props);

    const dialog = screen.getByTestId(TEST_IDS.closeTabDialog);
    expect(dialog).toHaveTextContent("저장되지 않은 변경 사항");
    expect(dialog).toHaveTextContent("\"Draft Tab\"에 저장되지 않은 편집 내용이 있습니다.");

    await fireEvent.click(within(dialog).getByRole("button", { name: "그대로 닫기" }));
    expect(props.onContinueDirtyTabClose).toHaveBeenCalledTimes(1);

    await fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(props.onDismissDirtyTab).toHaveBeenCalledTimes(1);
  });

  it("keeps pending tab dialogs hidden without a pending session", () => {
    render(AppDialogStack, createProps({
      showDirtyTabDialog: true,
      showCloseTabDialog: true,
      hasPendingCloseSession: false,
    }));

    expect(screen.queryByTestId(TEST_IDS.closeTabDialog)).toBeNull();
  });

  it("routes the clean tab close confirmation", async () => {
    const props = createProps({
      showCloseTabDialog: true,
      hasPendingCloseSession: true,
      pendingCloseSessionTitle: "Running Agent",
    });
    render(AppDialogStack, props);

    const dialog = screen.getByTestId(TEST_IDS.closeTabDialog);
    expect(dialog).toHaveTextContent("Running Agent");

    await fireEvent.click(within(dialog).getByRole("button", { name: "Close Tab" }));
    expect(props.onConfirmCloseTab).toHaveBeenCalledTimes(1);

    await fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(props.onDismissCloseTab).toHaveBeenCalledTimes(1);
  });

  it("prioritizes dirty window confirmation over the regular close-window dialog", async () => {
    const props = createProps({
      showCloseWindowDialog: true,
      showDirtyWindowCloseDialog: true,
      dirtyWindowCloseCount: 2,
    });
    render(AppDialogStack, props);

    const dialog = screen.getByTestId(TEST_IDS.closeWindowDialog);
    expect(dialog).toHaveTextContent("This window has 2 sessions with unsaved editor changes.");
    expect(screen.queryByRole("button", { name: "Move Tabs To Main" })).toBeNull();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Close Anyway" }));
    expect(props.onConfirmDirtyWindowClose).toHaveBeenCalledTimes(1);
  });

  it("routes regular close-window actions", async () => {
    const props = createProps({ showCloseWindowDialog: true });
    render(AppDialogStack, props);

    const dialog = screen.getByTestId(TEST_IDS.closeWindowDialog);
    await fireEvent.click(within(dialog).getByRole("button", { name: "Move Tabs To Main" }));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Close Tabs" }));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(props.onMoveWindowToMain).toHaveBeenCalledTimes(1);
    expect(props.onCloseWindowSessions).toHaveBeenCalledTimes(1);
    expect(props.onDismissCloseWindow).toHaveBeenCalledTimes(1);
  });

  it("renders rename copy and confirms from Enter", async () => {
    const props = createProps({
      renameDialogKind: "window",
      renameDialogValue: "main",
    });
    render(AppDialogStack, props);

    const input = document.getElementById("rename-input") as HTMLInputElement | null;
    expect(screen.getByRole("heading", { name: "Rename Window" })).toBeInTheDocument();
    expect(input).not.toBeNull();
    expect(input?.value).toBe("main");

    await fireEvent.input(input!, { target: { value: "workspace-2" } });
    await fireEvent.keyDown(input!, { key: "Enter" });
    expect(props.onConfirmRename).toHaveBeenCalledTimes(1);
  });
});
