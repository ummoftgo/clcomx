/**
 * Claude ACP 어댑터 — AgentRuntimePort 구현(06 §3, §4).
 *
 * ACP wire(JSON-RPC 2.0) ↔ CLCOMX AgentEvent/ApprovalRequest 변환, lifecycle 메서드 호출,
 * session/update variant 변환, request_permission 응답, pending table 관리.
 *
 * 책임 경계(06 §1): 어댑터는 raw JsonRpcMessage를 transport(15 §8)로 주고받으며 AgentEvent를 만들어
 * listener로 전달한다. store를 직접 mutate하지 않는다(router/reducer 소관).
 */

import type {
  AgentContent,
  AgentEvent,
  AgentRuntimeMetadataUpdate,
  ApprovalDecision,
  ProviderRef,
  TokenUsage,
} from "../../contracts/normalized";
import type {
  AgentRuntimePort,
  AgentSessionHandle,
  ResourceSearchInput,
  ResourceSearchResult,
  ResumeSessionParams,
  SendPromptInput,
  SessionStartResult,
  StartSessionParams,
} from "../../contracts/runtime-port";
import type {
  AcpSessionMode,
  AcpSessionModeState,
  ClaudeAcpAdapterDeps,
  ParsedInitialize,
  PendingApproval,
  PendingRequest,
} from "../../contracts/claude-acp";
import type {
  AgentRuntimeEvent,
  JsonRpcMessage,
  RuntimeId,
} from "../../service/transport";
import type { UnlistenFn } from "../../../../tauri/event";

import { buildInitializeRequest, InitializeProtocolError, parseInitializeResponse } from "./claude-acp-initialize";
import { mapSessionUpdate, type SessionUpdateRuntime } from "./claude-acp-session-update";
import { buildPermissionResponse, mapRequestPermission } from "./claude-acp-permission";
import { toAcpPromptContent } from "./claude-acp-content";
import { AdapterError, resolveRpc } from "./claude-acp-pending";
import { buildClaudeAcpLaunchParams } from "./claude-acp-launch";
import { mapClaudeStopReason } from "./claude-acp-stop-reason";
import { extractModeConfigValue } from "./claude-acp-mode";

/** Claude ACP 세션 런타임 상태(04 §1 라우팅 키 + pending + update 상태). */
interface ClaudeAcpSessionRuntime extends SessionUpdateRuntime {
  sessionHandle: AgentSessionHandle;
  runtimeId: RuntimeId;
  providerSessionId?: string;
  caps?: ParsedInitialize;
  /**
   * set_mode RPC는 성공했으나 provider의 권위 echo(current_mode_update)가 아직 안 온 "요청된 모드".
   * 이 창에서 도착한 승인 요청은 currentModeId(구값)뿐 아니라 이 pending 값으로도 severity를 보수적으로
   * 판정한다 — 고위험 모드 전환 직후 승인이 normal로 새는 것을 fail-safe로 막는다. echo가 오면 해제한다.
   */
  pendingRequestedMode?: string;
  /** turnId 합성 카운터(04 §turn id 합성). */
  turnSeq: number;
  activeTurnId?: string;
  /** client→agent 요청 응답 매칭. */
  pendingRequests: Map<string | number, PendingRequest>;
  /** agent→client request_permission. key=String(rpcId). */
  pendingApprovals: Map<string, PendingApproval>;
  /** session/load replay 진행 플래그(§3.5). */
  loadingReplay: boolean;
  /** session/update 상태. */
  currentMessageId?: string;
  currentModeId?: string;
  unknownCounter: number;
  lastUsage?: TokenUsage;
  /** mode/config 보관(§8). */
  modes?: AcpSessionModeState;
  configOptions?: unknown[];
  /** event listener(subscribeEvents). */
  listeners: Set<(e: AgentEvent) => void>;
  /** 구독 전 emit된 lifecycle 이벤트 버퍼(구독 시 flush). Codex deferred와 동형(Finding 1). */
  deferred: AgentEvent[];
  /** transport 구독 해제. */
  unlisten?: UnlistenFn;
  /** 세션이 닫히는 중(shutdown/exit). 늦은 정리 멱등화. */
  closed: boolean;
  /** teardown(shutdown/exit) 진행 표시(closed와 분리). in-flight respondApproval의 send 실패를
   *  cleanup으로 인식하는 신호(exit 경로도 포함 — closed만으론 exit catch가 안 잡힘). */
  tearingDown: boolean;
}

/** 미지원 ACP request/notification 원본 payload 보관 — transcript event 없이 진단 표면에 남긴다. */
const claudeAcpUnknownNotificationRawPayloads: unknown[] = [];
/** 미지원 ACP request/notification 누계 — silent drop이 아님을 검증하는 진단 카운터다. */
let claudeAcpUnknownNotificationCount = 0;

