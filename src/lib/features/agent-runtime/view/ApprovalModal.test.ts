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

  it("translates agent runtime approval title and option label keys before display", () => {
    const { container, getByTestId } = render(ApprovalModal, {
      props: {
        request: {
          id: "req-i18n",
          title: "agentRuntime.approval.fileChange",
          severity: "escalation",
          options: [
            { id: "allow_once", label: "agentRuntime.approval.allowOnce", kind: "allow_once" },
            { id: "reject_once", label: "agentRuntime.approval.rejectOnce", kind: "reject_once" },
          ],
        },
        onRespond: vi.fn(),
      },
    });

    const modal = getByTestId(TEST_IDS.agentApprovalModal);
    expect(modal.getAttribute("aria-label")).toBe("File change approval");
    expect(container.textContent).toContain("File change approval");
    expect(container.textContent).toContain("Allow once");
    expect(container.textContent).toContain("Reject");
    expect(container.textContent).not.toContain("agentRuntime.approval.fileChange");
    expect(container.textContent).not.toContain("agentRuntime.approval.allowOnce");
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

  it("shows remembered-session hints for always options", () => {
    const { container } = render(ApprovalModal, {
      props: {
        request: {
          id: "req-always",
          title: "Grant full access?",
          severity: "escalation",
          options: [
            { id: "opt-always", label: "Always allow", kind: "allow_always" },
            { id: "opt-reject-always", label: "Always reject", kind: "reject_always" },
          ],
        },
        onRespond: vi.fn(),
      },
    });

    expect(container.textContent).toContain("Always allow");
    expect(container.textContent).toContain("Always reject");
    expect((container.textContent ?? "").match(/Remembered for this session/g) ?? []).toHaveLength(2);
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

  it("traps Tab focus inside the modal actions", async () => {
    const { container } = render(ApprovalModal, {
      props: { request: escalationRequest(), onRespond: vi.fn() },
    });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    last.focus();
    await fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    await fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("redacts credential-like values in displayed escalation approval text", () => {
    const { container, getByTestId } = render(ApprovalModal, {
      props: {
        request: {
          id: "req-secret",
          title: "Grant Bearer account-token-123?",
          body: "AWS_BEARER_TOKEN_BEDROCK=aws-secret AKIAIOSFODNN7EXAMPLE",
          severity: "escalation",
          options: [
            { id: "opt-grant", label: "Grant ghp_secretToken", kind: "allow_once" },
          ],
        },
        onRespond: vi.fn(),
      },
    });

    const modal = getByTestId(TEST_IDS.agentApprovalModal);
    expect(modal.getAttribute("aria-label")).toContain("[REDACTED]");
    expect(container.textContent).toContain("[REDACTED]");
    expect(container.textContent).not.toContain("account-token-123");
    expect(container.textContent).not.toContain("aws-secret");
    expect(container.textContent).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(container.textContent).not.toContain("ghp_secretToken");
  });

  it("renders provider option labels as text, not HTML", () => {
    const { container } = render(ApprovalModal, {
      props: {
        request: {
          ...escalationRequest(),
          options: [
            {
              id: "opt-html",
              label: '<img src=x onerror="window.__approvalXss=1">Grant',
              kind: "allow_once",
            },
          ],
        },
        onRespond: vi.fn(),
      },
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="window.__approvalXss=1">Grant');
  });
});
