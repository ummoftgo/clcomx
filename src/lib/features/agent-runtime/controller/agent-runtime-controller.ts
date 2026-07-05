/**
 * Direct Agent Runtime — 조립 controller(03 §3.1, FE §1.5).
 *
 * runtimeKind로 provider adapter(Codex/Claude `AgentRuntimePort`)를 선택해 transport·store·router를
 * 묶는 세션 인스턴스 오케스트레이터다. host(view)는 이 controller의 메서드만 호출한다.
 *
 * 책임:
 * - start(): mount 시 port.startSession/resumeSession + subscribeEvents(event→store.dispatch).
 * - submit(content): composer 전송 → port.sendPrompt.
 * - approve(decision): 사용자 승인 → port.respondApproval(wire). `failed`는 내부 cleanup 전용이라 거부.
 * - cancel(): 진행 turn 취소 → port.cancelTurn(04 §4.2).
 * - dispose(): teardown 시 port.shutdown 후 unsubscribe(04 §5.0 순서).
 *
 * 규약: transport/invoke를 직접 부르지 않는다. port·store·registry만 deps로 받는다(DI). 상대경로만.
 */

import type {
  AgentContent,
  AgentEvent,
  AgentModelOption,
  AgentRuntimeMetadataUpdate,
  ApprovalDecision,
} from "../contracts/normalized";
import type { SessionRuntimeKind } from "../contracts/metadata";
import type {
  AgentRuntimePort,
  ResourceSearchResult,
  ResumeSessionParams,
  SessionStartResult,
  StartSessionParams,
} from "../contracts/runtime-port";
import type { AgentRuntimeStore } from "../state/agent-runtime-store.svelte";
import type { UnlistenFn } from "../../../tauri/event";
import {
  registerSession,
  unregisterSession,
} from "./agent-event-router";

/** runtimeKind → provider(adapter 선택용). pty는 direct 대상이 아님. */
function providerForRuntimeKind(
  kind: SessionRuntimeKind,
): "codex" | "claude" {
  if (kind === "direct-codex") return "codex";
  if (kind === "direct-claude") return "claude";
  // pty는 이 controller를 쓰지 않는다 — 방어적 throw.
  throw new Error(`agent-runtime-controller: unsupported runtimeKind "${kind}"`);
}

/** 사용자 승인 action이 실제 pending approval에 대응하는지 확인한다(09 §2 표시-선택 일치). */
function hasPendingApproval(store: AgentRuntimeStore, requestId: string): boolean {
  if (store.escalationApproval?.id === requestId) return true;
  return store.pendingApprovals.some((request) => request.id === requestId);
}

/** controller 시작 파라미터(start/resume 분기). */
export interface AgentRuntimeStartConfig {
  sessionHandle: string;
  runtimeKind: SessionRuntimeKind;
  distro: string;
  workDir: string;
  /** resume용 provider 원본 id(있으면 resumeSession 경로). */
  resume?: {
    providerSessionId?: string;
    providerThreadId?: string;
    replay: boolean;
  };
  options?: Record<string, unknown>;
}

/**
 * controller DI deps.
 * - createPort: runtimeKind로 해당 provider의 `AgentRuntimePort`를 만든다(테스트는 fake port 주입).
 * - store: 이 세션의 transcript/status store(reducer/pending/audit 포함).
 * - onRuntimeMetadataChange: transcript 외 세션 metadata patch를 host persistence로 전달한다.
 * - onSessionTitleChange: provider session_info_update title을 앱 session title로 전달한다.
 * - windowLabel: registry 소유 window(OQ-48 바인딩, 기본 main).
 */
export interface AgentRuntimeControllerDeps {
  createPort: (kind: SessionRuntimeKind) => AgentRuntimePort;
  store: AgentRuntimeStore;
  onRuntimeMetadataChange?: (metadata: AgentRuntimeMetadataUpdate) => void | Promise<void>;
  onSessionTitleChange?: (title: string | null) => void | Promise<void>;
  /** 실제 turn/start 성공(raw session_status_changed running + turnId)을 알린다. 파생 store.status가
   *  아니라 raw 이벤트라 late previous-turn delta 등 generic running 전이와 구분된다(②-C sentinel 커밋). */
  onTurnStarted?: (turnId: string) => void;
  windowLabel?: string;
}

