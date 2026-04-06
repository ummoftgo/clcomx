import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import TerminalEditorCloseConfirmModal from "./TerminalEditorCloseConfirmModal.svelte";

describe("TerminalEditorCloseConfirmModal", () => {
  beforeEach(() => {
    initializeI18n("ko", "ko-KR");
  });

  it("renders the dirty editor close copy and delegates both actions", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();

    render(TerminalEditorCloseConfirmModal, {
      open: true,
      title: "notes.md",
      onClose,
      onConfirm,
    });

    expect(screen.getByRole("heading", { name: "저장되지 않은 변경 사항" })).toBeInTheDocument();
    expect(
      screen.getByText('"notes.md"에 저장되지 않은 변경 사항이 있습니다. 닫으면 내용이 버려집니다.'),
    ).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "그대로 닫기" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
