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
  ResourceSearchInput,
  ResourceSearchResult,
  StartSessionParams,
  ResumeSessionParams,
  SendPromptInput,
  SessionStartResult,
} from "../../contracts/runtime-port";
import type { AgentEvent, ApprovalDecision, ProviderRef, AgentModelOption, AgentEffortOption } from "../../contracts/normalized";
import type { UnlistenFn } from "../../../../tauri/event";
import type {
  RuntimeId,
  AgentRuntimeEvent,
  AgentRuntimeEventName,
  JsonRpcMessage,
} from "../../service/transport";
import {
  agentRuntimeStart,
  agentRuntimeSend,
  agentRuntimeCancel,
  agentRuntimeShutdown,
  AGENT_RUNTIME_EVENT_NAMES,
} from "../../service/transport";
import { CodexRouting } from "./codex-routing";
import {
  mapCodexNotification,
  mapCodexServerRequest,
  mapAgentContentToUserInput,
  OPTION_KIND_TO_DECISION,
} from "./codex-wire-mapper";
import { mapItemCompleted, formatCodexApprovalPolicy, formatCodexSandbox } from "./codex-wire-mapper";
import type { Thread } from "../../generated/codex-app-server/v2/Thread";
import type { FuzzyFileSearchResponse } from "../../generated/codex-app-server/FuzzyFileSearchResponse";
import type { FuzzyFileSearchResult } from "../../generated/codex-app-server/FuzzyFileSearchResult";
import type { SkillMetadata } from "../../generated/codex-app-server/v2/SkillMetadata";
import type { SkillsListResponse } from "../../generated/codex-app-server/v2/SkillsListResponse";

const CODEX_SKILL_MIME_TYPE = "application/vnd.codex.skill";

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
    event: AgentRuntimeEventName,
    h: (e: { payload: AgentRuntimeEvent }) => void,
  ) => Promise<UnlistenFn>;
  /** initialize ClientInfo.version. */
  appVersion: string;
  /** JSON-RPC request id 생성기(단조 증가). 테스트에서 결정적 주입. */
  nextRpcId: () => number;
}

/** 세션 1개의 Codex 런타임 상태(어댑터 내부, transcript store 아님). */
interface CodexSessionRuntime {
  /** CLCOMX 세션 handle. exit/error 같은 session-level event의 provider ref 재구성에 쓴다. */
  sessionHandle: AgentSessionHandle;
  runtimeId: RuntimeId;
  routing: CodexRouting;
  /** 우리가 보낸 request의 pending(id → resolve/reject). */
  pendingRpc: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** subscribeEvents 구독자. */
  listeners: Set<(e: AgentEvent) => void>;
  /** 구독 전 emit된 이벤트 버퍼(구독 시 flush). lifecycle 이벤트 유실 방지. */
  deferred: AgentEvent[];
  unlistens: UnlistenFn[];
  /** 멱등 종료 가드(04 §5) — backend reap/unlisten·세션 삭제 확정 상태. */
  closed: boolean;
  /**
   * teardown(shutdown/exit) 진행 표시(closed와 분리). in-flight respondApproval의 send가 stdin close로
   * 실패할 때 cleanup으로 인식하는 신호다. closed를 재사용하면 handleExit의 `if (rt.closed) return`이
   * 발동해 shutdown 중 process_exited가 누락된다(분리 필수).
   */
  tearingDown: boolean;
  /**
   * 다음 turn 이후에 적용할 model/effort override(②-B, 세션 메모리 범위). 3-state:
   * undefined=미설정(turn/start에 미포함, provider default), null=명시적 해제(`model:null`/`effort:null`을
   * turn/start에 실어 provider override를 revert), string=override 값.
   */
  turnModel?: string | null;
  turnEffort?: string | null;
  /**
   * 다음 turn 이후에 적용할 approvalPolicy override(②-C, 세션 메모리 범위). 3-state는 turnModel과 동일:
   * undefined=미설정(turn/start 미포함, provider default), null=명시적 해제(`approvalPolicy:null`을
   * turn/start에 실어 override revert), string=scalar `AskForApproval` 값(untrusted/on-failure/on-request/never).
   */
  turnApprovalPolicy?: string | null;
}