/** view가 호출하는 controller 표면. */
export interface AgentRuntimeController {
  /** mount 시 1회: 세션 시작(또는 재개) + event 구독 후 provider 시작 결과를 돌려준다. */
  start(config: AgentRuntimeStartConfig): Promise<SessionStartResult | null>;
  /** composer 전송. */
  submit(content: AgentContent[]): Promise<void>;
  /** composer @mention provider-backed resource search. */
  searchResources(query: string, limit?: number): Promise<ResourceSearchResult[]>;
  /** 사용자 승인 응답. `failed`는 cleanup 내부 전용이라 wire 경로에서 거부한다. */
  approve(decision: ApprovalDecision): Promise<void>;
  /** 진행 turn 취소. */
  cancel(turnId?: string): Promise<void>;
  /** 세션 모드 전환(지원 provider만). 미지원이면 no-op. */
  setSessionMode(modeId: string): Promise<void>;
  /** 사용 가능한 모델 목록 조회(지원 provider만). 미지원이면 빈 배열. */
  listModels(): Promise<AgentModelOption[]>;
  /** model/effort/approvalPolicy turn override 설정(지원 provider만). 미지원이면 no-op. */
  setTurnOptions(options: { model?: string | null; effort?: string | null; approvalPolicy?: string | null }): void;
  /** auto-follow 토글(store 표면 갱신). */
  setAutoFollow(value: boolean): void;
  /** teardown: unsubscribe + shutdown(멱등). */
  dispose(): Promise<void>;
}

class AgentRuntimeControllerImpl implements AgentRuntimeController {
  private readonly deps: AgentRuntimeControllerDeps;
  private port: AgentRuntimePort | null = null;
  private unsubscribe: UnlistenFn | null = null;
  private sessionHandle: string | null = null;
  private workDir: string | null = null;
  private started = false;
  private disposed = false;

  constructor(deps: AgentRuntimeControllerDeps) {
    this.deps = deps;
  }

  async start(config: AgentRuntimeStartConfig): Promise<SessionStartResult | null> {
    // 멱등: 이미 시작했거나 dispose된 controller는 재시작하지 않는다.
    if (this.started || this.disposed) return null;
    this.started = true;
    this.sessionHandle = config.sessionHandle;
    this.workDir = config.workDir;

    const provider = providerForRuntimeKind(config.runtimeKind);
    const port = this.deps.createPort(config.runtimeKind);
    this.port = port;

    // registry 등록(이 window 소유) — backend event 라우팅·정리 경계.
    registerSession(config.sessionHandle, this.deps.store, this.deps.windowLabel ?? "main");

    // subscribeEvents를 start/resume **전에** 호출한다(Finding 1 + New-F2): adapter는 세션 미생성
    // 상태의 구독을 pending listener로 보관했다 runtime 생성 시 attach한다. 이로써 start 중 lifecycle
    // 이벤트 유실이 없고, replay event도 unbounded 버퍼 없이 곧장 store(seal/eviction bounded)로 흐른다.
    this.unsubscribe = port.subscribeEvents(config.sessionHandle, (event: AgentEvent) => {
      if (event.type === "runtime_metadata_changed") {
        void Promise.resolve(this.deps.onRuntimeMetadataChange?.(event.metadata)).catch(() => {
          // metadata 저장 실패는 transcript lifecycle 실패로 승격하지 않는다.
        });
      }
      if (event.type === "session_title_changed") {
        void Promise.resolve(this.deps.onSessionTitleChange?.(event.title)).catch(() => {
          // title 저장 실패는 transcript lifecycle 실패로 승격하지 않는다.
        });
      }
      // 실제 turn/start 성공 신호: adapter는 running+turnId를 turn/start 성공(또는 turn/started)에서만
      // emit한다 — late delta는 running session_status_changed를 내지 않는다(파생 status와 구분, ②-C).
      if (event.type === "session_status_changed" && event.status === "running" && event.ref.turnId) {
        this.deps.onTurnStarted?.(event.ref.turnId);
      }
      this.deps.store.dispatch(event);
    });

    // start/resume 분기(04 §lifecycle).
    let result: SessionStartResult;
    if (config.resume) {
      const params: ResumeSessionParams = {
        sessionHandle: config.sessionHandle,
        provider,
        distro: config.distro,
        workDir: config.workDir,
        providerSessionId: config.resume.providerSessionId,
        providerThreadId: config.resume.providerThreadId,
        replay: config.resume.replay,
        options: config.options,
      };
      result = await port.resumeSession(params);
    } else {
      const params: StartSessionParams = {
        sessionHandle: config.sessionHandle,
        provider,
        distro: config.distro,
        workDir: config.workDir,
        options: config.options,
      };
      result = await port.startSession(params);
    }
    if (result.composerCapabilities) this.deps.store.setCapabilities(result.composerCapabilities);
    return result;
  }

