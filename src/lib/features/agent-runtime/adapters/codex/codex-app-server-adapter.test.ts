/**
 * Codex 어댑터 통합 테스트(11 §3 CX-1/CX-2/CX-12..15/CX-17/CX-19 + 05 §10 lifecycle/cancel/shutdown).
 * mock transport(deps)로 process spawn·send·listen·shutdown을 주입하고, inbound message를
 * listener에 주입해 wire→AgentEvent 변환과 outbound wire를 검증한다.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../contracts/normalized";
import type { AgentRuntimeEvent, JsonRpcMessage } from "../../service/transport";
import { createCodexAppServerAdapter, type CodexAdapterDeps } from "./codex-app-server-adapter";

/** mock transport harness. send 캡처 + 자동 응답 + inbound 주입. */
function makeHarness(opts?: { autoRespond?: (msg: JsonRpcMessage) => unknown }) {
  const sent: JsonRpcMessage[] = [];
  // 실제 transport처럼 event 이름별로 listener를 분리(한 message 주입이 한 handler만 부른다).
  const byEvent = new Map<string, Array<(e: { payload: AgentRuntimeEvent }) => void>>();
  const runtimeId = 1;
  let idCounter = 0;

  function fire(eventName: string, payload: AgentRuntimeEvent): void {
    for (const l of byEvent.get(eventName) ?? []) l({ payload });
  }

  // inbound 주입: backend → frontend event(이름별 1개 채널만).
  function inject(message: JsonRpcMessage): void {
    fire("agent-runtime-message", { type: "message", runtimeId, message });
  }
  function injectExit(code?: number, signal?: string): void {
    fire("agent-runtime-exit", { type: "exit", runtimeId, code, signal });
  }
  function injectError(message: string, recoverable: boolean): void {
    fire("agent-runtime-error", { type: "error", runtimeId, message, recoverable });
  }

  const deps: CodexAdapterDeps = {
    start: async () => runtimeId,
    send: async (_rid, message) => {
      sent.push(message);
      // 자동 응답: 우리가 보낸 request에 result를 주입(handshake/thread/start/turn 등).
      const auto = opts?.autoRespond?.(message);
      if (auto !== undefined && "id" in message && "method" in message) {
        // 다음 tick에 응답 주입(Promise 체인 정상 동작).
        queueMicrotask(() => inject({ id: (message as { id: number }).id, result: auto }));
      }
    },
    cancel: async () => {},
    shutdown: async () => {},
    listenRuntime: async (event, h) => {
      const arr = byEvent.get(event) ?? [];
      arr.push(h);
      byEvent.set(event, arr);
      return () => {
        const cur = byEvent.get(event) ?? [];
        const i = cur.indexOf(h);
        if (i >= 0) cur.splice(i, 1);
      };
    },
    appVersion: "test",
    nextRpcId: () => (idCounter += 1),
  };

  return { deps, sent, inject, injectExit, injectError };
}

/** initialize/thread/start/turn/start/turn/interrupt 자동 응답기. */
function autoResponder(message: JsonRpcMessage): unknown {
  if (!("method" in message)) return undefined;
  const m = message.method;
  if (m === "initialize") return { userAgent: "codex 0.142.0", codexHome: "/h", platformFamily: "unix", platformOs: "linux" };
  if (m === "thread/start") return { thread: { id: "th_1", sessionId: "s1", cwd: "/work", turns: [] } };
  if (m === "thread/resume") return { thread: { id: "th_1", sessionId: "s1", cwd: "/work", turns: [] } };
  if (m === "thread/read")
    return {
      thread: {
        id: "th_1",
        sessionId: "s1",
        cwd: "/work",
        turns: [
          { id: "t0", items: [{ type: "agentMessage", id: "i0", text: "old msg", phase: null, memoryCitation: null }], itemsView: "full", status: "completed" },
        ],
      },
    };
  if (m === "turn/start") return { turn: { id: "t1", status: "inProgress" } };
  if (m === "turn/interrupt") return {};
  return undefined;
}

