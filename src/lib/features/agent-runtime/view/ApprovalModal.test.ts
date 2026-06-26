/**
 * ApprovalModal 테스트(T5.4) — escalation modal·option 렌더·선택/취소·Escape 회귀 보호(08 §4.4·§10.3).
 */

import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { TEST_IDS } from "../../../testids";
import type { ApprovalRequest } from "../contracts/normalized";
import ApprovalModal from "./ApprovalModal.svelte";

function escalationRequest(): ApprovalRequest {
  return {
    id: "req-esc",
    title: "Grant full access?",
    body: "Agent (Full Access)",
    severity: "escalation",
    options: [
      { id: "opt-grant", label: "Grant", kind: "allow_once" },
      { id: "opt-deny", label: "Deny", kind: "reject_once" },
    ],
  };
}

describe("ApprovalModal", () => {
  beforeEach(() => {
    initializeI18n("en", "en-US");
  });

  it("renders as a blocking alertdialog with provider options", () => {
    const { getByTestId, getAllByTestId } = render(ApprovalModal, {
      props: { request: escalationRequest(), onRespond: vi.fn() },
    });
    const modal = getByTestId(TEST_IDS.agentApprovalModal);
    expect(modal.getAttribute("aria-modal")).toBe("true");
    // 2 provider options + 1 built-in cancel button.
    expect(getAllByTestId(TEST_IDS.agentApprovalOption).length).toBe(2);
  });

  it("selects an option with the original optionId", async () => {
    const onRespond = vi.fn();
    const { container } = render(ApprovalModal, {
      props: { request: escalationRequest(), onRespond },
    });
    const grant = container.querySelector<HTMLButtonElement>(
      '[data-option-id="opt-grant"]',
    )!;
    await fireEvent.click(grant);
    expect(onRespond).toHaveBeenCalledWith({
      requestId: "req-esc",
      outcome: "selected",
      optionId: "opt-grant",
    });
  });

  it("Escape does not silently dismiss — responds with cancelled (escape regression guard)", async () => {
    const onRespond = vi.fn();
    render(ApprovalModal, {
      props: { request: escalationRequest(), onRespond },
    });
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({
      requestId: "req-esc",
      outcome: "cancelled",
    });
  });
});
