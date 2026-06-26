/**
 * Direct Agent Runtime — Codex app-server 어댑터(`AgentRuntimePort` 구현, 05 §3·§9).
 *
 * Codex app-server wire ↔ 공통 모델(AgentEvent/Port). lifecycle 오케스트레이션
 * (initialize→initialized→thread/start→turn/start), inbound message 라우팅,
 * approval 요청/응답/cleanup, cancel(turn/interrupt), exit/shutdown을 담당한다.
 * I/O는 transport 래퍼(service/transport.ts)로만 한다(15 §0.6). store는 직접 만지지 않고
 * AgentEvent를 listener로 emit한다(adapter→router).
 *
 * 규약: 타입은 15(contracts) + transport + generated(wire) 만 import(재정의 금지). 상대경로만.
 */

import type {
  AgentRuntimePort,
  AgentSessionHandle,
  StartSessionParams,
  ResumeSessionParams,
  SendPromptInput,
  SessionStartResult,
} from "../../contracts/runtime-port";
import type { AgentEvent, ApprovalDecision } from "../../contracts/normalized";
import type { UnlistenFn } from "../../../../tauri/event";
import type {
  RuntimeId,
  AgentRuntimeEvent,
  JsonRpcMessage,
} from "../../service/transport";
import {
  agentRuntimeStart,
  agentRuntimeSend,
  agentRuntimeCancel,
  agentRuntimeShutdown,
} from "../../service/transport";
import { CodexRouting } from "./codex-routing";
import {
  mapCodexNotification,
  mapCodexServerRequest,
  mapAgentContentToUserInput,
  OPTION_KIND_TO_DECISION,
} from "./codex-wire-mapper";
import { mapItemCompleted } from "./codex-wire-mapper";
import type { Thread } from "../../generated/codex-app-server/v2/Thread";

/**
 * 어댑터 DI. transport·listen·시간/난수 등 I/O를 주입해 vitest로 모킹(1.5 패턴).
 */
export interface CodexAdapterDeps {
  /** process spawn(transport). */
  start: typeof agentRuntimeStart;
  /** stdin JSON-RPC 전송. */
  send: typeof agentRuntimeSend;
  /** backend cancel(process target만; turn/request는 adapter가 wire 전송). */
  cancel: typeof agentRuntimeCancel;
  /** graceful shutdown. */
  shutdown: typeof agentRuntimeShutdown;
  /** runtime event 구독(runtimeId 필터는 어댑터가 함). */
  listenRuntime: (
    event: string,
    h: (e: { payload: AgentRuntimeEvent }) => void,
  ) => Promise<UnlistenFn>;
  /** initialize ClientInfo.version. */
  appVersion: string;
  /** JSON-RPC request id 생성기(단조 증가). 테스트에서 결정적 주입. */
  nextRpcId: () => number;
}

/** runtime event 이름(15 §8.3, transport.ts AGENT_RUNTIME_EVENTS와 동일). */
const RUNTIME_EVENT_NAMES = [
  "agent-runtime-message",
  "agent-runtime-stderr",
  "agent-runtime-exit",
  "agent-runtime-error",
  "agent-runtime-backpressure",
] as const;

/** 세션 1개의 Codex 런타임 상태(어댑터 내부, transcript store 아님). */
interface CodexSessionRuntime {
  runtimeId: RuntimeId;
  routing: CodexRouting;
  /** 우리가 보낸 request의 pending(id → resolve/reject). */
  pendingRpc: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** subscribeEvents 구독자. */
  listeners: Set<(e: AgentEvent) => void>;
  /** 구독 전 emit된 이벤트 버퍼(구독 시 flush). lifecycle 이벤트 유실 방지. */
  deferred: AgentEvent[];
  unlistens: UnlistenFn[];
  /** 멱등 종료 가드(04 §5). */
  closed: boolean;
}

/** thread/start·thread/resume·thread/read response의 공통 부분(thread 보유). */
interface ThreadResponse {
  thread: Thread;
}

/**
 * Codex app-server 어댑터를 만든다(AgentRuntimePort 구현).
 * @param deps transport/listen/id 생성기 DI.
 */
