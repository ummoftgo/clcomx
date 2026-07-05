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

  it("redacts credential-like values in message bubbles", async () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { findByTestId } = render(MessageList, { props: { store } });

    store.dispatch({
      type: "user_message",
      ref: codexRef({ itemId: "u-secret" }),
      content: [
        {
          type: "text",
          text: "use Bearer account-token-123 with AKIAIOSFODNN7EXAMPLE",
        },
      ],
      mode: "replace",
    });

    const bubble = await findByTestId(TEST_IDS.agentMessageBubble);
    expect(bubble.textContent).toContain("[REDACTED]");
    expect(bubble.textContent).not.toContain("account-token-123");
    expect(bubble.textContent).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("renders raw json message content without leaking credential-like values", async () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "claude" });
    const { findByTestId } = render(MessageList, { props: { store } });

    store.dispatch({
      type: "agent_message",
      ref: { provider: "claude", sessionId: "s1", turnId: "turn-1", messageId: "m-json" },
      content: [
        {
          type: "json",
          value: {
            type: "audio",
            mimeType: "audio/wav",
            authorization: "Bearer audio-secret",
          },
        },
      ],
      mode: "replace",
    });

    const bubble = await findByTestId(TEST_IDS.agentMessageBubble);
    expect(bubble.textContent).toContain("\"type\": \"audio\"");
    expect(bubble.textContent).toContain("[REDACTED]");
    expect(bubble.textContent).not.toContain("audio-secret");
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

  it("markdown: 완성된 agent 메시지는 서식(HTML)으로 렌더된다", async () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { findByTestId } = render(MessageList, { props: { store } });

    store.dispatch({
      type: "agent_message",
      ref: codexRef({ itemId: "md-final" }),
      content: [{ type: "text", text: "**bold** and `code`\n\n- one" }],
      mode: "replace",
    });
    await tick();

    const bubble = await findByTestId(TEST_IDS.agentMessageBubble);
    expect(bubble.querySelector("strong")?.textContent).toBe("bold");
    expect(bubble.querySelector("code")?.textContent).toBe("code");
    expect(bubble.querySelector("li")?.textContent).toBe("one");
    // raw 마커가 그대로 노출되지 않는다.
    expect(bubble.textContent).not.toContain("**bold**");
  });

  it("markdown: user 메시지는 평문을 유지한다", async () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { findByTestId } = render(MessageList, { props: { store } });

    store.dispatch({
      type: "user_message",
      ref: codexRef({ itemId: "u-md" }),
      content: [{ type: "text", text: "**not markdown**" }],
      mode: "replace",
    });
    await tick();

    const bubble = await findByTestId(TEST_IDS.agentMessageBubble);
    expect(bubble.querySelector("strong")).toBeNull();
    expect(bubble.textContent).toContain("**not markdown**");
  });

  it("markdown: 스트리밍 중에는 평문, 완성 후에만 파싱한다", async () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { findByTestId } = render(MessageList, { props: { store } });

    store.dispatch({
      type: "agent_message_delta",
      ref: codexRef({ itemId: "md-stream" }),
      delta: "**bo",
    });
    await tick();
    let bubble = await findByTestId(TEST_IDS.agentMessageBubble);
    // 스트리밍 중: 파싱하지 않고 raw 마커 그대로.
    expect(bubble.textContent).toContain("**bo");
    expect(bubble.querySelector("strong")).toBeNull();

    store.dispatch({
      type: "agent_message",
      ref: codexRef({ itemId: "md-stream" }),
      content: [{ type: "text", text: "**bold**" }],
      mode: "replace",
    });
    await tick();
    bubble = await findByTestId(TEST_IDS.agentMessageBubble);
    expect(bubble.querySelector("strong")?.textContent).toBe("bold");
  });

  it("markdown: redaction이 파싱보다 먼저 적용된다(서식 안 비밀도 마스킹)", async () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { findByTestId } = render(MessageList, { props: { store } });

    store.dispatch({
      type: "agent_message",
      ref: codexRef({ itemId: "md-secret" }),
      content: [{ type: "text", text: "use **Bearer account-token-123** now" }],
      mode: "replace",
    });
    await tick();

    const bubble = await findByTestId(TEST_IDS.agentMessageBubble);
    expect(bubble.textContent).toContain("[REDACTED]");
    expect(bubble.textContent).not.toContain("account-token-123");
  });

  it("renders thought channel messages as a collapsed reasoning block with an ARIA toggle", async () => {
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { findByTestId, queryByText, findByText } = render(MessageList, { props: { store } });

    store.dispatch({
      type: "agent_message_delta",
      ref: codexRef({ itemId: "thought-1" }),
      delta: "hidden reasoning",
      channel: "thought",
    });
    await tick();

    const toggle = await findByTestId(TEST_IDS.agentReasoningToggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(queryByText("hidden reasoning")).toBeNull();

    await fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await findByText("hidden reasoning")).toBeTruthy();
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

  it("wires tool location clicks to the transcript location handler", async () => {
    const onOpenLocation = vi.fn();
    const location = { path: "src/app.ts", line: 7, column: 2 };
    const store = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const { getByRole, getByTestId } = render(MessageList, {
      props: { store, onOpenLocation },
    });

    store.dispatch({
      type: "tool_call_updated",
      ref: codexRef({ toolCallId: "tc-location" }),
      update: {
        id: "tc-location",
        kind: "read",
        status: "completed",
        title: "read match",
        locations: [location],
      },
    });
    await tick();

    await fireEvent.click(getByTestId(TEST_IDS.agentToolCallToggle));
    await fireEvent.click(getByRole("button", { name: "src/app.ts:7:2" }));

    expect(onOpenLocation).toHaveBeenCalledWith(location);
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
