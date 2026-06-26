/**
 * agent-event-router 단위 테스트 — OQ-48 (11 §2: window-close 격리, cross-window dispatch 금지,
 * (sessionHandle, requestId) 키 충돌 회귀의 라우팅 측면).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRef } from "../contracts/normalized";
import { createAgentRuntimeStore } from "../state/agent-runtime-store.svelte";
import {
  bindRuntimeId,
  dispatchEvent,
  disposeWindow,
  getSessionStore,
  registerSession,
  resetRegistry,
  sessionHandleForRuntime,
} from "./agent-event-router";

const codexRef = (over: Partial<ProviderRef> = {}): ProviderRef => ({
  provider: "codex",
  threadId: "A",
  turnId: "t1",
  ...over,
});

afterEach(() => resetRegistry());

describe("agent-event-router — registration + dispatch", () => {
  it("dispatches to the owning session store", () => {
    const s = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    registerSession("A", s, "main");
    const ok = dispatchEvent("A", { type: "agent_message_delta", ref: codexRef({ itemId: "i1" }), delta: "x" });
    expect(ok).toBe(true);
    expect(s.visibleItemIds).toEqual(["i1"]);
  });

  it("dispatch to unregistered session is ignored (no crash)", () => {
    expect(dispatchEvent("ghost", { type: "agent_message_delta", ref: codexRef({ itemId: "i1" }), delta: "x" })).toBe(false);
  });

  it("runtimeId binding resolves sessionHandle", () => {
    const s = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    registerSession("A", s, "main");
    bindRuntimeId("A", "rt-1");
    expect(sessionHandleForRuntime("rt-1")).toBe("A");
  });
});

describe("agent-event-router — window-close isolation (OQ-48)", () => {
  it("disposeWindow cleans only that window's entries; cross-window untouched", () => {
    const sA = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const sB = createAgentRuntimeStore({ sessionHandle: "B", provider: "claude" });
    registerSession("A", sA, "win-1", "rt-A");
    registerSession("B", sB, "win-2", "rt-B");

    const disposed = disposeWindow("win-1");
    expect(disposed).toEqual(["A"]);
    expect(getSessionStore("A")).toBeUndefined();
    expect(getSessionStore("B")).toBe(sB); // 다른 window 소유는 유지
    expect(sessionHandleForRuntime("rt-A")).toBeUndefined();
    expect(sessionHandleForRuntime("rt-B")).toBe("B");
  });

  it("no cross-window dispatch: events for B never reach A's store", () => {
    const sA = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    registerSession("A", sA, "win-1");
    // B는 등록 안 됨(다른 window) → dispatch 거부
    expect(dispatchEvent("B", { type: "agent_message_delta", ref: codexRef({ itemId: "i1" }), delta: "x" })).toBe(false);
    expect(sA.visibleItemIds).toHaveLength(0);
  });
});

describe("agent-event-router — same JSON-RPC id across two runtimes (NM-15b routing)", () => {
  it("approval id 7 in A and B routes independently", () => {
    const sA = createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
    const sB = createAgentRuntimeStore({ sessionHandle: "B", provider: "claude" });
    registerSession("A", sA, "main");
    registerSession("B", sB, "main");
    const req = (id: string) => ({ id, title: "x", options: [{ id: "ok", label: "Allow", kind: "allow_once" as const }] });
    dispatchEvent("A", { type: "approval_requested", ref: codexRef({ requestId: "7" }), request: req("7") });
    dispatchEvent("B", { type: "approval_requested", ref: { provider: "claude", sessionId: "B", requestId: "7" }, request: req("7") });
    expect(sA.pendingApprovals.map((a) => a.id)).toEqual(["7"]);
    expect(sB.pendingApprovals.map((a) => a.id)).toEqual(["7"]);
    // A resolve가 B를 건드리지 않음
    sA.respondApproval({ requestId: "7", outcome: "selected", optionId: "ok" });
    expect(sA.pendingApprovals).toHaveLength(0);
    expect(sB.pendingApprovals.map((a) => a.id)).toEqual(["7"]);
  });
});