export function createCodexAppServerAdapter(deps: CodexAdapterDeps): AgentRuntimePort {
  const sessions = new Map<AgentSessionHandle, CodexSessionRuntime>();
  // 세션 생성 전(subscribe-before-start) 등록된 listener를 보관했다 attachSession 시 attach한다(New-F2).
  const pendingListeners = new Map<AgentSessionHandle, Set<(e: AgentEvent) => void>>();

  /** sessions에 등록하며 pre-registered listener(구독을 먼저 한 controller)를 attach한다. */
  function attachSession(handle: AgentSessionHandle, rt: CodexSessionRuntime): void {
    sessions.set(handle, rt);
    const pre = pendingListeners.get(handle);
    if (pre) {
      for (const l of pre) rt.listeners.add(l);
      pendingListeners.delete(handle);
    }
  }

  /**
   * 세션 listener들에게 AgentEvent를 emit한다. 구독자가 없으면 버퍼링했다가
   * subscribeEvents 시 flush한다(lifecycle 이벤트가 구독 전 유실되지 않도록).
   */
  function emitToListeners(rt: CodexSessionRuntime, e: AgentEvent): void {
    if (rt.listeners.size === 0) {
      rt.deferred.push(e);
      return;
    }
    for (const l of rt.listeners) l(e);
  }

  /** JSON-RPC request 전송 + pending 매칭(§3.1). result→resolve, error→reject(H3). */
  function rpcRequest(rt: CodexSessionRuntime, method: string, params?: unknown): Promise<unknown> {
    const id = deps.nextRpcId();
    return new Promise<unknown>((resolve, reject) => {
      rt.pendingRpc.set(id, { resolve, reject });
      // Codex envelope: jsonrpc 필드 생략(ref-codex §1.2).
      void deps.send(rt.runtimeId, { id, method, params } as JsonRpcMessage).catch((err) => {
        rt.pendingRpc.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** notification 전송(id 없음, ref-codex §1.2). */
  function sendNotification(rt: CodexSessionRuntime, method: string, params?: unknown): void {
    void deps.send(rt.runtimeId, { method, params } as JsonRpcMessage);
  }

  /** pending RPC 매칭(§3.1): result→resolve, error→reject. 미매칭 id는 무시. */
  function resolveRpc(rt: CodexSessionRuntime, msg: JsonRpcMessage): void {
    const rawId = (msg as { id?: unknown }).id;
    if (typeof rawId !== "number") return; // 우리는 number id만 발급
    const p = rt.pendingRpc.get(rawId);
    if (!p) return; // 미매칭(이미 닫힘 등) → 무시
    rt.pendingRpc.delete(rawId);
    if ("error" in msg) p.reject(toRpcError(msg.error));
    else if ("result" in msg) p.resolve(msg.result);
  }

  /** JSON-RPC error 객체를 Error로 변환. */
  function toRpcError(error: unknown): Error {
    const e = error as { code?: number; message?: string } | undefined;
    return new Error(e?.message ?? "JSON-RPC error");
  }

  /** inbound message 분기(§3.2). response/request/notification 구분. */
  function handleMessage(rt: CodexSessionRuntime, msg: JsonRpcMessage): void {
    // response: id + (result|error)
    if (("result" in msg || "error" in msg) && "id" in msg) {
      resolveRpc(rt, msg);
      return;
    }
    // server→client request: id + method(approval 등)
    if ("id" in msg && "method" in msg && (msg as { id?: unknown }).id != null) {
      const reqMsg = msg as { id: string | number; method: string; params?: unknown };
      const r = mapCodexServerRequest(reqMsg.method, reqMsg.id, reqMsg.params, rt.routing);
      // 미지원 request는 wire 응답을 **반드시** 보낸다(RD-10, deadlock 방지).
      if (r.reply) {
        if (r.reply.kind === "error") {
          // JSON-RPC error(-32601 method not found). 원본 id 타입 보존(R3).
          void deps.send(rt.runtimeId, {
            id: r.reply.id,
            error: { code: -32601, message: "method not found", data: { method: r.reply.method } },
          } as JsonRpcMessage);
        } else {
          // permissions 자동 decline({permissions:{},scope:"turn"}). 원본 id 타입 보존(R3).
          void deps.send(rt.runtimeId, {
            id: r.reply.id,
            result: { permissions: {}, scope: "turn" },
          } as JsonRpcMessage);
        }
      }
      for (const e of r.events) emitToListeners(rt, e);
      return;
    }
    // server→client notification: method only(id 없음)
    if ("method" in msg) {
      const notif = msg as { method: string; params?: unknown };
      const events = mapCodexNotification(notif.method, notif.params, rt.routing);
      for (const e of events) emitToListeners(rt, e);
    }
  }

  /** runtime event 처리(§3.2). runtimeId 필터 후 종류별 분기. */
  function onRuntimeEvent(rt: CodexSessionRuntime, payload: AgentRuntimeEvent): void {
    if (payload.runtimeId !== rt.runtimeId) return; // 멀티플렉싱 필터
    switch (payload.type) {
      case "message":
        handleMessage(rt, payload.message);
        break;
      case "stderr":
        // diagnostic only(transcript 비표시, 07 §Framing).
        break;
      case "exit":
        handleExit(rt, payload.code, payload.signal);
        break;
      case "error":
        emitToListeners(rt, {
          type: "error",
          ref: { provider: "codex" },
          message: payload.message,
          recoverable: payload.recoverable,
        });
        break;
      case "backpressure":
        emitToListeners(rt, {
          type: "error",
          ref: { provider: "codex" },
          message: "agentRuntime.errors.backpressure",
          recoverable: true,
        });
        break;
    }
  }

  /** 모든 runtime event 채널을 구독한다(start/resume에서 호출). */
  async function bindListeners(rt: CodexSessionRuntime): Promise<void> {
    for (const name of RUNTIME_EVENT_NAMES) {
      const un = await deps.listenRuntime(name, (e) => onRuntimeEvent(rt, e.payload));
      rt.unlistens.push(un);
    }
  }

  /** initialize→initialized 핸드셰이크(§2.3, OQ-07 항상 수행). */
  async function handshake(rt: CodexSessionRuntime): Promise<void> {
    await rpcRequest(rt, "initialize", {
      clientInfo: { name: "clcomx", version: deps.appVersion },
      capabilities: null, // 보수적(experimental 표면 미opt-in, OQ-11)
    });
    sendNotification(rt, "initialized"); // params 없음(ref-codex §2.2)
  }

  /** Thread.turns[].items[]를 AgentEvent로 재생한다(§5.4 replay). */
  function replayThread(rt: CodexSessionRuntime, thread: Thread): void {
    for (const turn of thread.turns ?? []) {
      for (const item of turn.items ?? []) {
        for (const e of mapItemCompleted(item, thread.id, turn.id)) emitToListeners(rt, e);
      }
    }
  }

  // ───────────────────────── pending 종료(§9, S3) ─────────────────────────

  /**
   * exit/shutdown 공용 pending 종료 루틴(S3 정본, 04 §5·§4.2). 정확히 한 번·멱등.
   * - reason="shutdown": process 살아 있음 → cancelled 응답을 wire로 best-effort 송신 후 내부 종료.
   * - reason="exit": process 사망 → wire 미전송, 내부 전용 failed만.
   */
  function closePending(rt: CodexSessionRuntime, reason: "exit" | "shutdown"): void {
    const outcome: ApprovalDecision["outcome"] = reason === "shutdown" ? "cancelled" : "failed";
    for (const reqId of rt.routing.allPendingApprovalIds()) {
      const pending = rt.routing.resolveApproval(reqId);
      if (reason === "shutdown" && pending) {
        // best-effort cancelled wire 응답(§7.3와 동일: 원본 id 타입 복원, jsonrpc 없음).
        try {
          void deps.send(rt.runtimeId, {
            id: pending.rpcId,
            result: { decision: "cancel" },
          } as JsonRpcMessage);
        } catch {
          // 연결 사망 race면 무시 — 내부 종료가 권위.
        }
      }
      emitToListeners(rt, {
        type: "approval_resolved",
        ref: { provider: "codex", requestId: reqId },
        decision: { requestId: reqId, outcome },
      });
    }
    // pending RPC를 로컬 reject(응답이 영구히 안 오므로).
    for (const [, p] of rt.pendingRpc) p.reject(new Error(reason + ": runtime closing"));
    rt.pendingRpc.clear();
  }

  /** process exit 처리(§9). 공용 closePending + process_exited emit. */
  function handleExit(rt: CodexSessionRuntime, code?: number, signal?: string): void {
    if (rt.closed) return; // 멱등(이미 닫힘이면 no-op)
    closePending(rt, "exit");
    rt.closed = true;
    emitToListeners(rt, { type: "process_exited", ref: { provider: "codex" }, code, signal });
  }

  // ───────────────────────── Port 구현 ─────────────────────────

  /** 새 세션: process→initialize→initialized→thread/start(§2.3). */
  async function startSession(params: StartSessionParams): Promise<SessionStartResult> {
    const runtimeId = await deps.start({
      transportKind: "jsonrpc-stdio",
      provider: "codex",
      distro: params.distro,
      workDir: params.workDir,
      args: ["app-server", "--stdio"],
    });
    const rt: CodexSessionRuntime = {
      runtimeId,
      routing: new CodexRouting(),
      pendingRpc: new Map(),
      listeners: new Set(),
      deferred: [],
      unlistens: [],
      closed: false,
    };
    attachSession(params.sessionHandle, rt);
    await bindListeners(rt);
    // process 떴지만 initialize 전(04 §2.1).
    emitToListeners(rt, { type: "session_status_changed", ref: { provider: "codex" }, status: "starting" });

    await handshake(rt);
    const startResp = (await rpcRequest(rt, "thread/start", { cwd: params.workDir })) as ThreadResponse;
    const thread = startResp.thread;
    rt.routing.ensureThread(thread.id, thread.sessionId);
    rt.routing.bindHandle(params.sessionHandle, thread.id);
    rt.routing.markStarted(thread.id); // response 권위 → thread/started notification 멱등(§2.3)

    const ref = { provider: "codex" as const, threadId: thread.id, sessionId: thread.sessionId };
    emitToListeners(rt, { type: "session_started", ref, cwd: thread.cwd });
    emitToListeners(rt, { type: "session_status_changed", ref, status: "ready" });
    return { ref };
  }

  /** 기존 세션 재개(§2.5). replay면 thread/read, 아니면 thread/resume. */
  async function resumeSession(params: ResumeSessionParams): Promise<SessionStartResult> {
    const runtimeId = await deps.start({
      transportKind: "jsonrpc-stdio",
      provider: "codex",
      distro: params.distro,
      workDir: params.workDir,
      args: ["app-server", "--stdio"],
    });
    const rt: CodexSessionRuntime = {
      runtimeId,
      routing: new CodexRouting(),
      pendingRpc: new Map(),
      listeners: new Set(),
      deferred: [],
      unlistens: [],
      closed: false,
    };
    attachSession(params.sessionHandle, rt);
    await bindListeners(rt);
    emitToListeners(rt, { type: "session_status_changed", ref: { provider: "codex" }, status: "starting" });

    await handshake(rt);

    let thread: Thread;
    if (params.replay) {
      const readResp = (await rpcRequest(rt, "thread/read", {
        threadId: params.providerThreadId,
        includeTurns: true,
      })) as ThreadResponse;
      thread = readResp.thread;
    } else {
      const resumeResp = (await rpcRequest(rt, "thread/resume", {
        threadId: params.providerThreadId,
      })) as ThreadResponse;
      thread = resumeResp.thread;
    }
    rt.routing.ensureThread(thread.id, thread.sessionId);
    rt.routing.bindHandle(params.sessionHandle, thread.id);
    rt.routing.markStarted(thread.id);

    const ref = { provider: "codex" as const, threadId: thread.id, sessionId: thread.sessionId };
    emitToListeners(rt, { type: "session_loaded", ref });
    if (params.replay) replayThread(rt, thread);
    emitToListeners(rt, { type: "session_status_changed", ref, status: "ready" });
    return { ref };
  }

  /** turn 시작(§2.4). makeTextUserInput으로 outbound content 변환. */
  async function sendPrompt(handle: AgentSessionHandle, input: SendPromptInput): Promise<void> {
    const rt = sessions.get(handle);
    if (!rt) throw new Error("codex adapter: unknown session handle");
    const threadId = rt.routing.threadIdOf(handle);
    if (threadId === undefined) throw new Error("codex adapter: session not ready (no threadId)");

    const codexInput = mapAgentContentToUserInput(input.content);
    // v1: threadId/input만 전송, override 미설정(OQ-20).
    let resp: { turn: { id: string } };
    try {
      resp = (await rpcRequest(rt, "turn/start", { threadId, input: codexInput })) as {
        turn: { id: string };
      };
    } catch (err) {
      // H3: turn/start error → setActiveTurn/running 전이 전이라 롤백 대상 없음. error+ready 복원(04 §5).
      const message = err instanceof Error ? err.message : String(err);
      emitToListeners(rt, { type: "error", ref: { provider: "codex", threadId }, message, recoverable: true });
      emitToListeners(rt, { type: "session_status_changed", ref: { provider: "codex", threadId }, status: "ready" });
      return;
    }
    rt.routing.setActiveTurn(threadId, resp.turn.id);
    // running 전이는 turn/started notification 또는 resp 둘 중 먼저(멱등). 여기서 명시 emit.
    emitToListeners(rt, {
      type: "session_status_changed",
      ref: { provider: "codex", threadId, turnId: resp.turn.id },
      status: "running",
    });
  }

  /** turn 취소(§7.3). 순서: closing 표시→approval cancelled 먼저→turn/interrupt 나중→늦은 응답 멱등 무시. */
  async function cancelTurn(handle: AgentSessionHandle, turnId?: string): Promise<void> {
    const rt = sessions.get(handle);
    if (!rt) return;
    const threadId = rt.routing.threadIdOf(handle);
    if (threadId === undefined) return;
    const tid = turnId ?? rt.routing.activeTurnOf(threadId);
    if (tid === undefined) return;

    // (1) 04 §4.2: 이 turn의 pending approval을 원자적으로 closing 표시(이중 응답 방지).
    const reqIds = rt.routing.markTurnApprovalsClosing(threadId, tid);

    // (2) 04 §4.2 규칙1: 각 pending approval에 cancelled 응답을 wire로 **먼저** 보낸다(interrupt 전).
    for (const reqId of reqIds) {
      const pending = rt.routing.resolveApproval(reqId);
      if (!pending) continue;
      // 원본 JSON-RPC id 타입 복원(§6, ref-codex §4.1).
      await deps.send(rt.runtimeId, {
        id: pending.rpcId,
        result: { decision: "cancel" },
      } as JsonRpcMessage);
      emitToListeners(rt, {
        type: "approval_resolved",
        ref: { provider: "codex", threadId, turnId: tid, requestId: reqId },
        decision: { requestId: reqId, outcome: "cancelled" },
      });
    }

    // (3) 04 §4.2: 그 다음 provider turn cancel(turn/interrupt). D5: adapter가 직접 wire 전송.
    await rpcRequest(rt, "turn/interrupt", { threadId, turnId: tid });
    // (4) 늦은 serverRequest/resolved·turn/completed는 hasPendingApproval=false라 멱등 무시(§5.2).
  }

  /** approval 응답(§7.2). decision→Codex decision 매핑 후 wire 송신. */
  async function respondApproval(
    handle: AgentSessionHandle,
    decision: ApprovalDecision,
  ): Promise<void> {
    const rt = sessions.get(handle);
    if (!rt) return;
    // peek만 한다(삭제는 wire 성공 후, New-F1). wire 실패 시 pending을 유지해야 재시도·shutdown cancel이 가능하다.
    const pending = rt.routing.getPendingApproval(decision.requestId);
    if (!pending) return; // 이미 닫힘 → no-op
    if (decision.outcome === "failed") return; // 04 §4.2 규칙4: wire 미전송

    let codexDecision: string;
    if (decision.outcome === "cancelled") {
      codexDecision = "cancel";
    } else {
      // "selected": optionId가 곧 option kind(commandApprovalOptions의 id=kind).
      codexDecision = OPTION_KIND_TO_DECISION[decision.optionId ?? "reject_once"] ?? "decline";
    }
    // 원본 JSON-RPC id 타입 복원(§6). jsonrpc 필드 없음(ref-codex §4.1). 실패 시 throw로 pending 유지.
    await deps.send(rt.runtimeId, {
      id: pending.rpcId,
      result: { decision: codexDecision },
    } as JsonRpcMessage);
    // wire 성공 후에만 삭제 + emit(turnId/itemId 보존 → store seal 정합).
    rt.routing.resolveApproval(decision.requestId);
    emitToListeners(rt, {
      type: "approval_resolved",
      ref: {
        provider: "codex",
        threadId: pending.threadId,
        turnId: pending.turnId,
        itemId: pending.itemId,
        requestId: decision.requestId,
      },
      decision,
    });
  }

  /** 세션 이벤트 구독(§3.2). 반환 UnlistenFn으로 해제. */
  function subscribeEvents(
    handle: AgentSessionHandle,
    listener: (e: AgentEvent) => void,
  ): UnlistenFn {
    const rt = sessions.get(handle);
    if (!rt) {
      // 세션 미생성(subscribe-before-start) — pending listener로 보관했다 attachSession 시 attach(New-F2).
      // 이로써 start/replay 중 emit되는 event가 곧장 store로 흘러 unbounded 버퍼링을 피한다.
      let pre = pendingListeners.get(handle);
      if (!pre) {
        pre = new Set();
        pendingListeners.set(handle, pre);
      }
      pre.add(listener);
      return () => {
        pendingListeners.get(handle)?.delete(listener);
        // 이미 attach됐을 수 있으니 세션 listener에서도 제거.
        sessions.get(handle)?.listeners.delete(listener);
      };
    }
    rt.listeners.add(listener);
    // deferred 큐가 있으면 flush(starting/session_started 등 구독 전 emit분).
    if (rt.deferred.length > 0) {
      const q = rt.deferred;
      rt.deferred = [];
      for (const e of q) listener(e);
    }
    return () => {
      rt.listeners.delete(listener);
    };
  }

  /** 세션 종료(§9, S3). (a) pending 닫기 → (b) backend shutdown await → (c) unlisten·삭제. */
  async function shutdown(handle: AgentSessionHandle): Promise<void> {
    const rt = sessions.get(handle);
    if (!rt || rt.closed) return; // 멱등
    // (a) shutdown 전에 pending 정리(process 살아 있으므로 cancelled wire 응답 best-effort).
    closePending(rt, "shutdown");
    // (b) graceful: backend가 stdin close→timeout→kill→child reap 후 반환.
    await deps.shutdown(rt.runtimeId);
    // (c) reap 이후에만 listener 해제·세션 삭제.
    for (const u of rt.unlistens) {
      try {
        u();
      } catch {
        // 이미 해제됨 가능.
      }
    }
    rt.closed = true;
    sessions.delete(handle);
  }


  return {
    startSession,
    resumeSession,
    sendPrompt,
    cancelTurn,
    respondApproval,
    subscribeEvents,
    shutdown,
  };
}

/** 기본 deps(프로덕션 transport 사용). 테스트는 createCodexAppServerAdapter에 모킹 주입. */
export function defaultCodexAdapterDeps(
  appVersion: string,
  listenRuntime: CodexAdapterDeps["listenRuntime"],
): CodexAdapterDeps {
  let counter = 0;
  return {
    start: agentRuntimeStart,
    send: agentRuntimeSend,
    cancel: agentRuntimeCancel,
    shutdown: agentRuntimeShutdown,
    listenRuntime,
    appVersion,
    nextRpcId: () => (counter += 1),
  };
}
