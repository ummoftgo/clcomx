/**
 * MessageList 렌더 테스트(T5.2) — store 반응형 표면(visibleItemIds/itemVersions) 기반 점진 렌더 검증.
 *
 * transport→router→reducer→store→렌더 경로의 view 끝단을 store 직접 dispatch로 모사한다.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { initializeI18n } from "../../../i18n";
import { TEST_IDS } from "../../../testids";
import type { ProviderRef } from "../contracts/normalized";
import { createAgentRuntimeStore } from "../state/agent-runtime-store.svelte";
import MessageList from "./MessageList.svelte";

function codexRef(extra: Partial<ProviderRef> = {}): ProviderRef {
  return { provider: "codex", threadId: "t1", turnId: "u1", ...extra };
}

describe("MessageList", () => {
  beforeEach(() => {
    initializeI18n("en", "en-US");
  });

  it("renders an empty hint when no items exist", () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { getByTestId } = render(MessageList, { props: { store } });
    expect(getByTestId(TEST_IDS.agentMessageList)).toBeTruthy();
    expect(getByTestId(TEST_IDS.agentMessageList).textContent).toContain(
      "No messages yet",
    );
  });

  it("renders a user message bubble after dispatch", async () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { findAllByTestId } = render(MessageList, { props: { store } });

    store.dispatch({
      type: "user_message",
      ref: codexRef({ itemId: "u-msg" }),
      content: [{ type: "text", text: "hello agent" }],
      mode: "replace",
    });

    const bubbles = await findAllByTestId(TEST_IDS.agentMessageBubble);
    expect(bubbles.length).toBeGreaterThan(0);
    expect(bubbles.some((b) => b.textContent?.includes("hello agent"))).toBe(true);
  });

  it("progressively renders agent message deltas (itemVersions bump)", async () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { findByTestId } = render(MessageList, { props: { store } });

    store.dispatch({
      type: "agent_message_delta",
      ref: codexRef({ itemId: "a-msg" }),
      delta: "par",
    });
    await tick();
    let bubble = await findByTestId(TEST_IDS.agentMessageBubble);
    expect(bubble.textContent).toContain("par");

    store.dispatch({
      type: "agent_message_delta",
      ref: codexRef({ itemId: "a-msg" }),
      delta: "tial",
    });
    await tick();
    bubble = await findByTestId(TEST_IDS.agentMessageBubble);
    expect(bubble.textContent).toContain("partial");
  });

  it("renders a ToolCallCard for a tool_call item", async () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { findByTestId } = render(MessageList, { props: { store } });

    store.dispatch({
      type: "tool_call_updated",
      ref: codexRef({ toolCallId: "tc-1" }),
      update: {
        id: "tc-1",
        kind: "execute",
        status: "in_progress",
        title: "npm test",
        content: [{ type: "terminal", command: "npm test", output: "running" }],
      },
    });

    const card = await findByTestId(TEST_IDS.agentToolCallCard);
    expect(card.getAttribute("data-kind")).toBe("execute");
  });

  it("renders an inline approval inside the matching tool card and wires the response", async () => {
    const onRespondApproval = vi.fn();
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { findByTestId } = render(MessageList, {
      props: { store, onRespondApproval },
    });

    store.dispatch({
      type: "tool_call_updated",
      ref: codexRef({ toolCallId: "tc-1" }),
      update: { id: "tc-1", kind: "execute", status: "pending", title: "rm" },
    });
    store.dispatch({
      type: "approval_requested",
      ref: codexRef({ toolCallId: "tc-1", requestId: "req-1" }),
      request: {
        id: "req-1",
        title: "Run rm?",
        toolCallId: "tc-1",
        severity: "normal",
        options: [{ id: "opt-allow", label: "Allow", kind: "allow_once" }],
      },
    });

    const inline = await findByTestId(TEST_IDS.agentApprovalInlineCard);
    const allow = inline.querySelector<HTMLButtonElement>(
      '[data-option-id="opt-allow"]',
    )!;
    await fireEvent.click(allow);
    expect(onRespondApproval).toHaveBeenCalledWith({
      requestId: "req-1",
      outcome: "selected",
      optionId: "opt-allow",
    });
  });
});
