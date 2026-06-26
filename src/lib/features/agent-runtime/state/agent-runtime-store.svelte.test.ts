/**
 * agent-runtime-store 통합 테스트 — reducer + status + pending table + audit 조합(11 §2.4·§2.7).
 * 상태 전이, approval lifecycle, audit(NM-20b/20c), shallow 반응형 표면(NM-31b).
 */
import { describe, expect, it } from "vitest";
import type { ApprovalRequest, ProviderRef } from "../contracts/normalized";
import { createAgentRuntimeStore } from "./agent-runtime-store.svelte";

const codexRef = (over: Partial<ProviderRef> = {}): ProviderRef => ({
  provider: "codex",
  threadId: "A",
  turnId: "t1",
  ...over,
});

function approval(id: string, severity?: "normal" | "escalation"): ApprovalRequest {
  return {
    id,
    title: "Run",
    toolCallId: "c1",
    options: [
      { id: "ok", label: "Allow", kind: "allow_once" },
      { id: "no", label: "Reject", kind: "reject_once" },
    ],
    severity,
  };
}

function store() {
  return createAgentRuntimeStore({ sessionHandle: "A", provider: "codex" });
}

describe("agent-runtime-store — status transitions (NM-23..NM-28)", () => {
  it("NM-23: session_started -> ready", () => {
    const s = store();
    s.dispatch({ type: "session_started", ref: codexRef(), cwd: "/w" });
    expect(s.status).toBe("ready");
  });

  it("NM-24: message during turn -> running", () => {
    const s = store();
    s.dispatch({ type: "session_started", ref: codexRef(), cwd: "/w" });
    s.dispatch({ type: "agent_message_delta", ref: codexRef({ itemId: "i1" }), delta: "x" });
    expect(s.status).toBe("running");
  });

  it("NM-25: approval_requested -> requires_action", () => {
    const s = store();
    s.dispatch({ type: "session_started", ref: codexRef(), cwd: "/w" });
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "7" }), request: approval("7") });
    expect(s.status).toBe("requires_action");
  });

  it("NM-26: turn_completed{failed} keeps session idle (not failed)", () => {
    const s = store();
    s.dispatch({ type: "session_started", ref: codexRef(), cwd: "/w" });
    s.dispatch({ type: "turn_completed", ref: codexRef(), status: "failed" });
    expect(s.status).toBe("idle");
  });

  it("NM-27: error{recoverable:false} -> failed", () => {
    const s = store();
    s.dispatch({ type: "session_started", ref: codexRef(), cwd: "/w" });
    s.dispatch({ type: "error", ref: codexRef(), message: "fatal", recoverable: false });
    expect(s.status).toBe("failed");
  });

  it("NM-28: process_exited -> exited", () => {
    const s = store();
    s.dispatch({ type: "session_started", ref: codexRef(), cwd: "/w" });
    s.dispatch({ type: "process_exited", ref: codexRef({ sessionId: "A" }), code: 0 });
    expect(s.status).toBe("exited");
  });
});

describe("agent-runtime-store — approval lifecycle + derivation (NM-12/13)", () => {
  it("requested registers + requires_action; resolved returns to running", () => {
    const s = store();
    s.dispatch({ type: "session_started", ref: codexRef(), cwd: "/w" });
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "7" }), request: approval("7") });
    expect(s.pendingApprovals.map((a) => a.id)).toEqual(["7"]);
    expect(s.status).toBe("requires_action");
    s.respondApproval({ requestId: "7", outcome: "selected", optionId: "ok" });
    expect(s.pendingApprovals).toHaveLength(0);
    expect(s.status).toBe("running");
  });

  it("escalation severity routed to escalationApproval (not inline)", () => {
    const s = store();
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "9" }), request: approval("9", "escalation") });
    expect(s.escalationApproval?.id).toBe("9");
    expect(s.pendingApprovals).toHaveLength(0);
  });
});