  async submit(content: AgentContent[]): Promise<void> {
    if (!this.port || !this.sessionHandle || this.disposed) return;
    await this.port.sendPrompt(this.sessionHandle, { content });
  }

  async searchResources(query: string, limit?: number): Promise<ResourceSearchResult[]> {
    if (!this.port?.searchResources || !this.sessionHandle || !this.workDir || this.disposed) return [];
    const q = query.trim();
    return this.port.searchResources(this.sessionHandle, {
      query: q,
      workDir: this.workDir,
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  async approve(decision: ApprovalDecision): Promise<void> {
    if (!this.port || !this.sessionHandle || this.disposed) return;
    if (decision.outcome === "failed") {
      throw new Error("failed approval decisions are client-internal and must not be sent to provider wire");
    }
    if (!hasPendingApproval(this.deps.store, decision.requestId)) {
      throw new Error(`approval requestId is not pending: ${decision.requestId}`);
    }
    // wire 전송만 한다(Finding 2 + New-F1): 성공 시 adapter가 wire 응답 후 approval_resolved를
    // emit해 store가 닫힌다(single source). wire 실패면 throw로 store·adapter 모두 pending을 유지해
    // 재시도가 가능하다 — 낙관적 close나 backstop의 no-op close로 인한 UI/provider 분기를 원천 제거.
    await this.port.respondApproval(this.sessionHandle, decision);
  }

  async cancel(turnId?: string): Promise<void> {
    if (!this.port || !this.sessionHandle || this.disposed) return;
    // adapter가 cancel cleanup 정본 순서(04 §4.2)를 수행하므로 store 측은 wire 응답을 기다린다.
    await this.port.cancelTurn(this.sessionHandle, turnId);
  }

  async setSessionMode(modeId: string): Promise<void> {
    if (!this.port?.setSessionMode || !this.sessionHandle || this.disposed) return;
    await this.port.setSessionMode(this.sessionHandle, modeId);
  }

  async listModels(): Promise<AgentModelOption[]> {
    if (!this.port?.listModels || !this.sessionHandle || this.disposed) return [];
    return this.port.listModels(this.sessionHandle);
  }

  setTurnOptions(options: { model?: string | null; effort?: string | null; approvalPolicy?: string | null }): void {
    if (!this.port?.setTurnOptions || !this.sessionHandle || this.disposed) return;
    this.port.setTurnOptions(this.sessionHandle, options);
  }

  setAutoFollow(value: boolean): void {
    this.deps.store.setAutoFollow(value);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // 1. port shutdown을 **먼저** await한다(Finding 3, 04 §5.0): listener를 살려둔 채
    //    adapter가 pending 종료→backend shutdown/reap을 끝내야 그동안 emit되는
    //    approval_resolved/process_exited/error가 store에 도달한다(구독을 먼저 끊으면 유실).
    if (this.port && this.sessionHandle) {
      try {
        await this.port.shutdown(this.sessionHandle);
      } catch {
        // shutdown 실패해도 teardown은 진행(리소스 누수 방지).
      }
    }

    // 2. shutdown 완료 후 controller listener 해제(늦은 event 차단).
    try {
      this.unsubscribe?.();
    } catch {
      // 이미 해제됨 가능 — 무시.
    }
    this.unsubscribe = null;

    // 3. registry/store 정리.
    if (this.sessionHandle) unregisterSession(this.sessionHandle, this.deps.store);
    this.port = null;
  }
}

/** 조립 controller 팩토리(FE §1.5 DI). */
export function createAgentRuntimeController(
  deps: AgentRuntimeControllerDeps,
): AgentRuntimeController {
  return new AgentRuntimeControllerImpl(deps);
}