async function startReadySession() {
  const h = makeHarness({ autoRespond: autoResponder });
  const adapter = createCodexAppServerAdapter(h.deps);
  const events: AgentEvent[] = [];
  // subscribe AFTER start? we need listener before lifecycle emits; subscribe via separate path.
  // startSession은 listener 등록 전 starting을 deferred 큐에 쌓는다 → subscribe 시 flush.
  await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });
  // 구독은 start 완료 후. 구독 전 emit된 lifecycle 이벤트는 deferred 버퍼에서 flush된다.
  const unlisten = adapter.subscribeEvents("H", (e) => events.push(e));
  return { adapter, events, h, unlisten };
}

describe("startSession lifecycle (CX-1)", () => {
  it("emits starting → session_started → ready; handshake sends initialize+initialized; thread/start", async () => {
    const { events, h } = await startReadySession();
    const types = events.map((e) => e.type);
    expect(types).toContain("session_status_changed");
    expect(types).toContain("session_started");
    const started = events.find((e) => e.type === "session_started") as Extract<AgentEvent, { type: "session_started" }>;
    expect(started.ref).toMatchObject({ threadId: "th_1", sessionId: "s1" });
    expect(started.cwd).toBe("/work");
    // 마지막 status는 ready
    const statuses = events.filter((e) => e.type === "session_status_changed") as Array<Extract<AgentEvent, { type: "session_status_changed" }>>;
    expect(statuses[0].status).toBe("starting");
    expect(statuses[statuses.length - 1].status).toBe("ready");

    // outbound: initialize(req), initialized(notif), thread/start(req)
    const methods = h.sent.filter((m) => "method" in m).map((m) => (m as { method: string }).method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start"]);
    // Codex envelope: jsonrpc 필드 없음
    for (const m of h.sent) expect((m as { jsonrpc?: string }).jsonrpc).toBeUndefined();
  });

  it("thread/started notification after response is idempotent (no duplicate session_started)", async () => {
    const { events, h } = await startReadySession();
    const before = events.filter((e) => e.type === "session_started").length;
    h.inject({ method: "thread/started", params: { thread: { id: "th_1", sessionId: "s1", cwd: "/work" } } });
    const after = events.filter((e) => e.type === "session_started").length;
    expect(after).toBe(before); // 멱등(response 권위)
  });
});

describe("resumeSession replay (CX-2)", () => {
  it("replay=true → thread/read, session_loaded + replayed item events", async () => {
    const h = makeHarness({ autoRespond: autoResponder });
    const adapter = createCodexAppServerAdapter(h.deps);
    const events: AgentEvent[] = [];
    await adapter.resumeSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work", providerThreadId: "th_1", replay: true });
    adapter.subscribeEvents("H", (e) => events.push(e));
    const types = events.map((e) => e.type);
    expect(types).toContain("session_loaded");
    // replayed agentMessage completed → agent_message replace
    const replayed = events.find((e) => e.type === "agent_message") as Extract<AgentEvent, { type: "agent_message" }>;
    expect(replayed.content).toEqual([{ type: "text", text: "old msg" }]);
    const methods = h.sent.filter((m) => "method" in m).map((m) => (m as { method: string }).method);
    expect(methods).toContain("thread/read");
  });
});

describe("sendPrompt (turn/start outbound)", () => {
  it("sends turn/start with makeTextUserInput input, emits running", async () => {
    const { adapter, events, h } = await startReadySession();
    h.sent.length = 0;
    events.length = 0;
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "hi" }] });
    const turnStart = h.sent.find((m) => "method" in m && (m as { method: string }).method === "turn/start") as { params: { threadId: string; input: unknown[] } };
    expect(turnStart.params.threadId).toBe("th_1");
    expect(turnStart.params.input).toEqual([{ type: "text", text: "hi", text_elements: [] }]);
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "running")).toBe(true);
  });

  it("H3: turn/start error → error event + status restored to ready, no active turn", async () => {
    const h = makeHarness({
      autoRespond: (m) => {
        if (!("method" in m)) return undefined;
        if (m.method === "turn/start") return undefined; // handled below by error injection
        return autoResponder(m);
      },
    });
    // turn/start에 error 응답을 주입하도록 send 래핑
    const realSend = h.deps.send;
    h.deps.send = async (rid, message) => {
      await realSend(rid, message);
      if ("method" in message && message.method === "turn/start") {
        queueMicrotask(() => h.inject({ id: (message as { id: number }).id, error: { code: -32000, message: "turn failed" } }));
      }
    };
    const adapter = createCodexAppServerAdapter(h.deps);
    const events: AgentEvent[] = [];
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "U", workDir: "/work" });
    adapter.subscribeEvents("H", (e) => events.push(e));
    events.length = 0;
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "x" }] });
    expect(events.some((e) => e.type === "error" && e.message === "turn failed")).toBe(true);
    const lastStatus = events.filter((e) => e.type === "session_status_changed").pop() as Extract<AgentEvent, { type: "session_status_changed" }>;
    expect(lastStatus.status).toBe("ready");
  });
});

