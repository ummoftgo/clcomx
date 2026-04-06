import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import TerminalInterruptConfirmModal from "./TerminalInterruptConfirmModal.svelte";

describe("TerminalInterruptConfirmModal", () => {
  beforeEach(() => {
    initializeI18n("ko", "ko-KR");
  });

  it("renders the confirm copy and delegates both actions", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();

    render(TerminalInterruptConfirmModal, {
      open: true,
      onClose,
      onConfirm,
    });

    expect(screen.getByRole("heading", { name: "Ctrl+C 보내기" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "선택한 텍스트가 없어서 복사 대신 현재 터미널에 Ctrl+C 인터럽트를 보냅니다. 계속하시겠습니까?",
      ),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Ctrl+C 보내기" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
