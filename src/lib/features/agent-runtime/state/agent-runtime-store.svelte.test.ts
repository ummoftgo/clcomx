/**
 * agent-runtime-store 통합 테스트 — reducer + status + pending table + audit 조합(11 §2.4·§2.7).
 * 상태 전이, approval lifecycle, audit(NM-20b/20c), shallow 반응형 표면(NM-31b).
 */
import { describe, expect, it } from "vitest";
import type { ApprovalRequest, ProviderRef } from "../contracts/normalized";
import type { TranscriptModel } from "../contracts/transcript";
import { DEFAULT_TRANSCRIPT_RESIDENCY_CONFIG } from "../contracts/transcript";
import { turnKeyOf } from "../controller/agent-event-reducer";
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

describe("agent-runtime-store — composer slash commands", () => {
  it("replaces availableCommands from available_commands_updated events", () => {
    const s = createAgentRuntimeStore({ sessionHandle: "A", provider: "claude" });
    const ref: ProviderRef = { provider: "claude", sessionId: "sess-1" };

    s.dispatch({
      type: "available_commands_updated",
      ref,
      commands: [
        { name: "compact", description: "Compact context", inputHint: "<turns>" },
        { name: "plan" },
      ],
    });
    expect(s.availableCommands).toEqual([
      { name: "compact", description: "Compact context", inputHint: "<turns>" },
      { name: "plan" },
    ]);

    s.dispatch({
      type: "available_commands_updated",
      ref,
      commands: [{ name: "resume" }],
    });
    expect(s.availableCommands).toEqual([{ name: "resume" }]);
  });

  it("clears stale availableCommands on session start/load/process exit (§3.8)", () => {
    const s = createAgentRuntimeStore({ sessionHandle: "A", provider: "claude" });
    const ref: ProviderRef = { provider: "claude", sessionId: "sess-1" };
    const seed = () =>
      s.dispatch({
        type: "available_commands_updated",
        ref,
        commands: [{ name: "compact" }, { name: "plan" }],
      });

    // process_exited는 죽은 프로세스의 stale 목록을 비운다.
    seed();
    expect(s.availableCommands).toHaveLength(2);
    s.dispatch({ type: "process_exited", ref, code: 0 });
    expect(s.availableCommands).toEqual([]);

    // session_loaded(resume) 전이가 이전 세션 목록을 비운다.
    seed();
    s.dispatch({ type: "session_loaded", ref });
    expect(s.availableCommands).toEqual([]);

    // session_started 전이가 이전 세션 목록을 비운다.
    seed();
    s.dispatch({ type: "session_started", ref, cwd: "/w" });
    expect(s.availableCommands).toEqual([]);
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

  it("adapter cleanup approval_resolved records decidedBy=cleanup", () => {
    const s = store();
    s.dispatch({ type: "approval_requested", ref: codexRef({ requestId: "7" }), request: approval("7") });
    s.dispatch({
      type: "approval_resolved",
      ref: codexRef({ requestId: "7" }),
      decision: { requestId: "7", outcome: "cancelled" },
      decidedBy: "cleanup",
    });

    const [entry] = s.getAuditEntries();
    expect(entry).toMatchObject({ requestId: "7", outcome: "cancelled", decidedBy: "cleanup" });
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
      residencyConfig: {
        HOT_WINDOW_SEALED_TURNS: 2,
        HOT_WINDOW_BYTES: Number.POSITIVE_INFINITY,
        TOMBSTONE_LRU: 5,
        SEAL_QUIESCENCE_GRACE_MS: 0,
      },
    });
    for (let i = 0; i < 8; i++) {
      const ref = codexRef({ turnId: `t${i}`, itemId: `t${i}-i` });
      s.dispatch({ type: "agent_message", ref, content: [{ type: "text", text: "x" }], mode: "replace" });
      s.dispatch({ type: "turn_completed", ref, status: "completed" });
      s.flushSealAndEvict();
    }
    expect(s.getTranscript().itemsById.size).toBeLessThanOrEqual(2);
  });

  it("OQ-52: default cap keeps a 1000-turn synthetic session bounded", () => {
    const s = store();
    const hotWindow = DEFAULT_TRANSCRIPT_RESIDENCY_CONFIG.HOT_WINDOW_SEALED_TURNS;
    const tombstoneLru = DEFAULT_TRANSCRIPT_RESIDENCY_CONFIG.TOMBSTONE_LRU;

    for (let i = 0; i < 1000; i++) {
      const ref = codexRef({ turnId: `t${i}`, itemId: `t${i}-i` });
      s.dispatch({ type: "agent_message", ref, content: [{ type: "text", text: `turn-${i}` }], mode: "replace" });
      s.dispatch({ type: "turn_completed", ref, status: "completed" });
      s.flushSealAndEvict();
    }

    const transcript = s.getTranscript();
    expect(s.visibleItemIds).toHaveLength(hotWindow);
    expect(Object.keys(s.itemVersions)).toHaveLength(hotWindow);
    expect(transcript.itemsById.size).toBe(hotWindow);
    expect(transcript.turnsById.size).toBeLessThanOrEqual(hotWindow + tombstoneLru);
    expect(transcript.tombstones.lru).toHaveLength(tombstoneLru);

    const oldestKey = turnKeyOf(codexRef({ turnId: "t0" }));
    const tombstoneKey = turnKeyOf(codexRef({ turnId: "t949" }));
    const retainedKey = turnKeyOf(codexRef({ turnId: "t999" }));
    expect(transcript.turnsById.has(oldestKey)).toBe(false);
    expect(transcript.turnsById.get(tombstoneKey)?.residency).toBe("evicted-tombstone");
    expect(transcript.turnsById.get(retainedKey)?.residency).toBe("sealed-retained");

    const beforeDropCount = transcript.tombstones.droppedLateEventCount;
    s.dispatch({
      type: "agent_message_delta",
      ref: codexRef({ turnId: "t949", itemId: "t949-i" }),
      delta: "late",
    });
    expect(s.getTranscript().tombstones.droppedLateEventCount).toBe(beforeDropCount + 1);
    expect(s.getTranscript().itemsById.has("t949-i")).toBe(false);

    const beforeResealCount = s.getTranscript().turnsById.get(retainedKey)?.resealCount ?? 0;
    s.dispatch({
      type: "agent_message_delta",
      ref: codexRef({ turnId: "t999", itemId: "t999-i" }),
      delta: "+late",
    });
    expect(s.getTranscript().turnsById.get(retainedKey)?.residency).toBe("unsealed");
    expect(s.getTranscript().turnsById.get(retainedKey)?.resealCount).toBe(beforeResealCount + 1);

    s.flushSealAndEvict();
    expect(s.getTranscript().turnsById.get(retainedKey)?.residency).toBe("sealed-retained");
    expect(s.visibleItemIds).toHaveLength(hotWindow);
    expect(Object.keys(s.itemVersions)).toHaveLength(hotWindow);
  });
});

