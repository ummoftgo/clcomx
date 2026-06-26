/**
 * ApprovalInlineCard 테스트(T5.4) — option 원본 보존 렌더·선택 응답·멱등 잠금(08 §4.4, 09 §2).
 */

import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { TEST_IDS } from "../../../testids";
import type { ApprovalRequest } from "../contracts/normalized";
import ApprovalInlineCard from "./ApprovalInlineCard.svelte";

function request(): ApprovalRequest {
  return {
    id: "req-1",
    title: "Run this command?",
    body: "rm -rf build/",
    toolCallId: "tc-1",
    severity: "normal",
    options: [
      { id: "opt-allow", label: "Allow once", kind: "allow_once" },
      { id: "opt-always", label: "Always allow", kind: "allow_always" },
      { id: "opt-reject", label: "Reject", kind: "reject_once" },
    ],
  };
}

describe("ApprovalInlineCard", () => {
  beforeEach(() => {
    initializeI18n("en", "en-US");
  });

  it("renders all provider options in original order/count", () => {
    const { getAllByTestId } = render(ApprovalInlineCard, {
      props: { request: request(), onRespond: vi.fn() },
    });
    const options = getAllByTestId(TEST_IDS.agentApprovalOption);
    expect(options.length).toBe(3);
    expect(options[0].getAttribute("data-option-id")).toBe("opt-allow");
    expect(options[1].getAttribute("data-option-id")).toBe("opt-always");
    expect(options[2].getAttribute("data-option-id")).toBe("opt-reject");
  });

  it("responds with selected outcome carrying the original optionId", async () => {
    const onRespond = vi.fn();
    const { container } = render(ApprovalInlineCard, {
      props: { request: request(), onRespond },
    });
    const allow = container.querySelector<HTMLButtonElement>(
      '[data-option-id="opt-allow"]',
    )!;
    await fireEvent.click(allow);
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({
      requestId: "req-1",
      outcome: "selected",
      optionId: "opt-allow",
    });
  });

  it("locks after first response (idempotent — no double submit)", async () => {
    const onRespond = vi.fn();
    const { container } = render(ApprovalInlineCard, {
      props: { request: request(), onRespond },
    });
    const allow = container.querySelector<HTMLButtonElement>(
      '[data-option-id="opt-allow"]',
    )!;
    const reject = container.querySelector<HTMLButtonElement>(
      '[data-option-id="opt-reject"]',
    )!;
    await fireEvent.click(allow);
    await fireEvent.click(reject);
    expect(onRespond).toHaveBeenCalledTimes(1);
  });
});
