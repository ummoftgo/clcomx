/**
 * Direct Agent Runtime — spawn/initialize 실패 시 fallback action 컨트롤러(10 §4.6, 08 §9).
 *
 * direct runtime의 `controller.start()`가 거부(바이너리 없음·버전 불일치·allowlist 거부·initialize timeout)되면
 * 사용자에게 선택지를 **표시**하는 상태 머신을 제공한다. 자동 폴백은 금지(사용자 의도 보존, 10 §4.6).
 *
 * 책임:
 * - markFailed(error): start 실패를 기록하고 fallback 패널을 띄운다.
 * - chooseLegacyPty(): 같은 agent를 기존 PTY 경로로 새 세션으로 연다(onFallbackToPty 콜백 위임).
 * - chooseRetry(): direct runtime을 다시 시도한다(onRetry 콜백 위임).
 * - dismiss(): 빈 탭 유지(패널만 닫음).
 *
 * 규약: 이 모듈은 순수 상태 + DI 콜백만 다룬다(transport/store 직접 접근 없음). 상대경로만.
 */

import { redactDisplayText } from "../service/display-redaction";

/** fallback에 전달되는 세션 식별 정보(PTY 새 세션 생성 입력). */
export interface RuntimeFallbackContext {
  /** 실패한 direct 세션 핸들(닫기 대상). */
  sessionId: string;
  /** 같은 agent를 PTY로 다시 열 때 쓰는 agent id. */
  agentId: string;
  distro: string;
  workDir: string;
  /** legacy PTY resume 토큰이 있으면 PTY 전환 시 이어받기에 사용한다. */
  resumeToken?: string | null;
}

/** fallback 컨트롤러 DI 콜백. */
export interface RuntimeFallbackDeps {
  context: RuntimeFallbackContext;
  /**
   * legacy PTY 새 세션으로 전환(10 §4.6 "legacy PTY 새 세션/legacy resume"). 실패한 direct 세션을 닫고
   * 같은 agent/distro/workDir 및 기존 PTY resumeToken으로 PTY 세션을 만든다. 호출부(App)가 실제 세션 생성/탭 정리를 담당.
   */
  onFallbackToPty: (context: RuntimeFallbackContext) => void | Promise<void>;
  /** direct runtime 재시도(같은 세션 재기동). 미지정이면 retry 선택지 비활성. */
  onRetry?: () => void | Promise<void>;
}

/** fallback 패널이 노출하는 reactive 표면. */
export interface RuntimeFallbackState {
  /** 패널 표시 여부. */
  visible: boolean;
  /** 실패 사유 문구(진단 표시용, 비밀 비포함 — provider 에러 메시지 가공). */
  message: string | null;
}

/** view가 호출하는 fallback 컨트롤러 표면. */
export interface RuntimeFallbackController {
  /** 현재 fallback 상태(패널 표시/사유). */
  readonly state: RuntimeFallbackState;
  /** retry 선택지 사용 가능 여부(onRetry 주입 여부). */
  readonly canRetry: boolean;
  /** start 실패를 기록하고 패널을 띄운다(정확히 1회만 표시 — 멱등). */
  markFailed(error: unknown): void;
  /** legacy PTY 새 세션으로 전환. */
  chooseLegacyPty(): Promise<void>;
  /** direct runtime 재시도. */
  chooseRetry(): Promise<void>;
  /** 패널 닫기(빈 탭 유지). */
  dismiss(): void;
}

/** unknown 에러를 비밀 비포함 사람용 문구로 정규화한다(provider raw 메시지는 그대로 두지 않고 toString). */
function normalizeErrorMessage(error: unknown): string {
  let message = "";
  if (error == null) return message;
  if (error instanceof Error) message = error.message;
  else if (typeof error === "string") message = error;
  else {
    try {
      message = String(error);
    } catch {
      message = "";
    }
  }
  try {
    return redactDisplayText(message);
  } catch {
    return message;
  }
}

class RuntimeFallbackControllerImpl implements RuntimeFallbackController {
  private readonly deps: RuntimeFallbackDeps;
  // 외부 reactive 래핑(룬)을 강제하지 않도록 plain 객체로 노출하고, view가 $state로 감싸 쓴다.
  readonly state: RuntimeFallbackState = { visible: false, message: null };

  constructor(deps: RuntimeFallbackDeps) {
    this.deps = deps;
  }

  get canRetry(): boolean {
    return typeof this.deps.onRetry === "function";
  }

  markFailed(error: unknown): void {
    // 멱등: 이미 표시 중이면 사유만 최신화하고 중복 표시하지 않는다.
    this.state.message = normalizeErrorMessage(error);
    this.state.visible = true;
  }

  async chooseLegacyPty(): Promise<void> {
    this.state.visible = false;
    await this.deps.onFallbackToPty(this.deps.context);
  }

  async chooseRetry(): Promise<void> {
    if (!this.deps.onRetry) return;
    this.state.visible = false;
    await this.deps.onRetry();
  }

  dismiss(): void {
    this.state.visible = false;
  }
}

/** fallback 컨트롤러 팩토리(DI). */
export function createRuntimeFallbackController(
  deps: RuntimeFallbackDeps,
): RuntimeFallbackController {
  return new RuntimeFallbackControllerImpl(deps);
}
