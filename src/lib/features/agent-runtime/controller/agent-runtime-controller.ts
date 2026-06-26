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

    // subscribeEvents를 start/resume **전에** 호출한다(Finding 1 + New-F2): adapter는 세션 미생성
    // 상태의 구독을 pending listener로 보관했다 runtime 생성 시 attach한다. 이로써 start 중 lifecycle
    // 이벤트 유실이 없고, replay event도 unbounded 버퍼 없이 곧장 store(seal/eviction bounded)로 흐른다.
    this.unsubscribe = port.subscribeEvents(config.sessionHandle, (event: AgentEvent) => {
      this.deps.store.dispatch(event);
    });

    // start/resume 분기(04 §lifecycle).
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