/** 미지원 ACP request/notification raw payload 누계(진단/테스트용). */
export function getClaudeAcpUnknownNotificationRawPayloads(): readonly unknown[] {
  return claudeAcpUnknownNotificationRawPayloads;
}

/** 미지원 ACP request/notification 카운터(진단/테스트용). */
export function getClaudeAcpUnknownNotificationCount(): number {
  return claudeAcpUnknownNotificationCount;
}

/** 미지원 ACP request/notification 진단 상태를 리셋한다(테스트 격리용). */
export function resetClaudeAcpUnknownNotifications(): void {
  claudeAcpUnknownNotificationCount = 0;
  claudeAcpUnknownNotificationRawPayloads.length = 0;
}

/** 모듈 단위 unknown payload 진단 로그에 원본을 보존한다. */
function recordClaudeAcpUnknownPayload(raw: unknown): void {
  claudeAcpUnknownNotificationCount += 1;
  claudeAcpUnknownNotificationRawPayloads.push(raw);
}

/** runtime-local counter/raw와 모듈 진단 로그를 함께 갱신한다. */
function recordUnknownAdapterPayload(rt: ClaudeAcpSessionRuntime, raw: unknown): void {
  rt.unknownCounter += 1;
  if (!rt.unknownRaw) rt.unknownRaw = [];
  rt.unknownRaw.push(raw);
  recordClaudeAcpUnknownPayload(raw);
}

/**
 * Claude ACP 어댑터 생성. deps(transport client + resolve + id 발급)를 받아 AgentRuntimePort를 돌려준다.
 */