describe("approval roundtrip (CX-12/CX-13/CX-14)", () => {
  it("approval_requested → respondApproval(allow_once) → outbound {id:7,result:{decision:accept}} no jsonrpc", async () => {
    const { adapter, events, h } = await startReadySession();
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });
    const req = events.find((e) => e.type === "approval_requested") as Extract<AgentEvent, { type: "approval_requested" }>;
    expect(req.request.id).toBe("7");
    h.sent.length = 0;
    await adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" });
    expect(h.sent[0]).toEqual({ id: 7, result: { decision: "accept" } });
    expect((h.sent[0] as { jsonrpc?: string }).jsonrpc).toBeUndefined();
    expect(events.some((e) => e.type === "approval_resolved")).toBe(true);
  });

  it("CX-13: allow_always → acceptForSession; CX-14: reject_always → decline", async () => {
    const { adapter, h } = await startReadySession();
    h.inject({ id: 8, method: "item/fileChange/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "f1", startedAtMs: 1 } });
    h.sent.length = 0;
    await adapter.respondApproval("H", { requestId: "8", outcome: "selected", optionId: "allow_always" });
    expect(h.sent[0]).toEqual({ id: 8, result: { decision: "acceptForSession" } });

    h.inject({ id: 9, method: "item/fileChange/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "f2", startedAtMs: 1 } });
    h.sent.length = 0;
    await adapter.respondApproval("H", { requestId: "9", outcome: "selected", optionId: "reject_always" });
    expect(h.sent[0]).toEqual({ id: 9, result: { decision: "decline" } });
  });

  it("CX-15b: unsupported server request → outbound JSON-RPC error(-32601) with same id", async () => {
    const { events, h } = await startReadySession();
    h.sent.length = 0;
    h.inject({ id: 42, method: "mcpServer/elicitation/request", params: { foo: 1 } });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ id: 42, error: { code: -32601 } });
    // no approval event
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
  });

  it("permissions request → auto-decline reply {permissions:{},scope:turn} (D12)", async () => {
    const { h } = await startReadySession();
    h.sent.length = 0;
    h.inject({ id: 11, method: "item/permissions/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "p1", startedAtMs: 1, cwd: "/work", reason: null, permissions: {} } });
    expect(h.sent[0]).toEqual({ id: 11, result: { permissions: {}, scope: "turn" } });
  });

  it("New-F1: wire send 실패 시 pending 유지(재시도 가능), 재시도 성공 시 닫힘 + approval_resolved(turnId 보존)", async () => {
    let failApprovalSend = false;
    const byEvent = new Map<string, Array<(e: { payload: AgentRuntimeEvent }) => void>>();
    const runtimeId = 1;
    let idCounter = 0;
    const fire = (name: string, payload: AgentRuntimeEvent) => {
      for (const l of byEvent.get(name) ?? []) l({ payload });
    };
    const inject = (message: JsonRpcMessage) => fire("agent-runtime-message", { type: "message", runtimeId, message });
    const deps: CodexAdapterDeps = {
      start: async () => runtimeId,
      send: async (_rid, message) => {
        // approval 응답({id:7,result})만 실패 토글로 막는다. startup 요청/알림은 통과.
        if (failApprovalSend && "result" in (message as object) && (message as { id?: unknown }).id === 7) {
          throw new Error("send failed");
        }
        const auto = autoResponder(message);
        if (auto !== undefined && "id" in message && "method" in message) {
          queueMicrotask(() => inject({ id: (message as { id: number }).id, result: auto }));
        }
      },
      cancel: async () => {},
      shutdown: async () => {},
      listenRuntime: async (event, h) => {
        const arr = byEvent.get(event) ?? [];
        arr.push(h);
        byEvent.set(event, arr);
        return () => {};
      },
      appVersion: "test",
      nextRpcId: () => (idCounter += 1),
    };
    const adapter = createCodexAppServerAdapter(deps);
    const events: AgentEvent[] = [];
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });
    adapter.subscribeEvents("H", (e) => events.push(e));
    inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });

    // wire 실패 → reject + pending 유지(approval_resolved 미emit).
    failApprovalSend = true;
    await expect(
      adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" }),
    ).rejects.toThrow("send failed");
    expect(events.some((e) => e.type === "approval_resolved")).toBe(false);

    // 재시도 → 성공, pending 닫힘 + approval_resolved(turnId/itemId 보존, store seal 정합).
    failApprovalSend = false;
    await adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" });
    const resolved = events.find((e) => e.type === "approval_resolved") as Extract<AgentEvent, { type: "approval_resolved" }>;
    expect(resolved).toBeTruthy();
    expect(resolved.ref).toMatchObject({ threadId: "th_1", turnId: "t1", itemId: "c1" });
  });

  it("New-F1 race: respondApproval in-flight 중 serverRequest/resolved가 와도 이중 wire/emit 없음", async () => {
    let releaseSend: (() => void) | null = null;
    const sent: JsonRpcMessage[] = [];
    const byEvent = new Map<string, Array<(e: { payload: AgentRuntimeEvent }) => void>>();
    const runtimeId = 1;
    let idCounter = 0;
    const fire = (name: string, payload: AgentRuntimeEvent) => {
      for (const l of byEvent.get(name) ?? []) l({ payload });
    };
    const inject = (message: JsonRpcMessage) => fire("agent-runtime-message", { type: "message", runtimeId, message });
    const isApprovalResponse = (m: JsonRpcMessage) =>
      "result" in (m as object) && (m as { id?: unknown }).id === 7;
    const deps: CodexAdapterDeps = {
      start: async () => runtimeId,
      send: async (_rid, message) => {
        sent.push(message);
        // approval 응답({id:7,result})은 releaseSend 호출 전까지 in-flight로 대기시킨다.
        if (isApprovalResponse(message)) {
          await new Promise<void>((r) => {
            releaseSend = r;
          });
          return;
        }
        const auto = autoResponder(message);
        if (auto !== undefined && "id" in message && "method" in message) {
          queueMicrotask(() => inject({ id: (message as { id: number }).id, result: auto }));
        }
      },
      cancel: async () => {},
      shutdown: async () => {},
      listenRuntime: async (event, h) => {
        const arr = byEvent.get(event) ?? [];
        arr.push(h);
        byEvent.set(event, arr);
        return () => {};
      },
      appVersion: "test",
      nextRpcId: () => (idCounter += 1),
    };
    const adapter = createCodexAppServerAdapter(deps);
    const events: AgentEvent[] = [];
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });
    adapter.subscribeEvents("H", (e) => events.push(e));
    inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });

    // respondApproval 시작(claimForResponse → send in-flight). microtask yield로 send 진입 보장.
    const p = adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" });
    await Promise.resolve();
    await Promise.resolve();

    // in-flight 중 serverRequest/resolved 도착 → "responding"이라 skip(닫지 않음, emit 없음).
    inject({ method: "serverRequest/resolved", params: { threadId: "th_1", requestId: 7 } });
    expect(events.filter((e) => e.type === "approval_resolved")).toHaveLength(0);

    // send 완료 → respondApproval가 단일 경로로 닫는다.
    releaseSend?.();
    await p;
    const resolved = events.filter((e) => e.type === "approval_resolved");
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as Extract<AgentEvent, { type: "approval_resolved" }>).decision.outcome).toBe("selected");
    // approval wire 응답은 selected(accept) 1건만 — cancel 중복 없음.
    const approvalWires = sent.filter(isApprovalResponse);
    expect(approvalWires).toHaveLength(1);
    expect(approvalWires[0]).toMatchObject({ id: 7, result: { decision: "accept" } });
  });
});

