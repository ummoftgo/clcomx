/**
 * Direct Agent Runtime — persistence metadata 타입 정본 복사처.
 *
 * 정본: `docs/plans/agent-direct-runtime/15-data-contracts.md` §7.1.
 * transcript 전체가 아닌 재개·복원용 메타만 저장한다(RD-3 full cache 제외).
 */

import type { AgentProvider, AgentSessionModeOption } from "./normalized";
import type { SessionHostProps } from "../../session/contracts/session-shell";

/** 세션이 어떤 runtime으로 구동되는지. 기존 PTY는 "pty". */
export type SessionRuntimeKind = "pty" | "direct-codex" | "direct-claude";

/**
 * direct runtime host(`AgentTranscriptSurface.svelte`)가 받는 props.
 * `SessionHostProps`와 **동형**이다(옵션 B 분기에서 Terminal host와 같은 props로 교체 가능, 08 §2.2/§9).
 * PTY 전제 콜백(onPtyId/onAuxStateChange/onExit/onResumeFallback)은 direct에서 no-op/우회한다(08 §9.2).
 */
export type AgentRuntimeHostProps = SessionHostProps;

/** direct runtime 세션 metadata. transcript 전체가 아닌 재개·복원용 메타만 저장. */
export interface AgentRuntimeMetadata {
  sessionRuntimeKind: SessionRuntimeKind;
  provider: AgentProvider; // "codex" | "claude" | "legacy-pty"
  /** provider 원본 session id(resume 키). 평문 영속화 금지 — scrub 대상(§7.3). */
  providerSessionId?: string;
  /** Codex thread id. scrub 대상. */
  providerThreadId?: string;
  /** 마지막 turn id. */
  lastTurnId?: string;
  /** provider별 resume 토큰. scrub 대상. */
  providerResumeToken?: string;
  /** 협상된 protocol 버전(Codex/ACP wire 버전). */
  protocolVersion?: string;
  /** adapter/provider 바이너리 버전(호환성 추적). */
  adapterVersion?: string;
  providerVersion?: string;
  /** provider sandbox/mode 표시용 metadata(09 §8.2). */
  sandbox?: string;
  /** provider approval policy 표시용 metadata(09 §8.2). */
  approvalPolicy?: string;
  /** provider approval reviewer 표시용 metadata(09 §8.2). */
  approvalsReviewer?: string;
  /** Claude SDK permissionMode 또는 동등 provider permission mode id. */
  permissionMode?: string;
  /** ACP session mode 또는 동등 provider session mode id. */
  sessionMode?: string;
  /** 세션 모드 전환 후보 목록(셀렉터 노출용, 비밀 아님). 세션 시작 시 provider가 다시 알리므로
   *  영속화돼도 무해하지만 복원의 권위 소스는 아니다(재시작 시 갱신). */
  availableModes?: AgentSessionModeOption[];
  /** 세션의 실제 current model id(Codex, ②-B 셀렉터 초기값 권위). */
  model?: string;
  /** 세션의 실제 current reasoning effort id(Codex, ②-B). */
  effort?: string;
  /** replay 없는 재개 가능 여부(ACP resume / Codex thread/resume). */
  canResume?: boolean;
  /** replay 가능 여부(ACP loadSession / Codex thread/read). */
  canLoad?: boolean;
}