describe("agent-runtime-store — audit (NM-20b/NM-20c)", () => {
  it("NM-20b: each decision yields exactly one audit entry with decidedBy", () => {
    const s = store();
    // user 결정
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "7" }), request: approval("7") });
    s.respondApproval({ requestId: "7", outcome: "selected", optionId: "ok" }, "user");
    // auto 결정
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "8" }), request: approval("8") });
    s.respondApproval({ requestId: "8", outcome: "selected", optionId: "ok" }, "auto");
    // cleanup 결정(cancel)
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "9" }), request: approval("9") });
    s.cancelTurn("A:t1");

    const entries = s.getAuditEntries();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.decidedBy).sort()).toEqual(["auto", "cleanup", "user"]);
    // 중복 없음: 같은 requestId 1건씩
    expect(new Set(entries.map((e) => e.requestId)).size).toBe(3);
  });

  it("NM-20b: cleanup of multiple pending yields 1:1 entries", () => {
    const s = store();
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "1" }), request: approval("1") });
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "2" }), request: approval("2") });
    s.closePendingOnExit();
    const entries = s.getAuditEntries();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.decidedBy === "cleanup" && e.outcome === "failed")).toBe(true);
  });

  it("NM-20c: audit entry contains no secrets (only metadata)", () => {
    const s = store();
    const secretReq: ApprovalRequest = {
      id: "7",
      title: "rm -rf /secret/path --credential=ABC",
      body: "file contents: TOP SECRET",
      toolCallId: "c1",
      options: [{ id: "ok", label: "Allow rm -rf /secret", kind: "allow_once" }],
    };
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "7" }), request: secretReq });
    s.respondApproval({ requestId: "7", outcome: "selected", optionId: "ok" });
    const entry = s.getAuditEntries()[0];
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("TOP SECRET");
    expect(serialized).not.toContain("Allow rm");
    // 메타는 존재
    expect(entry.requestId).toBe("7");
    expect(entry.optionId).toBe("ok");
    expect(entry.optionKind).toBe("allow_once");
    expect(entry.toolCallId).toBe("c1");
  });

  it("NM-18c idempotent close emits one audit entry only", () => {
    const s = store();
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "7" }), request: approval("7") });
    s.closePendingOnShutdown();
    s.closePendingOnExit(); // 늦은 exit — 멱등
    expect(s.getAuditEntries()).toHaveLength(1);
  });
});

describe("agent-runtime-store — shallow reactive surface bounded (NM-31b)", () => {
  it("reactive surface tracks visible items + versions; body in plain Map", () => {
    const s = store();
    for (let i = 0; i < 10; i++) {
      s.dispatch({ type: "agent_message_delta", ref: codexRef({ itemId: `i${i}` }), delta: "x" });
    }
    expect(s.visibleItemIds).toHaveLength(10);
    expect(Object.keys(s.itemVersions)).toHaveLength(10);
    // body는 plain Map(getTranscript로 접근)
    expect(s.getTranscript().itemsById.size).toBe(10);
    // streaming은 itemVersions bump으로 표현 — 같은 item 추가 delta는 visible 불변
    s.dispatch({ type: "agent_message_delta", ref: codexRef({ itemId: "i0" }), delta: "y" });
    expect(s.visibleItemIds).toHaveLength(10);
    expect(s.itemVersions["i0"]).toBeGreaterThan(1);
  });

  it("flushSealAndEvict bounds itemsById in long sessions", () => {
    const s = createAgentRuntimeStore({
      sessionHandle: "A",
      provider: "codex",
      residencyConfig: { HOT_WINDOW_SEALED_TURNS: 2, TOMBSTONE_LRU: 5, SEAL_QUIESCENCE_GRACE_MS: 0 },
    });
    for (let i = 0; i < 8; i++) {
      const ref = codexRef({ turnId: `t${i}`, itemId: `t${i}-i` });
      s.dispatch({ type: "agent_message", ref, content: [{ type: "text", text: "x" }], mode: "replace" });
      s.dispatch({ type: "turn_completed", ref, status: "completed" });
      s.flushSealAndEvict();
    }
    expect(s.getTranscript().itemsById.size).toBeLessThanOrEqual(2);
  });
});