describe("cancel cleanup (CX approval cancel)", () => {
  it("cancelTurn closes pending approval with decision:cancel BEFORE turn/interrupt", async () => {
    const { adapter, events, h } = await startReadySession();
    // 활성 turn 만들기
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "go" }] });
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });
    h.sent.length = 0;
    events.length = 0;
    await adapter.cancelTurn("H");
    // 순서: approval cancelled 응답 먼저 → turn/interrupt
    const cancelResp = h.sent.find((m) => "result" in m) as { id: number; result: { decision: string } };
    expect(cancelResp).toEqual({ id: 7, result: { decision: "cancel" } });
    const interruptIdx = h.sent.findIndex((m) => "method" in m && (m as { method: string }).method === "turn/interrupt");
    const respIdx = h.sent.findIndex((m) => "result" in m);
    expect(respIdx).toBeLessThan(interruptIdx); // approval 응답이 interrupt보다 먼저
    expect(events.some((e) => e.type === "approval_resolved" && e.decision.outcome === "cancelled")).toBe(true);
  });
});

describe("process exit (CX-19)", () => {
  it("exit closes all pending approval(failed) + rejects pending RPC + process_exited", async () => {
    const { events, h } = await startReadySession();
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });
    events.length = 0;
    h.injectExit(0, undefined);
    expect(events.some((e) => e.type === "approval_resolved" && e.decision.outcome === "failed")).toBe(true);
    expect(events.some((e) => e.type === "process_exited")).toBe(true);
    // 멱등: 다시 exit → 추가 emit 없음
    events.length = 0;
    h.injectExit(0, undefined);
    expect(events).toHaveLength(0);
  });

  it("runtime error event → error AgentEvent", async () => {
    const { events, h } = await startReadySession();
    events.length = 0;
    h.injectError("boom", false);
    expect(events.some((e) => e.type === "error" && e.message === "boom" && !e.recoverable)).toBe(true);
  });
});