describe("agent-runtime-store — hydrateReadOnly(OQ-16 cold restart cache hydrate)", () => {
  it("injects a transcript model as display-only state without dispatching an event", () => {
    const s = store();
    const cachedItem = {
      type: "message" as const,
      id: "cached-1",
      role: "agent" as const,
      content: [{ type: "text" as const, text: "cached history" }],
      streaming: false,
      ref: codexRef({ itemId: "cached-1" }),
    };
    const model: TranscriptModel = {
      visibleItemIds: ["cached-1"],
      itemVersions: {},
      itemsById: new Map([["cached-1", cachedItem]]),
      turnsById: new Map(),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };

    s.hydrateReadOnly(model);

    // 반응형 표면(visibleItemIds/itemVersions)이 syncReactiveSurface로 갱신된다.
    expect(s.visibleItemIds).toEqual(["cached-1"]);
    expect(s.getItem("cached-1")).toEqual(cachedItem);
    expect(s.getTranscript()).toBe(model);
    // dispatch가 아니므로 status/pending 등은 영향받지 않는다(기본값 유지).
    expect(s.status).toBe("starting");
    expect(s.pendingApprovals).toEqual([]);
  });

  it("marks isReadOnlyHydrated after a read-only hydrate(Task 10 dedup/affordance gate)", () => {
    const s = store();
    expect(s.isReadOnlyHydrated).toBe(false);

    const model: TranscriptModel = {
      visibleItemIds: ["cached-1"],
      itemVersions: {},
      itemsById: new Map([
        [
          "cached-1",
          {
            type: "message" as const,
            id: "cached-1",
            role: "agent" as const,
            content: [{ type: "text" as const, text: "cached history" }],
            streaming: false,
            ref: codexRef({ itemId: "cached-1" }),
          },
        ],
      ]),
      turnsById: new Map(),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };
    s.hydrateReadOnly(model);

    expect(s.isReadOnlyHydrated).toBe(true);
  });

  it("discardReadOnlyHydration empties the transcript and clears the hydrated flag(Task 10 resume dedup)", () => {
    const s = store();
    const model: TranscriptModel = {
      visibleItemIds: ["cached-1"],
      itemVersions: {},
      itemsById: new Map([
        [
          "cached-1",
          {
            type: "message" as const,
            id: "cached-1",
            role: "agent" as const,
            content: [{ type: "text" as const, text: "cached history" }],
            streaming: false,
            ref: codexRef({ itemId: "cached-1" }),
          },
        ],
      ]),
      turnsById: new Map(),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };
    s.hydrateReadOnly(model);
    expect(s.isReadOnlyHydrated).toBe(true);

    s.discardReadOnlyHydration();

    // 권위 replay가 처음부터 재구성할 수 있도록 캐시 body를 빈 모델로 비운다.
    expect(s.visibleItemIds).toEqual([]);
    expect(s.getItem("cached-1")).toBeUndefined();
    expect(s.getTranscript().itemsById.size).toBe(0);
    expect(s.isReadOnlyHydrated).toBe(false);
  });

  it("dispose는 transcript와 함께 hydrated 플래그도 비운다(빈 transcript 위 stale-true 방지)", () => {
    const s = store();
    const model: TranscriptModel = {
      visibleItemIds: ["cached-1"],
      itemVersions: {},
      itemsById: new Map([
        [
          "cached-1",
          {
            type: "message" as const,
            id: "cached-1",
            role: "agent" as const,
            content: [{ type: "text" as const, text: "cached history" }],
            streaming: false,
            ref: codexRef({ itemId: "cached-1" }),
          },
        ],
      ]),
      turnsById: new Map(),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };
    s.hydrateReadOnly(model);
    expect(s.isReadOnlyHydrated).toBe(true);

    s.dispose();

    expect(s.getTranscript().itemsById.size).toBe(0);
    expect(s.isReadOnlyHydrated).toBe(false);
  });
});
