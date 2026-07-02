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

  it("translates agent runtime approval title and option label keys before display", () => {
    const { container, getByTestId } = render(ApprovalInlineCard, {
      props: {
        request: {
          id: "req-i18n",
          title: "agentRuntime.approval.command",
          severity: "normal",
          options: [
            { id: "allow_once", label: "agentRuntime.approval.allowOnce", kind: "allow_once" },
            { id: "reject_once", label: "agentRuntime.approval.rejectOnce", kind: "reject_once" },
          ],
        },
        onRespond: vi.fn(),
      },
    });

    const card = getByTestId(TEST_IDS.agentApprovalInlineCard);
    expect(card.getAttribute("aria-label")).toBe("Command approval");
    expect(container.textContent).toContain("Command approval");
    expect(container.textContent).toContain("Allow once");
    expect(container.textContent).toContain("Reject");
    expect(container.textContent).not.toContain("agentRuntime.approval.command");
    expect(container.textContent).not.toContain("agentRuntime.approval.allowOnce");
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

  it("redacts credential-like values in displayed approval text", () => {
    const { container, getByTestId } = render(ApprovalInlineCard, {
      props: {
        request: {
          id: "req-secret",
          title: "Run with Bearer account-token-123",
          body: "env ANTHROPIC_AUTH_TOKEN=anth-secret and AKIAIOSFODNN7EXAMPLE",
          severity: "normal",
          options: [
            { id: "opt-allow", label: "Allow sk-live-secret", kind: "allow_once" },
          ],
        },
        onRespond: vi.fn(),
      },
    });

    const card = getByTestId(TEST_IDS.agentApprovalInlineCard);
    expect(card.getAttribute("aria-label")).toContain("[REDACTED]");
    expect(container.textContent).toContain("[REDACTED]");
    expect(container.textContent).not.toContain("account-token-123");
    expect(container.textContent).not.toContain("anth-secret");
    expect(container.textContent).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(container.textContent).not.toContain("sk-live-secret");
  });

  it("renders provider option labels as text, not HTML", () => {
    const { container } = render(ApprovalInlineCard, {
      props: {
        request: {
          ...request(),
          options: [
            {
              id: "opt-html",
              label: '<img src=x onerror="window.__approvalXss=1">Allow',
              kind: "allow_once",
            },
          ],
        },
        onRespond: vi.fn(),
      },
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="window.__approvalXss=1">Allow');
  });
});