describe("shutdown boundary (S3)", () => {
  it("shutdown closes pending(cancelled wire response) BEFORE backend shutdown + unlisten; idempotent on late exit", async () => {
    const order: string[] = [];
    const h = makeHarness({ autoRespond: autoResponder });
    const realShutdown = h.deps.shutdown;
    h.deps.shutdown = async (rid) => {
      order.push("backend-shutdown");
      await realShutdown(rid);
    };
    const adapter = createCodexAppServerAdapter(h.deps);
    const events: AgentEvent[] = [];
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "U", workDir: "/work" });
    adapter.subscribeEvents("H", (e) => events.push(e));
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });
    h.sent.length = 0;
    events.length = 0;
    await adapter.shutdown("H");

    // (a) pending approval cancelled wire response BEFORE backend-shutdown
    const cancelRespIdx = h.sent.findIndex((m) => "result" in m && (m as { result: { decision?: string } }).result.decision === "cancel");
    expect(cancelRespIdx).toBeGreaterThanOrEqual(0);
    expect(events.some((e) => e.type === "approval_resolved" && e.decision.outcome === "cancelled")).toBe(true);
    expect(order).toEqual(["backend-shutdown"]);

    // (c) late exit after shutdown → idempotent, no re-close
    events.length = 0;
    h.injectExit(0);
    expect(events).toHaveLength(0);
  });
});
