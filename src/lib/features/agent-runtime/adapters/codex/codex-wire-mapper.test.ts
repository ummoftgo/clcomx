/**
 * Codex wire mapper 단위 테스트(11 §3 CX-1..CX-20 일부 + 05 §10).
 * 순수 함수(mapCodexNotification/mapCodexServerRequest/mapAgentContentToUserInput) 단독 검증.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { CodexRouting } from "./codex-routing";
import {
  mapCodexNotification,
  mapCodexServerRequest,
  mapAgentContentToUserInput,
  makeTextUserInput,
  codexApprovalSeverity,
  getUnknownNotificationCount,
  getUnknownNotificationRawPayloads,
  resetUnknownNotificationCount,
} from "./codex-wire-mapper";

beforeEach(() => resetUnknownNotificationCount());

describe("thread/turn lifecycle (CX-1/CX-3/CX-4)", () => {
  it("CX-1: thread/started → session_started{threadId,sessionId,cwd}", () => {
    const r = new CodexRouting();
    const events = mapCodexNotification(
      "thread/started",
      { thread: { id: "th_1", sessionId: "s1", cwd: "/work" } },
      r,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session_started",
      ref: { provider: "codex", threadId: "th_1" },
      cwd: "/work",
    });
  });

  it("CX-1: thread/started 중복 시 멱등(1회만 emit)", () => {
    const r = new CodexRouting();
    const p = { thread: { id: "th_1", sessionId: "s1", cwd: "/work" } };
    expect(mapCodexNotification("thread/started", p, r)).toHaveLength(1);
    expect(mapCodexNotification("thread/started", p, r)).toHaveLength(0);
  });

  it("CX-3: thread/status/changed active+waitingOnApproval → requires_action", () => {
    const r = new CodexRouting();
    const events = mapCodexNotification(
      "thread/status/changed",
      { threadId: "th_1", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
      r,
    );
    expect(events[0]).toMatchObject({ type: "session_status_changed", status: "requires_action" });
  });

  it("CX-4: thread/status/changed systemError → failed", () => {
    const r = new CodexRouting();
    const events = mapCodexNotification(
      "thread/status/changed",
      { threadId: "th_1", status: { type: "systemError" } },
      r,
    );
    expect(events[0]).toMatchObject({ type: "session_status_changed", status: "failed" });
  });

  it("active(no flags) → running, idle → idle, notLoaded → starting (enum 전 분기)", () => {
    const r = new CodexRouting();
    expect(
      mapCodexNotification("thread/status/changed", { threadId: "t", status: { type: "active", activeFlags: [] } }, r)[0],
    ).toMatchObject({ status: "running" });
    expect(
      mapCodexNotification("thread/status/changed", { threadId: "t", status: { type: "idle" } }, r)[0],
    ).toMatchObject({ status: "idle" });
    expect(
      mapCodexNotification("thread/status/changed", { threadId: "t", status: { type: "notLoaded" } }, r)[0],
    ).toMatchObject({ status: "starting" });
  });

  it("turn/started → running, turn/completed → turn_completed{completed}", () => {
    const r = new CodexRouting();
    expect(
      mapCodexNotification("turn/started", { threadId: "th", turn: { id: "t1" } }, r)[0],
    ).toMatchObject({ type: "session_status_changed", status: "running" });
    expect(
      mapCodexNotification("turn/completed", { threadId: "th", turn: { id: "t1", status: "completed" } }, r)[0],
    ).toMatchObject({ type: "turn_completed", status: "completed" });
  });

  it("turn/completed interrupted → cancelled, failed → failed (TurnStatus enum)", () => {
    const r = new CodexRouting();
    expect(
      mapCodexNotification("turn/completed", { threadId: "th", turn: { id: "x", status: "interrupted" } }, r)[0],
    ).toMatchObject({ type: "turn_completed", status: "cancelled" });
    expect(
      mapCodexNotification("turn/completed", { threadId: "th", turn: { id: "y", status: "failed" } }, r)[0],
    ).toMatchObject({ type: "turn_completed", status: "failed" });
  });
});

describe("delta → completed reconcile (CX-5/CX-6)", () => {
  it("item/started(empty) → delta×2 → item/completed(text) authoritative replace", () => {
    const r = new CodexRouting();
    const tid = "th";
    const turn = "t1";
    const started = mapCodexNotification(
      "item/started",
      { threadId: tid, turnId: turn, item: { type: "agentMessage", id: "i1", text: "", phase: null, memoryCitation: null } },
      r,
    );
    expect(started[0]).toMatchObject({ type: "agent_message", mode: "replace", content: [] });
    const d1 = mapCodexNotification("item/agentMessage/delta", { threadId: tid, turnId: turn, itemId: "i1", delta: "Look" }, r);
    expect(d1[0]).toMatchObject({ type: "agent_message_delta", delta: "Look" });
    const completed = mapCodexNotification(
      "item/completed",
      { threadId: tid, turnId: turn, item: { type: "agentMessage", id: "i1", text: "Looks good", phase: null, memoryCitation: null } },
      r,
    );
    expect(completed[0]).toMatchObject({
      type: "agent_message",
      mode: "replace",
      content: [{ type: "text", text: "Looks good" }],
    });
  });

  it("CX-6: item/completed(plan) is authoritative plan_updated; plan delta remains suppressed", () => {
    const r = new CodexRouting();
    expect(
      mapCodexNotification(
        "item/plan/delta",
        { threadId: "th", turnId: "t1", itemId: "pl", delta: "old incremental" },
        r,
      ),
    ).toEqual([]);

    const completed = mapCodexNotification(
      "item/completed",
      { threadId: "th", turnId: "t1", item: { type: "plan", id: "pl", text: "final plan" } },
      r,
    );

    expect(completed).toEqual([
      {
        type: "plan_updated",
        ref: {
          provider: "codex",
          threadId: "th",
          turnId: "t1",
          itemId: "pl",
          raw: { type: "plan", id: "pl", text: "final plan" },
        },
        entries: [{ id: "pl", content: "final plan", status: "completed" }],
      },
    ]);
  });
});

describe("plan casing (CX-7)", () => {
  it("turn/plan/updated inProgress → in_progress", () => {
    const r = new CodexRouting();
    const events = mapCodexNotification(
      "turn/plan/updated",
      { threadId: "th", turnId: "t1", plan: [{ step: "do x", status: "inProgress" }, { step: "do y", status: "pending" }] },
      r,
    );
    expect(events[0]).toMatchObject({
      type: "plan_updated",
      entries: [
        { content: "do x", status: "in_progress" },
        { content: "do y", status: "pending" },
      ],
    });
  });
});

describe("command output routing (CX-8/CX-10)", () => {
  it("CX-8: item/commandExecution/outputDelta → command_output_delta{stdout}", () => {
    const r = new CodexRouting();
    const events = mapCodexNotification(
      "item/commandExecution/outputDelta",
      { threadId: "th", turnId: "t1", itemId: "c1", delta: "hello" },
      r,
    );
    expect(events[0]).toMatchObject({ type: "command_output_delta", stream: "stdout", delta: "hello" });
  });

  it("CX-9: standalone command/exec outputDelta remains unsupported and raw-counted", () => {
    const r = new CodexRouting();
    const before = getUnknownNotificationCount();
    const params = { processId: "p1", stream: "stderr", deltaBase64: "ZXJy", capReached: false };

    expect(mapCodexNotification("command/exec/outputDelta", params, r)).toEqual([]);
    expect(getUnknownNotificationCount()).toBe(before + 1);
    expect(getUnknownNotificationRawPayloads()).toContainEqual({
      method: "command/exec/outputDelta",
      params,
    });
  });

  it("CX-10: commandExecution completed declined → tool_call_updated{failed}", () => {
    const r = new CodexRouting();
    const item = {
      type: "commandExecution",
      id: "c1",
      command: "rm -rf /",
      cwd: "/work",
      processId: null,
      source: "agent",
      status: "declined",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const events = mapCodexNotification("item/completed", { threadId: "th", turnId: "t1", item }, r);
    expect(events[0]).toMatchObject({ type: "tool_call_updated", update: { kind: "execute", status: "failed" } });
  });

  it("commandExecution started → tool_call_updated{execute,in_progress}", () => {
    const r = new CodexRouting();
    const item = {
      type: "commandExecution",
      id: "c1",
      command: "ls",
      cwd: "/work",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const events = mapCodexNotification("item/started", { threadId: "th", turnId: "t1", item }, r);
    expect(events[0]).toMatchObject({ type: "tool_call_updated", update: { id: "c1", kind: "execute", status: "in_progress", title: "ls" } });
  });

  it("commandExecution with locations → tool_call_updated preserves file locations", () => {
    const r = new CodexRouting();
    const item = {
      type: "commandExecution",
      id: "c1",
      command: "sed -n '12p' src/lib/example.ts",
      cwd: "/work",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "line 12",
      exitCode: 0,
      durationMs: 1,
      locations: [{ path: "src/lib/example.ts", line: 12, column: 4 }],
    };
    const events = mapCodexNotification("item/completed", { threadId: "th", turnId: "t1", item }, r);
    expect(events[0]).toMatchObject({
      type: "tool_call_updated",
      update: {
        id: "c1",
        kind: "execute",
        status: "completed",
        locations: [{ path: "src/lib/example.ts", line: 12, column: 4 }],
      },
    });
  });
});

describe("fileChange (file_change_updated + tool_call_updated)", () => {
  it("item/fileChange/patchUpdated → file_change_updated per change (add/update/move)", () => {
    const r = new CodexRouting();
    const events = mapCodexNotification(
      "item/fileChange/patchUpdated",
      {
        threadId: "th",
        turnId: "t1",
        itemId: "f1",
        changes: [
          { path: "a.ts", kind: { type: "add" }, diff: "+1" },
          { path: "b.ts", kind: { type: "update", move_path: "c.ts" }, diff: "@@" },
        ],
      },
      r,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "file_change_updated", change: { path: "a.ts", operation: "create" } });
    expect(events[1]).toMatchObject({
      type: "file_change_updated",
      change: { path: "c.ts", operation: "move", oldPath: "b.ts" },
    });
  });

  it("fileChange completed → tool_call_updated{edit} + file_change_updated[]", () => {
    const r = new CodexRouting();
    const item = {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [{ path: "a.ts", kind: { type: "delete" }, diff: "-1" }],
    };
    const events = mapCodexNotification("item/completed", { threadId: "th", turnId: "t1", item }, r);
    expect(events[0]).toMatchObject({ type: "tool_call_updated", update: { kind: "edit", status: "completed" } });
    expect(events[1]).toMatchObject({ type: "file_change_updated", change: { path: "a.ts", operation: "delete" } });
  });
});

describe("reasoning (thought channel)", () => {
  it("item/reasoning/textDelta → agent_message_delta{channel:thought}", () => {
    const r = new CodexRouting();
    const events = mapCodexNotification(
      "item/reasoning/textDelta",
      { threadId: "th", turnId: "t1", itemId: "rs", delta: "thinking", contentIndex: 0 },
      r,
    );
    expect(events[0]).toMatchObject({ type: "agent_message_delta", channel: "thought", delta: "thinking" });
  });

  it("reasoning delta preserves contentIndex and summaryIndex segment metadata", () => {
    const r = new CodexRouting();
    const content = mapCodexNotification(
      "item/reasoning/textDelta",
      { threadId: "th", turnId: "t1", itemId: "rs", delta: "c1", contentIndex: 1 },
      r,
    );
    const summary = mapCodexNotification(
      "item/reasoning/summaryTextDelta",
      { threadId: "th", turnId: "t1", itemId: "rs", delta: "s0", summaryIndex: 0 },
      r,
    );

    expect(content[0]).toMatchObject({
      type: "agent_message_delta",
      channel: "thought",
      segment: { kind: "content", index: 1 },
    });
    expect(summary[0]).toMatchObject({
      type: "agent_message_delta",
      channel: "thought",
      segment: { kind: "summary", index: 0 },
    });
  });

  it("reasoning completed → summary is the authoritative thought text (OQ-46)", () => {
    const r = new CodexRouting();
    const item = { type: "reasoning", id: "rs", summary: ["s1", "s2"], content: ["c1", "c2"] };
    const events = mapCodexNotification("item/completed", { threadId: "th", turnId: "t1", item }, r);
    expect(events[0]).toMatchObject({
      type: "agent_message",
      channel: "thought",
      mode: "replace",
      content: [{ type: "text", text: "s1\ns2" }],
    });
  });

  it("reasoning completed falls back to content only when summary is absent", () => {
    const r = new CodexRouting();
    const summaryOnly = mapCodexNotification(
      "item/completed",
      { threadId: "th", turnId: "t1", item: { type: "reasoning", id: "rs-s", summary: ["s"], content: [] } },
      r,
    );
    const contentOnly = mapCodexNotification(
      "item/completed",
      { threadId: "th", turnId: "t1", item: { type: "reasoning", id: "rs-c", summary: [], content: ["c"] } },
      r,
    );

    expect(summaryOnly[0]).toMatchObject({ content: [{ type: "text", text: "s" }] });
    expect(contentOnly[0]).toMatchObject({ content: [{ type: "text", text: "c" }] });
  });

  it("reasoning started → empty thought message", () => {
    const r = new CodexRouting();
    const item = { type: "reasoning", id: "rs", summary: [], content: [] };
    const events = mapCodexNotification("item/started", { threadId: "th", turnId: "t1", item }, r);
    expect(events[0]).toMatchObject({ type: "agent_message", channel: "thought", content: [] });
  });
});

describe("token usage (CX-20)", () => {
  it("tokenUsage before turn/completed → combined into turn_completed.usage (totalTokens dropped)", () => {
    const r = new CodexRouting();
    const tu = {
      total: { totalTokens: 999, inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1 },
      last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: null,
    };
    expect(mapCodexNotification("thread/tokenUsage/updated", { threadId: "th", turnId: "t1", tokenUsage: tu }, r)).toEqual([]);
    const completed = mapCodexNotification("turn/completed", { threadId: "th", turn: { id: "t1", status: "completed" } }, r);
    expect(completed[0]).toMatchObject({
      type: "turn_completed",
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1 },
    });
    expect((completed[0] as unknown as { usage: Record<string, unknown> }).usage).not.toHaveProperty("totalTokens");
  });

  it("M4: tokenUsage AFTER turn closed → usage-only turn_completed reinforcement", () => {
    const r = new CodexRouting();
    // turn closes first (no usage)
    mapCodexNotification("turn/completed", { threadId: "th", turn: { id: "t1", status: "completed" } }, r);
    const tu = {
      total: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: null,
    };
    const late = mapCodexNotification("thread/tokenUsage/updated", { threadId: "th", turnId: "t1", tokenUsage: tu }, r);
    expect(late[0]).toMatchObject({ type: "turn_completed", status: "completed", usage: { inputTokens: 3 } });
  });
});

describe("error notification (CX-18)", () => {
  it("error{willRetry:true} → error{recoverable:true} + codexErrorInfo in ref.raw", () => {
    const r = new CodexRouting();
    const error = { message: "rate limited", codexErrorInfo: "usageLimitExceeded", additionalDetails: null };
    const events = mapCodexNotification("error", { threadId: "th", turnId: "t1", error, willRetry: true }, r);
    expect(events[0]).toMatchObject({ type: "error", message: "rate limited", recoverable: true });
    expect((events[0] as { ref: { raw: unknown } }).ref.raw).toEqual(error);
  });
});

describe("interleaved triple-key separation (CX-16)", () => {
  it("two threads' deltas keep correct (threadId,turnId,itemId) refs", () => {
    const r = new CodexRouting();
    const a = mapCodexNotification("item/agentMessage/delta", { threadId: "A", turnId: "t1", itemId: "iA", delta: "x" }, r);
    const b = mapCodexNotification("item/agentMessage/delta", { threadId: "B", turnId: "t2", itemId: "iB", delta: "y" }, r);
    expect((a[0] as { ref: object }).ref).toMatchObject({ threadId: "A", turnId: "t1", itemId: "iA" });
    expect((b[0] as { ref: object }).ref).toMatchObject({ threadId: "B", turnId: "t2", itemId: "iB" });
  });

  it("CX-17: same thread t1 completed then t2 started keeps turns separate", () => {
    const r = new CodexRouting();
    mapCodexNotification("turn/started", { threadId: "th", turn: { id: "t1" } }, r);
    const completed = mapCodexNotification("turn/completed", { threadId: "th", turn: { id: "t1", status: "completed" } }, r);
    const next = mapCodexNotification("turn/started", { threadId: "th", turn: { id: "t2" } }, r);

    expect(completed[0]).toMatchObject({ type: "turn_completed", ref: { threadId: "th", turnId: "t1" } });
    expect(next[0]).toMatchObject({ type: "session_status_changed", ref: { threadId: "th", turnId: "t2" }, status: "running" });
    expect(r.isTurnClosed("th", "t1")).toBe(true);
    expect(r.activeTurnOf("th")).toBe("t2");
  });
});

describe("approval mapping (CX-11/CX-15/CX-15b/CX-15c)", () => {
  it("CX-11: commandExecution requestApproval → approval_requested{id:'7'} + options", () => {
    const r = new CodexRouting();
    const res = mapCodexServerRequest(
      "item/commandExecution/requestApproval",
      7,
      { threadId: "th", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" },
      r,
    );
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({
      type: "approval_requested",
      ref: { requestId: "7", toolCallId: "c1" },
      request: { id: "7", toolCallId: "c1", severity: "normal" },
    });
    const kinds = (res.events[0] as { request: { options: { kind: string }[] } }).request.options.map((o) => o.kind);
    expect(kinds).toEqual(["allow_once", "allow_always", "reject_once", "cancel"]);
    expect(r.hasPendingApproval("7")).toBe(true);
  });

  it("escalation: command approval high-risk signals → severity escalation", () => {
    expect(codexApprovalSeverity("item/commandExecution/requestApproval", { proposedExecpolicyAmendment: {} })).toBe("escalation");
    expect(codexApprovalSeverity("item/commandExecution/requestApproval", { proposedNetworkPolicyAmendments: [] })).toBe("escalation");
    expect(codexApprovalSeverity("item/commandExecution/requestApproval", { networkApprovalContext: {} })).toBe("escalation");
    expect(codexApprovalSeverity("item/commandExecution/requestApproval", { sandbox: "danger-full-access" })).toBe("escalation");
    expect(codexApprovalSeverity("item/commandExecution/requestApproval", { sandboxRequested: "danger-full-access" })).toBe("escalation");
    expect(codexApprovalSeverity("item/commandExecution/requestApproval", { approvalMode: "Agent (Full Access)" })).toBe("escalation");
    expect(codexApprovalSeverity("item/permissions/requestApproval", {})).toBe("escalation");
    expect(codexApprovalSeverity("item/fileChange/requestApproval", { grantRoot: "/" })).toBe("escalation");
    expect(
      codexApprovalSeverity("item/commandExecution/requestApproval", {
        additionalPermissions: { network: { enabled: true }, fileSystem: null },
      }),
    ).toBe("escalation");
    expect(
      codexApprovalSeverity("item/commandExecution/requestApproval", {
        additionalPermissions: {
          network: null,
          fileSystem: { read: null, write: ["/etc"], entries: [{ path: "/var", access: "write" }] },
        },
      }),
    ).toBe("escalation");
    expect(
      codexApprovalSeverity("item/commandExecution/requestApproval", {
        additionalPermissions: {
          network: { enabled: false },
          fileSystem: { read: ["/workspace"], write: null, entries: [{ path: "/workspace", access: "read" }] },
        },
      }),
    ).toBe("normal");
    expect(codexApprovalSeverity("item/commandExecution/requestApproval", {})).toBe("normal");
  });

  it("OQ-47: generated commandActions stay normal, future side-effect commandActions escalate", () => {
    expect(
      codexApprovalSeverity("item/commandExecution/requestApproval", {
        commandActions: [
          { type: "read", command: "cat package.json", name: "package.json", path: "/repo/package.json" },
          { type: "listFiles", command: "ls", path: "/repo" },
          { type: "search", command: "rg direct-runtime", query: "direct-runtime", path: "/repo" },
          { type: "unknown", command: "custom read-only helper" },
        ],
      }),
    ).toBe("normal");

    expect(
      codexApprovalSeverity("item/commandExecution/requestApproval", {
        commandActions: [{ type: "write", command: "tee /etc/app.conf", path: "/etc/app.conf" }],
      }),
    ).toBe("escalation");
    expect(
      codexApprovalSeverity("item/commandExecution/requestApproval", {
        commandActions: [{ type: "execute", command: "sudo service restart" }],
      }),
    ).toBe("escalation");
    expect(
      codexApprovalSeverity("item/commandExecution/requestApproval", {
        commandActions: [{ type: "fetch", command: "curl https://example.com" }],
      }),
    ).toBe("escalation");
  });

  it("fileChange requestApproval → approval_requested with body=reason", () => {
    const r = new CodexRouting();
    const res = mapCodexServerRequest(
      "item/fileChange/requestApproval",
      "rq-1",
      { threadId: "th", turnId: "t1", itemId: "f1", startedAtMs: 1, reason: "extra write" },
      r,
    );
    expect(res.events[0]).toMatchObject({ type: "approval_requested", request: { id: "rq-1", body: "extra write" } });
    expect(r.hasPendingApproval("rq-1")).toBe(true);
  });

  it("permissions requestApproval → auto-decline reply + approval_resolved{failed} (D12)", () => {
    const r = new CodexRouting();
    const res = mapCodexServerRequest(
      "item/permissions/requestApproval",
      9,
      { threadId: "th", turnId: "t1", itemId: "p1", startedAtMs: 1, cwd: "/work", reason: null, permissions: {} },
      r,
    );
    expect(res.reply).toEqual({ kind: "auto-decline", id: 9 });
    expect(res.events[0]).toMatchObject({
      type: "approval_resolved",
      decision: { requestId: "9", outcome: "failed" },
      decidedBy: "auto",
    });
  });

  it("CX-15: serverRequest/resolved closes pending approval → approval_resolved{cancelled}", () => {
    const r = new CodexRouting();
    mapCodexServerRequest("item/commandExecution/requestApproval", 7, { threadId: "th", turnId: "t1", itemId: "c1", startedAtMs: 1 }, r);
    const events = mapCodexNotification("serverRequest/resolved", { threadId: "th", requestId: 7 }, r);
    // Finding 4: serverRequest/resolved 페이로드엔 turnId가 없지만, resolved pending의
    // (threadId,turnId,itemId)로 ref를 복원해야 store가 올바른 turnKey의 pendingRequestCount를
    // 0으로 내려 seal/eviction이 동작한다(threadId만이면 turn이 영구 미봉인).
    expect(events[0]).toMatchObject({
      type: "approval_resolved",
      ref: { threadId: "th", turnId: "t1", itemId: "c1" },
      decision: { requestId: "7", outcome: "cancelled" },
      decidedBy: "cleanup",
    });
    expect(r.hasPendingApproval("7")).toBe(false);
  });

  it("serverRequest/resolved for already-closed approval → [] (idempotent)", () => {
    const r = new CodexRouting();
    expect(mapCodexNotification("serverRequest/resolved", { threadId: "th", requestId: 99 }, r)).toEqual([]);
  });

  it("CX-15b: unsupported server request → error(-32601) reply, no events", () => {
    const r = new CodexRouting();
    const before = getUnknownNotificationCount();
    const res = mapCodexServerRequest("mcpServer/elicitation/request", 42, { foo: 1 }, r);
    expect(res.events).toEqual([]);
    expect(res.reply).toEqual({ kind: "error", id: 42, method: "mcpServer/elicitation/request" });
    expect(getUnknownNotificationCount()).toBe(before + 1);
    expect(getUnknownNotificationRawPayloads()).toContainEqual({
      id: 42,
      method: "mcpServer/elicitation/request",
      params: { foo: 1 },
    });
  });

  it("CX-15c: unsupported notification → [] + counter++, no outbound", () => {
    const r = new CodexRouting();
    const before = getUnknownNotificationCount();
    expect(mapCodexNotification("thread/realtime/started", { foo: 1 }, r)).toEqual([]);
    expect(getUnknownNotificationCount()).toBe(before + 1);
    expect(getUnknownNotificationRawPayloads()).toContainEqual({
      method: "thread/realtime/started",
      params: { foo: 1 },
    });
  });

  it("CX-15d: unknown item variant → [] + raw diagnostics, no silent drop", () => {
    const r = new CodexRouting();
    const startedItem = { type: "futureWidget", id: "fw-start", payload: { mode: "preview" } };
    const completedItem = { type: "futureWidget", id: "fw-done", payload: { mode: "final" } };

    expect(mapCodexNotification("item/started", { threadId: "th", turnId: "t1", item: startedItem }, r)).toEqual([]);
    expect(mapCodexNotification("item/completed", { threadId: "th", turnId: "t1", item: completedItem }, r)).toEqual([]);

    expect(getUnknownNotificationCount()).toBe(2);
    expect(getUnknownNotificationRawPayloads()).toContainEqual({
      method: "item/started",
      params: { threadId: "th", turnId: "t1", item: startedItem },
    });
    expect(getUnknownNotificationRawPayloads()).toContainEqual({
      method: "item/completed",
      params: { threadId: "th", turnId: "t1", item: completedItem },
    });
  });

  it("item/plan/delta is suppressed (experimental, completed authoritative)", () => {
    const r = new CodexRouting();
    expect(mapCodexNotification("item/plan/delta", { threadId: "th", turnId: "t1", itemId: "pl", delta: "x" }, r)).toEqual([]);
  });
});

describe("outbound makeTextUserInput / mapAgentContentToUserInput (H4/OQ-33)", () => {
  it("makeTextUserInput sets text + empty text_elements (required field)", () => {
    expect(makeTextUserInput("hi")).toEqual({ type: "text", text: "hi", text_elements: [] });
  });

  it("text content → UserInput text variant", () => {
    expect(mapAgentContentToUserInput([{ type: "text", text: "hello" }])).toEqual([
      { type: "text", text: "hello", text_elements: [] },
    ]);
  });

  it("image dropped without caps, mapped with caps (file:// → localImage)", () => {
    expect(mapAgentContentToUserInput([{ type: "image", uri: "https://x/y.png" }])).toEqual([]);
    expect(mapAgentContentToUserInput([{ type: "image", uri: "https://x/y.png" }], { imageInput: true })).toEqual([
      { type: "image", url: "https://x/y.png" },
    ]);
    expect(mapAgentContentToUserInput([{ type: "image", uri: "file:///a.png" }], { imageInput: true })).toEqual([
      { type: "localImage", path: "/a.png" },
    ]);
  });

  it("resource → mention reference", () => {
    expect(mapAgentContentToUserInput([{ type: "resource", uri: "file:///doc.md", text: "doc" }])).toEqual([
      { type: "mention", name: "doc", path: "file:///doc.md" },
    ]);
  });

  it("Codex skill resource → UserInput skill variant", () => {
    expect(
      mapAgentContentToUserInput([
        {
          type: "resource",
          uri: "file:///home/tester/.codex/skills/review/SKILL.md",
          text: "review",
          resourceKind: "skill",
        },
      ]),
    ).toEqual([
      {
        type: "skill",
        name: "review",
        path: "/home/tester/.codex/skills/review/SKILL.md",
      },
    ]);
  });
});