/** thread/start·thread/resume·thread/read response의 공통 부분(thread 보유). */
interface ThreadResponse {
  thread: Thread;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandbox?: unknown;
  /** thread/start·thread/resume 응답의 실제 current model/effort(②-B 초기 선택 권위). */
  model?: unknown;
  reasoningEffort?: unknown;
}

/** Codex thread start/resume response에서 UI 표시용 policy metadata를 추출한다. 포맷터는 wire-mapper와 공유. */
function buildCodexPolicyMetadata(
  resp: ThreadResponse,
): Pick<SessionStartResult, "sandbox" | "approvalPolicy" | "approvalsReviewer" | "model" | "effort"> {
  const sandbox = formatCodexSandbox(resp.sandbox);
  const approvalPolicy = formatCodexApprovalPolicy(resp.approvalPolicy);
  return {
    ...(sandbox ? { sandbox } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(typeof resp.approvalsReviewer === "string" ? { approvalsReviewer: resp.approvalsReviewer } : {}),
    // thread의 실제 current model/effort — 셀렉터 초기값을 catalog default가 아닌 이 권위 값에 맞춘다.
    ...(typeof resp.model === "string" && resp.model ? { model: resp.model } : {}),
    ...(typeof resp.reasoningEffort === "string" && resp.reasoningEffort
      ? { effort: resp.reasoningEffort }
      : {}),
  };
}

/** WSL path를 file URI로 변환한다. slash는 유지하고 segment만 percent-encoding한다. */
function toFileUri(wslPath: string): string {
  const path = wslPath.startsWith("/") ? wslPath : `/${wslPath}`;
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** provider fuzzy file result를 composer resource suggestion으로 정규화한다. */
function mapFuzzyFileResult(file: FuzzyFileSearchResult): ResourceSearchResult | null {
  const root = file.root.trim();
  const path = file.path.trim();
  const label = path || file.file_name.trim();
  if (!root || !label) return null;
  const absolutePath = `${root.replace(/\/+$/, "")}/${label.replace(/^\/+/, "")}`;
  return {
    label,
    uri: toFileUri(absolutePath),
    detail: absolutePath,
  };
}

/** Codex skill metadata에서 팔레트 보조 설명으로 쓸 짧은 설명을 고른다. */
function skillDetail(skill: SkillMetadata): string | undefined {
  return (
    skill.interface?.shortDescription?.trim() ||
    skill.shortDescription?.trim() ||
    skill.description.trim() ||
    undefined
  );
}

/** skills/list 결과가 현재 @query에 대응하는지 보수적으로 확인한다. */
function skillMatchesQuery(skill: SkillMetadata, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return [
    skill.name,
    skill.shortDescription ?? "",
    skill.interface?.shortDescription ?? "",
    skill.description,
  ].some((value) => value.toLowerCase().includes(q));
}

/** Codex skills/list metadata를 composer @mention 후보로 정규화한다. */
function mapSkillResult(skill: SkillMetadata, query: string): ResourceSearchResult | null {
  const name = skill.name.trim();
  const path = skill.path.trim();
  if (!skill.enabled || !name || !path || !skillMatchesQuery(skill, query)) return null;
  return {
    label: name,
    uri: toFileUri(path),
    detail: skillDetail(skill),
    mimeType: CODEX_SKILL_MIME_TYPE,
    text: name,
    resourceKind: "skill",
  };
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

  /** session-level Codex event에 붙일 현재 provider ref를 만든다. */
  function currentRuntimeRef(rt: CodexSessionRuntime): ProviderRef {
    const threadId = rt.routing.threadIdOf(rt.sessionHandle);
    if (threadId === undefined) return { provider: "codex" };
    const sessionId = rt.routing.sessionIdOf(threadId);
    return { provider: "codex", threadId, ...(sessionId !== undefined ? { sessionId } : {}) };
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
          ref: currentRuntimeRef(rt),
          message: payload.message,
          recoverable: payload.recoverable,
          code: payload.code,
        });
        break;
      case "backpressure":
        emitToListeners(rt, {
          type: "error",
          ref: currentRuntimeRef(rt),
          message: "agentRuntime.errors.backpressure",
          recoverable: true,
        });
        break;
    }
  }

  /** 모든 runtime event 채널을 구독한다(start/resume에서 호출). */
  async function bindListeners(rt: CodexSessionRuntime): Promise<void> {
    for (const name of AGENT_RUNTIME_EVENT_NAMES) {
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
  async function closePending(rt: CodexSessionRuntime, reason: "exit" | "shutdown"): Promise<void> {
    const outcome: ApprovalDecision["outcome"] = reason === "shutdown" ? "cancelled" : "failed";
    // "responding"(respondApproval in-flight)은 제외 — 그 경로가 단일 wire로 닫게 둔다(이중 wire 방지, New-F1).
    for (const reqId of rt.routing.pendingApprovalIdsForCleanup()) {
      const pending = rt.routing.resolveApproval(reqId);
      if (reason === "shutdown" && pending) {
        // best-effort cancelled wire 응답(§7.3와 동일: 원본 id 타입 복원, jsonrpc 없음).
        try {
          await deps.send(rt.runtimeId, {
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
        decidedBy: "cleanup",
      });
    }
    // pending RPC를 로컬 reject(응답이 영구히 안 오므로).
    for (const [, p] of rt.pendingRpc) p.reject(new Error(reason + ": runtime closing"));
    rt.pendingRpc.clear();
  }

  /** process exit 처리(§9). 공용 closePending + process_exited emit. */
  function handleExit(rt: CodexSessionRuntime, code?: number, signal?: string): void {
    if (rt.closed) return; // 멱등(이미 닫힘이면 no-op)
    rt.tearingDown = true; // in-flight respondApproval이 cleanup으로 인식하도록(exit 경로).
    void closePending(rt, "exit");
    rt.closed = true;
    emitToListeners(rt, { type: "process_exited", ref: currentRuntimeRef(rt), code, signal });
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
      sessionHandle: params.sessionHandle,
      routing: new CodexRouting(),
      pendingRpc: new Map(),
      listeners: new Set(),
      deferred: [],
      unlistens: [],
      closed: false,
      tearingDown: false,
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
    return { ref, canResume: true, canLoad: true, ...buildCodexPolicyMetadata(startResp) };
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
      sessionHandle: params.sessionHandle,
      routing: new CodexRouting(),
      pendingRpc: new Map(),
      listeners: new Set(),
      deferred: [],
      unlistens: [],
      closed: false,
      tearingDown: false,
    };
    attachSession(params.sessionHandle, rt);
    await bindListeners(rt);
    emitToListeners(rt, { type: "session_status_changed", ref: { provider: "codex" }, status: "starting" });

    await handshake(rt);

    let threadResp: ThreadResponse;
    if (params.replay) {
      threadResp = (await rpcRequest(rt, "thread/read", {
        threadId: params.providerThreadId,
        includeTurns: true,
      })) as ThreadResponse;
    } else {
      threadResp = (await rpcRequest(rt, "thread/resume", {
        threadId: params.providerThreadId,
      })) as ThreadResponse;
    }
    const thread = threadResp.thread;
    rt.routing.ensureThread(thread.id, thread.sessionId);
    rt.routing.bindHandle(params.sessionHandle, thread.id);
    rt.routing.markStarted(thread.id);

    const ref = { provider: "codex" as const, threadId: thread.id, sessionId: thread.sessionId };
    emitToListeners(rt, { type: "session_loaded", ref });
    if (params.replay) replayThread(rt, thread);
    emitToListeners(rt, { type: "session_status_changed", ref, status: "ready" });
    return { ref, canResume: true, canLoad: true, ...buildCodexPolicyMetadata(threadResp) };
  }

  /** turn 시작(§2.4). makeTextUserInput으로 outbound content 변환. */
  async function sendPrompt(handle: AgentSessionHandle, input: SendPromptInput): Promise<void> {
    const rt = sessions.get(handle);
    if (!rt) throw new Error("codex adapter: unknown session handle");
    const threadId = rt.routing.threadIdOf(handle);
    if (threadId === undefined) throw new Error("codex adapter: session not ready (no threadId)");

    const codexInput = mapAgentContentToUserInput(input.content);
    // 지원 가능한 입력이 하나도 없으면 빈 turn/start 대신 복구 가능한 오류로 낮춘다(CX-4c).
    if (codexInput.length === 0) {
      emitToListeners(rt, {
        type: "error",
        ref: { provider: "codex", threadId },
        message: "prompt content is not supported by this Codex session",
        recoverable: true,
      });
      return;
    }
    // model/effort/approvalPolicy override를 turn/start에 실어 이 turn 이후에 적용한다(②-B/②-C). 3-state:
    // undefined=미포함(provider default, OQ-20 기존 동작), null=명시적 해제(override revert),
    // string=값. null을 실어야 이전 turn override가 provider 쪽에 누수되지 않고 해제된다.
    const turnParams: {
      threadId: string;
      input: typeof codexInput;
      model?: string | null;
      effort?: string | null;
      approvalPolicy?: string | null;
    } = {
      threadId,
      input: codexInput,
    };
    if (rt.turnModel !== undefined) turnParams.model = rt.turnModel;
    if (rt.turnEffort !== undefined) turnParams.effort = rt.turnEffort;
    if (rt.turnApprovalPolicy !== undefined) turnParams.approvalPolicy = rt.turnApprovalPolicy;
    let resp: { turn: { id: string } };
    try {
      resp = (await rpcRequest(rt, "turn/start", turnParams)) as {
        turn: { id: string };
      };
    } catch (err) {
      // H3: turn/start error → 이 turn은 setActiveTurn 전이라 롤백 대상 없음. error는 항상 알린다.
      const message = err instanceof Error ? err.message : String(err);
      emitToListeners(rt, { type: "error", ref: { provider: "codex", threadId }, message, recoverable: true });
      // 단 다른 turn이 이미 active(겹친 submit 중 하나가 먼저 성공)면 ready로 되돌리지 않는다 — running 중인
      // turn을 ready로 덮으면 UI가 stop 버튼·turn 옵션 잠금을 잘못 풀 수 있다(Codex high 17차). active turn이
      // 없을 때만 ready 복원(04 §5).
      if (rt.routing.activeTurnOf(threadId) === undefined) {
        emitToListeners(rt, { type: "session_status_changed", ref: { provider: "codex", threadId }, status: "ready" });
      }
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

  /** Codex fuzzyFileSearch를 composer @mention 후보로 노출한다(OQ-56). */
  async function searchResources(
    handle: AgentSessionHandle,
    input: ResourceSearchInput,
  ): Promise<ResourceSearchResult[]> {
    const rt = sessions.get(handle);
    if (!rt || rt.closed) return [];
    const query = input.query.trim();
    const workDir = input.workDir.trim();
    if (!query || !workDir) return [];
    const limit = input.limit ?? 8;
    const results: ResourceSearchResult[] = [];
    const seen = new Set<string>();

    const [fileSearch, skillSearch] = await Promise.allSettled([
      rpcRequest(rt, "fuzzyFileSearch", {
        query,
        roots: [workDir],
        cancellationToken: null,
      }) as Promise<FuzzyFileSearchResponse>,
      rpcRequest(rt, "skills/list", { cwds: [workDir] }) as Promise<SkillsListResponse>,
    ]);

    /** resource 후보를 중복 없이 limit까지 추가한다. */
    function addResult(result: ResourceSearchResult | null): void {
      if (!result || seen.has(result.uri) || results.length >= limit) return;
      seen.add(result.uri);
      results.push(result);
    }

    if (skillSearch.status === "fulfilled") {
      for (const entry of skillSearch.value.data ?? []) {
        for (const skill of entry.skills ?? []) {
          addResult(mapSkillResult(skill, query));
          if (results.length >= limit) return results;
        }
      }
    }

    if (fileSearch.status === "fulfilled") {
      for (const file of fileSearch.value.files ?? []) {
        addResult(mapFuzzyFileResult(file));
        if (results.length >= limit) return results;
      }
    }
    return results;
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
        decidedBy: "cleanup",
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
    if (decision.outcome === "failed") return; // 04 §4.2 규칙4: wire 미전송
    const current = rt.routing.getPendingApproval(decision.requestId);
    if (!current || current.state !== "pending") return;
    if (decision.outcome === "selected" && !(decision.optionId && decision.optionId in OPTION_KIND_TO_DECISION)) {
      throw new Error(`unknown approval optionId: ${decision.optionId ?? "<missing>"}`);
    }
    // pending을 원자적으로 선점한다(New-F1 race): send await 동안 cancelTurn/serverRequest-resolved가
    // 같은 pending을 닫지 못하게 "responding"으로 표시. 이미 닫힘/응답중/cleanup 중이면 no-op(멱등).
    const pending = rt.routing.claimForResponse(decision.requestId);
    if (!pending) return;

    let codexDecision: string;
    if (decision.outcome === "cancelled") {
      codexDecision = "cancel";
    } else {
      // "selected": optionId가 곧 option kind(commandApprovalOptions의 id=kind).
      codexDecision = OPTION_KIND_TO_DECISION[decision.optionId ?? "reject_once"] ?? "decline";
    }
    // 원본 JSON-RPC id 타입 복원(§6). jsonrpc 필드 없음(ref-codex §4.1).
    try {
      await deps.send(rt.runtimeId, {
        id: pending.rpcId,
        result: { decision: codexDecision },
      } as JsonRpcMessage);
    } catch (err) {
      if (rt.tearingDown) {
        // teardown(shutdown/exit) 중 send 실패(stdin closed 등): closePending이 responding을
        // 건너뛰었으므로 여기서 cleanup outcome(failed, wire 미전송)으로 닫아 종료 이벤트 누락을 막는다.
        // throw하지 않는다 — teardown 중 실패는 정상이며 approve Promise의 unhandled rejection을 막는다.
        const cleaned = rt.routing.resolveApproval(decision.requestId);
        if (cleaned) {
          emitToListeners(rt, {
            type: "approval_resolved",
            ref: {
              provider: "codex",
              threadId: cleaned.threadId,
              turnId: cleaned.turnId,
              itemId: cleaned.itemId,
              requestId: decision.requestId,
            },
            decision: { requestId: decision.requestId, outcome: "failed" },
            decidedBy: "cleanup",
          });
        }
        return;
      }
      // 일반 wire 실패 → 선점 복구(pending) 후 throw — 재시도·cleanup 재대상화 가능.
      rt.routing.revertResponse(decision.requestId);
      throw err;
    }
    // 내가 선점한 항목만 삭제(closePending이 teardown으로 먼저 지웠으면 undefined → 이중 emit 방지).
    const removed = rt.routing.resolveApproval(decision.requestId);
    if (removed) {
      emitToListeners(rt, {
        type: "approval_resolved",
        ref: {
          provider: "codex",
          threadId: removed.threadId,
          turnId: removed.turnId,
          itemId: removed.itemId,
          requestId: decision.requestId,
        },
        decision,
      });
    }
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
    // teardown 시작 표시(New-F1): in-flight respondApproval의 send가 stdin close로 실패할 때
    // 이 플래그로 teardown을 감지해 cleanup outcome으로 닫는다(revert+throw 대신). closed와 분리해
    // shutdown 중 handleExit의 `if (rt.closed) return`이 process_exited를 삼키지 않게 한다.
    rt.tearingDown = true;
    // (a) shutdown 전에 pending 정리(process 살아 있으므로 cancelled wire 응답 best-effort).
    await closePending(rt, "shutdown");
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


  /**
   * model/list — 사용 가능한 모델 + effort 후보를 비밀 아닌 표시 정보로 정규화한다(②-B).
   * `nextCursor`를 끝까지 따라가 **모든 페이지**를 수집한다 — 기본 모델(`isDefault`)이 뒤 페이지에
   * 있어도 초기 선택이 provider default와 어긋나지 않게 한다(Codex 리뷰). 무한 루프 방지로 페이지 수를 캡.
   */
  async function listModels(handle: AgentSessionHandle): Promise<AgentModelOption[]> {
    const rt = sessions.get(handle);
    if (!rt) throw new Error("codex adapter: unknown session handle");
    type RawModel = {
      id?: unknown;
      model?: unknown;
      displayName?: unknown;
      hidden?: unknown;
      isDefault?: unknown;
      supportedReasoningEfforts?: Array<{ reasoningEffort?: unknown; description?: unknown }>;
      defaultReasoningEffort?: unknown;
    };
    const models: AgentModelOption[] = [];
    let cursor: string | undefined;
    const MAX_PAGES = 20; // 방어적 상한(정상 카탈로그는 수 페이지 이내).
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const resp = (await rpcRequest(rt, "model/list", cursor ? { cursor } : {})) as {
        data?: RawModel[];
        nextCursor?: unknown;
      };
      for (const m of resp.data ?? []) {
        if (m.hidden === true) continue;
        const id =
          typeof m.id === "string" ? m.id : typeof m.model === "string" ? m.model : undefined;
        if (!id) continue;
        const label = typeof m.displayName === "string" && m.displayName.trim() ? m.displayName : id;
        const efforts: AgentEffortOption[] = [];
        for (const e of m.supportedReasoningEfforts ?? []) {
          if (typeof e.reasoningEffort === "string") {
            efforts.push({
              id: e.reasoningEffort,
              ...(typeof e.description === "string" ? { description: e.description } : {}),
            });
          }
        }
        models.push({
          id,
          label,
          efforts,
          ...(typeof m.defaultReasoningEffort === "string"
            ? { defaultEffort: m.defaultReasoningEffort }
            : {}),
          ...(m.isDefault === true ? { isDefault: true } : {}),
        });
      }
      cursor = typeof resp.nextCursor === "string" && resp.nextCursor ? resp.nextCursor : undefined;
      if (!cursor) break; // 마지막 페이지.
    }
    return models;
  }

  /** 다음 turn 이후에 적용할 model/effort/approvalPolicy override를 세션 메모리에 저장한다(②-B/②-C). null은 해제. */
  function setTurnOptions(
    handle: AgentSessionHandle,
    options: { model?: string | null; effort?: string | null; approvalPolicy?: string | null },
  ): void {
    const rt = sessions.get(handle);
    if (!rt) return;
    // null을 보존한다(3-state) — 다음 turn/start가 명시적 해제를 wire로 전달해 override를 revert한다.
    // 각 필드는 독립적으로 갱신한다 — 부분 업데이트가 서로를 clobber하지 않는다(Codex ②-C 지적).
    if (options.model !== undefined) rt.turnModel = options.model;
    if (options.effort !== undefined) rt.turnEffort = options.effort;
    if (options.approvalPolicy !== undefined) rt.turnApprovalPolicy = options.approvalPolicy;
  }

  return {
    startSession,
    resumeSession,
    sendPrompt,
    searchResources,
    cancelTurn,
    respondApproval,
    listModels,
    setTurnOptions,
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
