/**
 * Direct Agent Runtime — 조립 controller(03 §3.1, FE §1.5).
 *
 * runtimeKind로 provider adapter(Codex/Claude `AgentRuntimePort`)를 선택해 transport·store·router를
 * 묶는 세션 인스턴스 오케스트레이터다. host(view)는 이 controller의 메서드만 호출한다.
 *
 * 책임:
 * - start(): mount 시 port.startSession/resumeSession + subscribeEvents(event→store.dispatch).
 * - submit(content): composer 전송 → port.sendPrompt.
 * - approve(decision): 사용자 승인 → store.respondApproval(audit) + port.respondApproval(wire).
 * - cancel(): 진행 turn 취소 → port.cancelTurn + store cancel cleanup(04 §4.2).
 * - dispose(): teardown 시 unsubscribe + port.shutdown(04 §5.0 순서).
 *
 * 규약: transport/invoke를 직접 부르지 않는다. port·store·registry만 deps로 받는다(DI). 상대경로만.
 */

import type {
  AgentContent,
  AgentEvent,
  ApprovalDecision,
} from "../contracts/normalized";
import type { SessionRuntimeKind } from "../contracts/metadata";
import type {
  AgentRuntimePort,
  ResumeSessionParams,
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
 * - windowLabel: registry 소유 window(OQ-48 바인딩, 기본 main).
 */
export interface AgentRuntimeControllerDeps {
  createPort: (kind: SessionRuntimeKind) => AgentRuntimePort;
  store: AgentRuntimeStore;
  windowLabel?: string;
}

/** view가 호출하는 controller 표면. */
export interface AgentRuntimeController {
  /** mount 시 1회: 세션 시작(또는 재개) + event 구독. */
  start(config: AgentRuntimeStartConfig): Promise<void>;
  /** composer 전송. */
  submit(content: AgentContent[]): Promise<void>;
  /** 사용자 승인 응답(store 멱등 기록 + wire 전송). */
  approve(decision: ApprovalDecision): Promise<void>;
  /** 진행 turn 취소. */
  cancel(turnId?: string): Promise<void>;
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
  private started = false;
  private disposed = false;

  constructor(deps: AgentRuntimeControllerDeps) {
    this.deps = deps;
  }

  async start(config: AgentRuntimeStartConfig): Promise<void> {
    // 멱등: 이미 시작했거나 dispose된 controller는 재시작하지 않는다.
    if (this.started || this.disposed) return;
    this.started = true;
    this.sessionHandle = config.sessionHandle;

    const provider = providerForRuntimeKind(config.runtimeKind);
    const port = this.deps.createPort(config.runtimeKind);
    this.port = port;

    // registry 등록(이 window 소유) — backend event 라우팅·정리 경계.
    registerSession(config.sessionHandle, this.deps.store, this.deps.windowLabel ?? "main");

    // subscribeEvents: adapter가 변환한 AgentEvent를 store로 흘린다(router 경유 dispatch).
    this.unsubscribe = port.subscribeEvents(config.sessionHandle, (event: AgentEvent) => {
      this.deps.store.dispatch(event);
    });

    // start vs resume 분기(04 §lifecycle).
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
      await port.resumeSession(params);
    } else {
      const params: StartSessionParams = {
        sessionHandle: config.sessionHandle,
        provider,
        distro: config.distro,
        workDir: config.workDir,
        options: config.options,
      };
      await port.startSession(params);
    }
  }

  async submit(content: AgentContent[]): Promise<void> {
    if (!this.port || !this.sessionHandle || this.disposed) return;
    await this.port.sendPrompt(this.sessionHandle, { content });
  }

  async approve(decision: ApprovalDecision): Promise<void> {
    if (!this.port || !this.sessionHandle || this.disposed) return;
    // store에 먼저 멱등 기록(audit + 표면 갱신), 그 다음 wire 전송.
    this.deps.store.respondApproval(decision, "user");
    await this.port.respondApproval(this.sessionHandle, decision);
  }

  async cancel(turnId?: string): Promise<void> {
    if (!this.port || !this.sessionHandle || this.disposed) return;
    // adapter가 cancel cleanup 정본 순서(04 §4.2)를 수행하므로 store 측은 wire 응답을 기다린다.
    await this.port.cancelTurn(this.sessionHandle, turnId);
  }

  setAutoFollow(value: boolean): void {
    this.deps.store.setAutoFollow(value);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // 1. event 구독 해제(늦은 event 차단).
    try {
      this.unsubscribe?.();
    } catch {
      // 이미 해제됨 가능 — 무시.
    }
    this.unsubscribe = null;

    // 2. port shutdown(graceful — stdin close→timeout→kill은 backend가).
    if (this.port && this.sessionHandle) {
      try {
        await this.port.shutdown(this.sessionHandle);
      } catch {
        // shutdown 실패는 teardown을 막지 않는다.
      }
    }

    // 3. registry/store 정리.
    if (this.sessionHandle) unregisterSession(this.sessionHandle);
    this.port = null;
  }
}

/** 조립 controller 팩토리(FE §1.5 DI). */
export function createAgentRuntimeController(
  deps: AgentRuntimeControllerDeps,
): AgentRuntimeController {
  return new AgentRuntimeControllerImpl(deps);
}
