/**
 * Direct Agent Runtime — persistence metadata 타입 정본 복사처.
 *
 * 정본: `docs/plans/agent-direct-runtime/15-data-contracts.md` §7.1.
 * transcript 전체가 아닌 재개·복원용 메타만 저장한다(RD-3 full cache 제외).
 */

import type { AgentProvider } from "./normalized";

/** 세션이 어떤 runtime으로 구동되는지. 기존 PTY는 "pty". */
export type SessionRuntimeKind = "pty" | "direct-codex" | "direct-claude";

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
  /** replay 없는 재개 가능 여부(ACP resume / Codex thread/resume). */
  canResume?: boolean;
  /** replay 가능 여부(ACP loadSession / Codex thread/read). */
  canLoad?: boolean;
}