export function createClaudeAcpAdapter(deps: ClaudeAcpAdapterDeps): AgentRuntimePort {
  /** sessionHandle → 런타임 상태. */
  const sessions = new Map<AgentSessionHandle, ClaudeAcpSessionRuntime>();
  // 세션 생성 전(subscribe-before-start) 등록된 listener를 보관했다 createRuntime 시 attach한다(New-F2).
  const pendingListeners = new Map<AgentSessionHandle, Set<(e: AgentEvent) => void>>();

  /** handle로 런타임 조회(없으면 throw). */
  function byHandle(handle: AgentSessionHandle): ClaudeAcpSessionRuntime {
    const rt = sessions.get(handle);
    if (!rt) throw new AdapterError(`unknown session handle: ${handle}`);
    return rt;
  }

  /** 런타임의 모든 listener에 event emit. 구독자가 없으면 deferred에 버퍼링(구독 시 flush). */
  function emit(rt: ClaudeAcpSessionRuntime, event: AgentEvent): void {
    if (rt.listeners.size === 0) {
      rt.deferred.push(event);
      return;
    }
    for (const l of rt.listeners) l(event);
  }

  /** 라우팅용 ProviderRef(message-level). */
  function refFor(rt: ClaudeAcpSessionRuntime): ProviderRef {
    return { provider: "claude", sessionId: rt.providerSessionId, turnId: rt.activeTurnId };
  }

  /** ACP promptCapabilities에 맞춰 composer content를 전송 가능한 항목으로 제한한다(08 §6.4). */
  function filterPromptContentForCapabilities(
    content: AgentContent[],
    caps: ParsedInitialize | undefined,
  ): AgentContent[] {
    return content.filter((item) => {
      if (item.type === "image") return caps?.promptImage === true;
      if (item.type === "resource") {
        // text가 있는 resource만 embedded context이며, link-only resource는 ACP baseline resource_link로 보낸다.
        return typeof item.text === "string" ? caps?.promptEmbeddedContext === true : true;
      }
      return true;
    });
  }

  // ───────────────────────── RPC 헬퍼(§3.1a) ─────────────────────────

  /** id 있는 client→agent request 전송 + 응답 await(pendingRequests 매칭). */
  function rpcRequest(rt: ClaudeAcpSessionRuntime, method: string, params: unknown): Promise<unknown> {
    const id = deps.nextRequestId();
    return new Promise<unknown>((resolve, reject) => {
      rt.pendingRequests.set(id, { resolve, reject, method });
      deps
        .sendMessage(rt.runtimeId, { jsonrpc: "2.0", id, method, params })
        .catch((err) => {
          // 송신 자체 실패 → pending 제거 후 reject.
          rt.pendingRequests.delete(id);
          reject(err);
        });
    });
  }

  /** id 없는 notification 전송(session/cancel 등). */
  function rpcNotify(rt: ClaudeAcpSessionRuntime, method: string, params?: unknown): Promise<void> {
    return deps.sendMessage(rt.runtimeId, { jsonrpc: "2.0", method, params });
  }

  // ───────────────────────── inbound message dispatch(§5, §6) ─────────────────────────

  /** agent-runtime-message로 도착한 raw JsonRpcMessage를 분류해 처리. */
  function handleMessage(rt: ClaudeAcpSessionRuntime, msg: JsonRpcMessage): void {
    // CL-26: ACP 메시지가 아니면(method/result/error 없음) framing error.
    if (!isAcpMessage(msg)) {
      emit(rt, {
        type: "error",
        ref: refFor(rt),
        message: "non-ACP JSON-RPC message received",
        recoverable: false,
      });
      return;
    }

    // response({id, result|error}) → pending request settle(§3.1a).
    if (("result" in msg || "error" in msg) && "id" in msg) {
      resolveRpc({ pendingRequests: rt.pendingRequests, pendingApprovals: rt.pendingApprovals }, msg);
      return;
    }

    // request({id, method}) → server→client request(§6).
    if ("id" in msg && "method" in msg && msg.id !== undefined) {
      handleServerRequest(rt, msg as JsonRpcMessage & { id: string | number; method: string });
      return;
    }

    // notification({method}, id 없음) → session/update 등(§5).
    if ("method" in msg) {
      handleNotification(rt, msg as { method: string; params?: unknown });
      return;
    }
  }

  /** server→client request 처리(§6.1, §6.4). 미지원 method는 JSON-RPC error 응답 필수(R5). */
  function handleServerRequest(rt: ClaudeAcpSessionRuntime, msg: JsonRpcMessage & { id: string | number; method: string }): void {
    switch (msg.method) {
      case "session/request_permission": {
        const { event, pending } = mapRequestPermission(rt, msg);
        // status → requires_action(client 합성, 04 §2.1 규칙 3).
        rt.pendingApprovals.set(String(pending.rpcId), pending);
        emit(rt, { type: "session_status_changed", ref: event.ref, status: "requires_action" });
        emit(rt, event);
        return;
      }
      default:
        // R5: 미지원 server request는 무응답 폐기 금지 — JSON-RPC error(-32601) 응답 필수.
        // id는 원본 JSON-RPC id 타입 보존(String화 금지, R3).
        recordUnknownAdapterPayload(rt, {
          id: msg.id,
          method: msg.method,
          params: "params" in msg ? msg.params : undefined,
        });
        void deps.sendMessage(rt.runtimeId, {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        });
        return;
    }
  }

  /** notification 처리(§5). session/update variant → AgentEvent. 미지원은 raw 보존+counter. */
  function handleNotification(rt: ClaudeAcpSessionRuntime, msg: { method: string; params?: unknown }): void {
    if (msg.method === "session/update") {
      const params = (msg.params ?? {}) as { update?: unknown };
      const update = params.update;
      if (!update || typeof update !== "object") {
        recordUnknownAdapterPayload(rt, { method: msg.method, params });
        return;
      }
      const rawStart = rt.unknownRaw?.length ?? 0;
      // 상태 보관이 필요한 variant를 먼저 반영한 뒤 mapper가 UI/metadata event를 만든다.
      stashSessionState(rt, update as { sessionUpdate?: string; configOptions?: unknown[] });
      const events = mapSessionUpdate(rt, update as Parameters<typeof mapSessionUpdate>[1]);
      for (const raw of (rt.unknownRaw ?? []).slice(rawStart)) {
        recordClaudeAcpUnknownPayload({ method: msg.method, params: { ...params, update: raw } });
      }
      const metadata = modeMetadataFromUpdate(
        rt,
        update as { sessionUpdate?: string; currentModeId?: unknown; configOptions?: unknown[] },
      );
      if (metadata) {
        emit(rt, { type: "runtime_metadata_changed", ref: refFor(rt), metadata });
      }
      for (const ev of events) emit(rt, ev);
      return;
    }
    // 그 외 notification은 미지원 → raw 보존 + counter(응답 불필요, 04 §5).
    recordUnknownAdapterPayload(rt, { method: msg.method, params: msg.params });
  }

  /** config_option_update 등 상태 보관(전용 event 없는 variant). */
  function stashSessionState(rt: ClaudeAcpSessionRuntime, update: { sessionUpdate?: string; configOptions?: unknown[] }): void {
    if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
      rt.configOptions = update.configOptions;
    }
  }

  /** severity 보수 판정에 쓰는 고위험 모드 판정(classifySeverity와 동일 기준). */
  function isHighRiskMode(mode: string | undefined): boolean {
    return mode === "bypassPermissions";
  }

  /**
   * provider 권위 echo 도착 시 pendingRequestedMode(echo 전 승인 보수 판정용)를 해제할지 결정한다.
   * echo가 요청 모드와 일치하면 확정됐으므로 해제한다. 비매칭 echo(이전/stale echo)는:
   * - 고위험(bypassPermissions) pending은 **유지**한다 — 요청한 고위험 모드의 실제 echo가 오기 전
   *   저위험 stale echo가 fail-safe를 조기에 풀어 승인이 normal로 새는 것을 막는다(Codex 6차).
   * - 저위험 pending은 해제해도 severity에 영향이 없으므로 해제한다.
   */
  function clearPendingModeOnEcho(rt: ClaudeAcpSessionRuntime, echoMode: string): void {
    if (rt.pendingRequestedMode === undefined) return;
    if (rt.pendingRequestedMode === echoMode || !isHighRiskMode(rt.pendingRequestedMode)) {
      rt.pendingRequestedMode = undefined;
    }
  }

  /** ACP session/update에서 metadata로 노출할 mode patch를 추출한다. */
  function modeMetadataFromUpdate(
    rt: ClaudeAcpSessionRuntime,
    update: { sessionUpdate?: string; currentModeId?: unknown; configOptions?: unknown[] },
  ): AgentRuntimeMetadataUpdate | undefined {
    if (update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") {
      clearPendingModeOnEcho(rt, update.currentModeId);
      rt.currentModeId = update.currentModeId;
      if (rt.modes) rt.modes = { ...rt.modes, currentModeId: update.currentModeId };
      return { sessionMode: update.currentModeId, permissionMode: update.currentModeId };
    }
    if (update.sessionUpdate === "config_option_update") {
      const mode = extractModeConfigValue(update.configOptions);
      if (mode) {
        clearPendingModeOnEcho(rt, mode);
        rt.currentModeId = mode;
        if (rt.modes) rt.modes = { ...rt.modes, currentModeId: mode };
        return { sessionMode: mode, permissionMode: mode };
      }
    }
    return undefined;
  }

  // ───────────────────────── 런타임 생성/구독 ─────────────────────────

  /** 세션 런타임 초기화 + transport 구독. */
  function createRuntime(handle: AgentSessionHandle, runtimeId: RuntimeId): ClaudeAcpSessionRuntime {
    const rt: ClaudeAcpSessionRuntime = {
      sessionHandle: handle,
      runtimeId,
      turnSeq: 0,
      pendingRequests: new Map(),
      pendingApprovals: new Map(),
      loadingReplay: false,
      unknownCounter: 0,
      listeners: new Set(),
      deferred: [],
      closed: false,
      tearingDown: false,
    };
    sessions.set(handle, rt);
    // pre-registered listener(구독을 먼저 한 controller)를 attach한다(New-F2).
    const pre = pendingListeners.get(handle);
    if (pre) {
      for (const l of pre) rt.listeners.add(l);
      pendingListeners.delete(handle);
    }
    // transport 구독: message/stderr/exit/error/backpressure.
    rt.unlisten = deps.subscribeRuntime(runtimeId, (e: AgentRuntimeEvent) => onRuntimeEvent(rt, e));
    return rt;
  }

  /** transport event → 어댑터 처리(§4.4, §9). */
  function onRuntimeEvent(rt: ClaudeAcpSessionRuntime, e: AgentRuntimeEvent): void {
    switch (e.type) {
      case "message":
        handleMessage(rt, e.message);
        return;
      case "exit":
        // process_exited emit + 남은 pending 정리(멱등, §4.4 (c)).
        if (rt.closed) return;
        rt.tearingDown = true; // in-flight respondApproval이 cleanup으로 인식하도록(exit 경로).
        rt.closed = true; // 중복 exit 이벤트와 reentrant shutdown을 한 번만 처리한다.
        emit(rt, { type: "process_exited", ref: refFor(rt), code: e.code, signal: e.signal });
        void closePending(rt);
        return;
      case "error":
        emit(rt, {
          type: "error",
          ref: refFor(rt),
          message: e.message,
          recoverable: e.recoverable,
          code: e.code,
        });
        return;
      case "stderr":
        // stderr는 log stream(transcript 비오염). 1차는 무시(진단은 backend 로그).
        return;
      case "backpressure":
        emit(rt, {
          type: "error",
          ref: refFor(rt),
          message: `backpressure: dropped ${e.droppedMessages} messages`,
          recoverable: true,
        });
        return;
    }
  }

  /**
   * 남은 pending approval/request 정리(멱등, §4.4 (a)/(c)).
   * - pending approval: closing 표시 안 된 것만 cancelled로 닫고 wire 응답(process 생존 시)·내부 emit.
   * - pending request: 로컬 reject.
   * exit 경로(process 사망)에서는 wire 송신 불가 → 내부 정리만.
   */
  async function closePending(rt: ClaudeAcpSessionRuntime, sendWire: boolean = false): Promise<void> {
    for (const [key, ap] of [...rt.pendingApprovals.entries()]) {
      if (ap.closing) continue; // 이미 닫는 중 → 멱등 무시.
      ap.closing = true;
      if (sendWire) {
        try {
          await deps.sendMessage(rt.runtimeId, buildPermissionResponse(ap.rpcId, { outcome: "cancelled" }));
        } catch {
          // shutdown 중 transport가 먼저 닫힌 경우 내부 cleanup이 권위다.
        }
      }
      emit(rt, {
        type: "approval_resolved",
        ref: ap.ref,
        decision: { requestId: String(ap.rpcId), outcome: sendWire ? "cancelled" : "failed" },
        decidedBy: "cleanup",
      });
      rt.pendingApprovals.delete(key);
    }
    for (const [id, pr] of [...rt.pendingRequests.entries()]) {
      rt.pendingRequests.delete(id);
      pr.reject(new AdapterError(`runtime closed before ${pr.method} response`));
    }
  }

  // ───────────────────────── Port 메서드 ─────────────────────────

  /** startSession: spawn → initialize → session/new(§3.2, §3.4). */
  async function startSession(params: StartSessionParams): Promise<SessionStartResult> {
    const resolved = await deps.resolveLaunch(params);
    const launchParams = buildClaudeAcpLaunchParams({
      distro: params.distro,
      workDir: params.workDir,
      adapterEntryPath: resolved.adapterEntryPath,
      env: resolved.env,
      allowSubscriptionAuth: resolved.allowSubscriptionAuth,
    });
    const runtimeId = await deps.startRuntime(launchParams);
    const rt = createRuntime(params.sessionHandle, runtimeId);

    try {
      // initialize(protocolVersion=1) → capability 협상(§3.2).
      const initResult = await rpcRequest(rt, "initialize", buildInitParams());
      rt.caps = parseInitializeResponse(initResult);

      // session/new(§3.4). cwd absolute MUST(§7.3).
      const newResult = (await rpcRequest(rt, "session/new", {
        cwd: params.workDir,
        mcpServers: [],
        additionalDirectories: [],
      })) as { sessionId: string; modes?: AcpSessionModeState; configOptions?: unknown[] };

      rt.providerSessionId = newResult.sessionId;
      applySessionResult(rt, newResult);
      // session_started + status→ready(15 §3, §13.1).
      const ref: ProviderRef = { provider: "claude", sessionId: rt.providerSessionId };
      emit(rt, { type: "session_started", ref, cwd: params.workDir });
      emit(rt, { type: "session_status_changed", ref, status: "ready" });
      return {
        ref,
        canResume: rt.caps.canResume,
        canLoad: rt.caps.canLoad,
        composerCapabilities: {
          image: rt.caps.promptImage,
          embeddedContext: rt.caps.promptEmbeddedContext,
          audio: false,
        },
        protocolVersion: String(rt.caps.protocolVersion),
        providerVersion: rt.caps.agentInfo?.version,
        ...currentModeMetadata(rt),
      };
    } catch (err) {
      // initialize/session 실패 → status→failed + protocol error 분류(§3.2 규칙 1, §9, fallback §10).
      failSession(rt, err);
      throw err;
    }
  }

  /** resumeSession: spawn → initialize → session/load|resume(§3.5). */
  async function resumeSession(params: ResumeSessionParams): Promise<SessionStartResult> {
    const resolved = await deps.resolveLaunch(params);
    const launchParams = buildClaudeAcpLaunchParams({
      distro: params.distro,
      workDir: params.workDir,
      adapterEntryPath: resolved.adapterEntryPath,
      env: resolved.env,
      allowSubscriptionAuth: resolved.allowSubscriptionAuth,
    });
    const runtimeId = await deps.startRuntime(launchParams);
    const rt = createRuntime(params.sessionHandle, runtimeId);

    try {
      const initResult = await rpcRequest(rt, "initialize", buildInitParams());
      rt.caps = parseInitializeResponse(initResult);
      rt.providerSessionId = params.providerSessionId;

      const base = {
        sessionId: params.providerSessionId,
        cwd: params.workDir,
        mcpServers: [],
        additionalDirectories: [],
      };
      let result: { modes?: AcpSessionModeState; configOptions?: unknown[] };
      if (params.replay) {
        // load: replay 진행 — 응답 전 update는 replay(§3.5). loadingReplay=true 켠 뒤 송신.
        if (!rt.caps.canLoad) throw new AdapterError("loadSession unsupported");
        rt.loadingReplay = true;
        result = (await rpcRequest(rt, "session/load", base)) as typeof result;
        // M2: load response resolve 경계에서 replay 종료 + session_loaded emit.
        rt.loadingReplay = false;
      } else {
        if (!rt.caps.canResume) throw new AdapterError("resume unsupported");
        result = (await rpcRequest(rt, "session/resume", base)) as typeof result;
      }
      applySessionResult(rt, result);
      const ref: ProviderRef = { provider: "claude", sessionId: rt.providerSessionId };
      emit(rt, { type: "session_loaded", ref });
      emit(rt, { type: "session_status_changed", ref, status: "ready" });
      return {
        ref,
        canResume: rt.caps.canResume,
        canLoad: rt.caps.canLoad,
        composerCapabilities: {
          image: rt.caps.promptImage,
          embeddedContext: rt.caps.promptEmbeddedContext,
          audio: false,
        },
        protocolVersion: String(rt.caps.protocolVersion),
        providerVersion: rt.caps.agentInfo?.version,
        ...currentModeMetadata(rt),
      };
    } catch (err) {
      failSession(rt, err);
      throw err;
    }
  }

  /** sendPrompt: turn id 합성 + session/prompt(§3.6, §7). */
  async function sendPrompt(handle: AgentSessionHandle, input: SendPromptInput): Promise<void> {
    const rt = byHandle(handle);
    const promptContent = filterPromptContentForCapabilities(input.content, rt.caps);
    if (promptContent.length === 0) {
      emit(rt, {
        type: "error",
        ref: refFor(rt),
        message: "prompt content is not supported by this ACP session",
        recoverable: true,
      });
      return;
    }
    const acpPrompt = toAcpPromptContent(promptContent);
    // turnId 합성: prompt 송신 직전 turnSeq 증가 + activeTurnId 할당(04 §turn id 합성, <sessionId>:t<n>).
    rt.turnSeq += 1;
    rt.activeTurnId = `${rt.providerSessionId}:t${rt.turnSeq}`;
    // 로컬 optimistic user_message echo: ACP는 라이브 prompt를 wire echo하지 않으므로(user_message_chunk는
    // session/load replay 때만) 클라이언트가 직접 transcript에 사용자 메시지를 넣는다. Codex는 wire
    // userMessage item으로 echo되므로 이 로컬 echo를 더하지 않는다(이중 렌더 방지). content는 wire 변환본이
    // 아니라 capability gate를 통과한 원본 AgentContent.
    emit(rt, {
      type: "user_message",
      ref: { ...refFor(rt), messageId: `${rt.activeTurnId}:u` },
      content: promptContent,
      mode: "replace",
    });
    emit(rt, { type: "session_status_changed", ref: refFor(rt), status: "running" });

    let result: { stopReason?: unknown };
    try {
      result = (await rpcRequest(rt, "session/prompt", {
        sessionId: rt.providerSessionId,
        prompt: acpPrompt,
      })) as typeof result;
    } catch (err) {
      // prompt 실패 → turn_completed{failed} + clear(§9).
      emit(rt, { type: "turn_completed", ref: refFor(rt), status: "failed" });
      rt.activeTurnId = undefined;
      throw err;
    }
    // stopReason → turn_completed(§3.6 표). usage 동승.
    for (const ev of mapClaudeStopReason(rt, result.stopReason)) emit(rt, ev);
    // turn 종료: activeTurnId clear(turn 경계 명시, §3.6).
    rt.activeTurnId = undefined;
  }

  /** ACP v1에는 provider-backed resource search request가 없으므로 workspace fallback을 위해 빈 결과를 반환한다. */
  async function searchResources(
    _handle: AgentSessionHandle,
    _input: ResourceSearchInput,
  ): Promise<ResourceSearchResult[]> {
    return [];
  }

  /**
   * cancelTurn: approval cancelled 먼저 → session/cancel 나중(approval-first, 04 §4.2).
   * 1. 해당 turn의 pending approval을 closing 표시(이중 응답 방지).
   * 2. 각 approval에 cancelled wire 응답 + approval_resolved emit + table 제거.
   * 3. session/cancel notification.
   * 4. 늦은 응답은 멱등 무시.
   */
  async function cancelTurn(handle: AgentSessionHandle, turnId?: string): Promise<void> {
    const rt = byHandle(handle);
    // 1. closing 표시(원자적). 이미 closing(respondApproval이 선점)인 항목은 제외 — 그 경로가 닫게 둔다(이중 wire 방지).
    const closing = [...rt.pendingApprovals.entries()].filter(
      ([, ap]) => (!turnId || ap.ref.turnId === turnId) && !ap.closing,
    );
    for (const [, ap] of closing) ap.closing = true;
    // 2. cancelled 응답을 wire로 먼저(ref-acp §3.8 MUST) + emit + 제거.
    for (const [key, ap] of closing) {
      // wire 응답은 보존한 원본 rpcId(타입 유지)로(R3).
      await deps.sendMessage(rt.runtimeId, buildPermissionResponse(ap.rpcId, { outcome: "cancelled" }));
      emit(rt, {
        type: "approval_resolved",
        ref: ap.ref,
        decision: { requestId: String(ap.rpcId), outcome: "cancelled" },
        decidedBy: "cleanup",
      });
      rt.pendingApprovals.delete(key);
    }
    // 3. 그 다음 session/cancel notification(id 없음).
    await rpcNotify(rt, "session/cancel", { sessionId: rt.providerSessionId });
    // 4. cancel 이후 늦은 응답은 멱등 무시(handleMessage/resolveRpc가 미존재 id 무시).
  }

  /** respondApproval: selected/cancelled wire 응답. failed는 wire 미전송(§6.2 가드). */
  async function respondApproval(handle: AgentSessionHandle, decision: ApprovalDecision): Promise<void> {
    const rt = byHandle(handle);
    const ap = rt.pendingApprovals.get(decision.requestId);
    if (!ap || ap.closing) return; // 이미 cancel/resolve/closing → 멱등 무시(04 §4.2 규칙 4).
    if (decision.outcome === "failed") {
      // failed는 process-exit 경로에서만 발생 → wire 미전송, 내부 emit만(§6.2 가드).
      rt.pendingApprovals.delete(decision.requestId);
      emit(rt, { type: "approval_resolved", ref: ap.ref, decision });
      return;
    }
    if (decision.outcome === "selected" && !ap.request.options.some((o) => o.id === decision.optionId)) {
      throw new Error(`unknown approval optionId: ${decision.optionId ?? "<missing>"}`);
    }
    // wire 전 원자적 선점(New-F1 race): send await 동안 cancelTurn/closePending이 같은 pending을
    // 닫지 못하게 closing으로 표시한다. 실패 시 되돌려 재시도·cleanup 재대상화를 허용한다.
    ap.closing = true;
    try {
      // selected/cancelled만 wire로(위 가드로 failed 제외).
      await deps.sendMessage(
        rt.runtimeId,
        buildPermissionResponse(ap.rpcId, { outcome: decision.outcome, optionId: decision.optionId }),
      );
    } catch (err) {
      if (rt.tearingDown) {
        // teardown(shutdown/exit) 중 send 실패: closePending이 closing(선점)을 건너뛰었으므로
        // cleanup outcome(failed, wire 미전송)으로 닫아 종료 이벤트 누락을 막는다. throw 안 함
        // (teardown 중 실패는 정상 — approve Promise의 unhandled rejection을 막는다).
        if (rt.pendingApprovals.delete(decision.requestId)) {
          emit(rt, {
            type: "approval_resolved",
            ref: ap.ref,
            decision: { requestId: decision.requestId, outcome: "failed" },
            decidedBy: "cleanup",
          });
        }
        return;
      }
      ap.closing = false;
      throw err;
    }
    // 내가 선점한 항목만 닫는다(teardown으로 이미 지워졌으면 delete=false → 중복 emit 회피).
    if (rt.pendingApprovals.delete(decision.requestId)) {
      // status → running(04 §4.1).
      emit(rt, { type: "approval_resolved", ref: ap.ref, decision });
      emit(rt, { type: "session_status_changed", ref: ap.ref, status: "running" });
    }
  }

  /**
   * setSessionMode: session/set_mode wire로 모드를 전환한다(ref-acp §10).
   * modeId는 provider가 알린 availableModes에 존재해야 한다(미존재는 wire 전 거부).
   *
   * [설계] 낙관적 반영을 하지 않는다. 모드 표시(runtime_metadata_changed)의 유일 권위는 provider의
   * current_mode_update / config_option_update다 — 그래야 낙관적 값과 권위 값의 순서 경쟁이 원천
   * 없어지고, 이 값을 쓰는 셀렉터·고위험 배지·approval severity가 항상 provider가 실제 수락한 모드를
   * 반영한다. 이 함수는 RPC 성공(수락)이면 resolve, 실패면 reject만 한다(호출부 composer가 거부 시 롤백).
   */
  async function setSessionMode(handle: AgentSessionHandle, modeId: string): Promise<void> {
    const rt = byHandle(handle);
    if (!rt.providerSessionId) throw new Error("claude adapter: session not ready (no sessionId)");
    const known = rt.modes?.availableModes.some((m) => m.id === modeId) ?? false;
    if (!known) throw new Error(`claude adapter: unknown session mode: ${modeId}`);

    // RPC 응답을 기다리는 동안에도 provider가 모드를 적용하고 승인 요청을 먼저 보낼 수 있으므로,
    // 전송 전(in-flight)부터 요청 모드를 pending으로 기록해 그 창의 승인도 보수적으로 판정한다(fail-safe).
    const prev = rt.pendingRequestedMode;
    rt.pendingRequestedMode = modeId;
    try {
      await rpcRequest(rt, "session/set_mode", { sessionId: rt.providerSessionId, modeId });
    } catch (err) {
      // 수락 실패 — 이 시도가 남긴 pending만 되돌린다(그 사이 echo/새 요청이 바꿨으면 그쪽을 존중).
      if (rt.pendingRequestedMode === modeId) rt.pendingRequestedMode = prev;
      throw err;
    }
    // 성공. 권위 echo(current_mode_update)가 오면 clearPendingModeOnEcho가 pending을 해제한다.
  }

  /** subscribeEvents: listener 등록 → AgentEvent 수신. 반환된 fn으로 해제. */
  function subscribeEvents(handle: AgentSessionHandle, listener: (event: AgentEvent) => void): UnlistenFn {
    const rt = sessions.get(handle);
    if (!rt) {
      // 세션 미생성(subscribe-before-start) — pending listener로 보관했다 createRuntime 시 attach(New-F2).
      // start/replay 중 emit되는 event가 곧장 store로 흘러 unbounded 버퍼링을 피한다.
      let pre = pendingListeners.get(handle);
      if (!pre) {
        pre = new Set();
        pendingListeners.set(handle, pre);
      }
      pre.add(listener);
      return () => {
        pendingListeners.get(handle)?.delete(listener);
        sessions.get(handle)?.listeners.delete(listener);
      };
    }
    rt.listeners.add(listener);
    // 구독 전 emit된 lifecycle 이벤트(session_started/status 등)를 flush(deferred fallback).
    if (rt.deferred.length > 0) {
      const q = rt.deferred;
      rt.deferred = [];
      for (const e of q) listener(e);
    }
    return () => {
      rt.listeners.delete(listener);
    };
  }

  /**
   * shutdown: authoritative cleanup 경계(S3, §4.4 (a)).
   * 1. pending approval cancelled(wire 송신, process 생존) + pending RPC reject — listener 살아 있어야 함.
   * 2. agentRuntimeShutdown await(backend reap까지).
   * 3. shutdown 반환 뒤에만 unlisten + 세션 삭제.
   */
  async function shutdown(handle: AgentSessionHandle): Promise<void> {
    const rt = sessions.get(handle);
    if (!rt || rt.closed || rt.tearingDown) return; // 멱등.
    rt.tearingDown = true; // in-flight respondApproval send 실패를 cleanup으로 인식(New-F1).
    // 1. pending 종료(process 생존 → wire 송신 가능).
    await closePending(rt, true);
    // 2. backend shutdown await(reap 후 반환).
    await deps.shutdownRuntime(rt.runtimeId);
    // 3. unlisten + 세션 삭제.
    rt.unlisten?.();
    rt.closed = true;
    sessions.delete(handle);
  }

  // ───────────────────────── 내부 헬퍼 ─────────────────────────

  /** initialize params(clientCapabilities 1차 값 + clientInfo). */
  function buildInitParams(): unknown {
    return (buildInitializeRequest({ id: 0, appVersion: deps.appVersion }) as { params: unknown }).params;
  }

  /** session/new|load|resume result의 modes/configOptions 보관(§3.4, §8). */
  function applySessionResult(
    rt: ClaudeAcpSessionRuntime,
    result: { modes?: AcpSessionModeState | null; configOptions?: unknown[] | null },
  ): void {
    if (result.modes) {
      rt.modes = result.modes;
      rt.currentModeId = result.modes.currentModeId;
    }
    if (Array.isArray(result.configOptions)) rt.configOptions = result.configOptions;
  }

  /** 현재 runtime state를 start/resume result용 non-secret mode metadata로 축약한다. */
  function currentModeMetadata(rt: ClaudeAcpSessionRuntime): AgentRuntimeMetadataUpdate {
    const configMode = extractModeConfigValue(rt.configOptions);
    const sessionMode = rt.currentModeId ?? configMode;
    const permissionMode = configMode ?? rt.currentModeId;
    const metadata: AgentRuntimeMetadataUpdate = {};
    if (sessionMode) metadata.sessionMode = sessionMode;
    if (permissionMode) metadata.permissionMode = permissionMode;
    // availableModes: 세션 모드 셀렉터 후보(비밀 아님). provider가 알린 목록만 노출한다.
    if (rt.modes && rt.modes.availableModes.length > 0) {
      metadata.availableModes = rt.modes.availableModes.map((m) => ({ id: m.id, name: m.name }));
    }
    return metadata;
  }

  /** 세션 실패 전이(§3.2 규칙 1, §9). protocol error 분류 + status→failed emit. */
  function failSession(rt: ClaudeAcpSessionRuntime, err: unknown): void {
    const recoverable = false;
    let message = "session start failed";
    if (err instanceof InitializeProtocolError) {
      message = `protocol error: ${err.message}`;
    } else if (err instanceof AdapterError) {
      message = err.code === -32000 ? "authentication required" : err.message;
    } else if (err instanceof Error) {
      message = err.message;
    }
    const ref: ProviderRef = { provider: "claude", sessionId: rt.providerSessionId };
    emit(rt, { type: "error", ref, message, recoverable });
    emit(rt, { type: "session_status_changed", ref, status: "failed" });
    // pending 정리(아직 process 생존 여부 불명 → wire 송신 안 함, 내부 reject만).
    void closePending(rt, false);
  }

  return {
    startSession,
    resumeSession,
    sendPrompt,
    searchResources,
    cancelTurn,
    respondApproval,
    setSessionMode,
    subscribeEvents,
    shutdown,
  };
}

/** ACP 메시지 여부 판정(method/result/error 중 하나 존재). CL-26 framing error 분기용. */
function isAcpMessage(msg: unknown): msg is JsonRpcMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return "method" in m || "result" in m || "error" in m;
}

/** 미사용 import 가드(타입만 쓰는 심볼). */
export type { AcpSessionMode };
