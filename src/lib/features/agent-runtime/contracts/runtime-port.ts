/**
 * Direct Agent Runtime — Agent Runtime Port 타입 정본 복사처.
 *
 * 정본: `docs/plans/agent-direct-runtime/15-data-contracts.md` §6.
 * provider별 구현(Codex/Claude/Legacy adapter)을 숨기는 TS-facing interface.
 * UI/store는 이 interface만 본다(03 §Agent Runtime Port).
 */

import type { AgentEvent, AgentContent, ApprovalDecision, ProviderRef, AgentProvider, AgentSessionModeOption, AgentModelOption } from "./normalized";
import type { ComposerCapabilities } from "./transcript";
import type { UnlistenFn } from "../../../tauri/event"; // src/lib/tauri/event.ts (프로젝트는 상대경로 컨벤션)

/** 세션을 식별하는 CLCOMX 내부 핸들(=live-session-store의 session.id). provider id 아님. */
export type AgentSessionHandle = string;

/** startSession 입력. provider별 기동 파라미터는 adapter가 검증된 형태로만 채운다. */
export interface StartSessionParams {
  /** CLCOMX 세션 핸들(tab id와 동일). */
  sessionHandle: AgentSessionHandle;
  provider: Exclude<AgentProvider, "legacy-pty">;
  distro: string;
  /** WSL absolute path. ACP는 absolute 필수(adapter 입력 직전 canonicalize). */
  workDir: string;
  /** provider별 추가 옵션(모델/approval policy 등). adapter가 해석. */
  options?: Record<string, unknown>;
}

/** resumeSession 입력. provider session/thread id로 재개. */
export interface ResumeSessionParams {
  sessionHandle: AgentSessionHandle;
  provider: Exclude<AgentProvider, "legacy-pty">;
  distro: string;
  workDir: string;
  /** provider 원본 session/thread id(resume 토큰). */
  providerSessionId?: string;
  providerThreadId?: string;
  /** true면 replay(ACP session/load, Codex thread/read), false면 replay 없이 재개. */
  replay: boolean;
  options?: Record<string, unknown>;
}

/** sendPrompt 입력. composer가 만든 content를 그대로 넘긴다. */
export interface SendPromptInput {
  content: AgentContent[];
}

/** composer resource search 입력. provider는 workDir root 안에서만 후보를 돌려준다. */
export interface ResourceSearchInput {
  query: string;
  workDir: string;
  limit?: number;
}

/** composer @mention 후보. */
export interface ResourceSearchResult {
  label: string;
  uri: string;
  detail?: string;
  mimeType?: string;
  /** provider 전송 시 의미를 보존해야 하는 resource 종류. 기본값은 file이다. */
  resourceKind?: "file" | "skill";
  /** provider 전송용 이름/본문. skill 후보는 Codex skill name을 싣는다. */
  text?: string;
}

/** 시작/재개 결과. provider 원본 id와 재개 가능 메타를 돌려준다. */
export interface SessionStartResult {
  ref: ProviderRef;
  /** replay 없는 재개 가능 여부. provider가 capability를 알리지 않으면 생략한다. */
  canResume?: boolean;
  /** replay 포함 load 가능 여부. provider가 capability를 알리지 않으면 생략한다. */
  canLoad?: boolean;
  /** composer 입력 기능 게이트용 provider prompt capability(08 §6.4). */
  composerCapabilities?: ComposerCapabilities;
  /** 협상된 protocol 버전. */
  protocolVersion?: string;
  /** adapter/provider 바이너리 버전(확인 가능할 때만). */
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
  /** 세션 모드 전환 후보 목록(셀렉터 노출용). provider가 알린 availableModes. */
  availableModes?: AgentSessionModeOption[];
  /** 세션의 실제 current model id(Codex thread 응답). 셀렉터 초기값 권위. */
  model?: string;
  /** 세션의 실제 current reasoning effort id(Codex thread 응답). */
  effort?: string;
}

/**
 * Agent Runtime Port. 모든 메서드는 비동기. 이벤트 스트림은 subscribeEvents로 구독.
 * 구현체는 provider adapter(Codex/Claude/Legacy)이며 Tauri command(§8)를 호출한다.
 */
export interface AgentRuntimePort {
  /** 새 세션 시작: process spawn + protocol initialize + session 생성. */
  startSession(params: StartSessionParams): Promise<SessionStartResult>;

  /** 기존 세션 재개. replay 여부는 params.replay. */
  resumeSession(params: ResumeSessionParams): Promise<SessionStartResult>;

  /** 프롬프트 전송(1 turn 시작). turn 진행은 subscribeEvents로 관찰. */
  sendPrompt(sessionHandle: AgentSessionHandle, input: SendPromptInput): Promise<void>;

  /** provider-backed resource/file search. 미지원 provider는 빈 배열을 돌려준다. */
  searchResources?(sessionHandle: AgentSessionHandle, input: ResourceSearchInput): Promise<ResourceSearchResult[]>;

  /** 진행 중 turn 취소. turnId 생략 시 현재 active turn. */
  cancelTurn(sessionHandle: AgentSessionHandle, turnId?: string): Promise<void>;

  /** 승인 요청에 응답. requestId로 pending request에 매칭. */
  respondApproval(sessionHandle: AgentSessionHandle, decision: ApprovalDecision): Promise<void>;

  /**
   * 세션 모드 전환(예: plan/acceptEdits). 미지원 provider(Codex v1)는 이 메서드를 정의하지 않는다.
   * modeId는 metadata.availableModes에 존재하는 값이어야 한다(호출부 검증). 성공 시 provider가
   * current_mode_update 또는 result로 새 모드를 알리고, adapter가 runtime_metadata_changed로 반영한다.
   */
  setSessionMode?(sessionHandle: AgentSessionHandle, modeId: string): Promise<void>;

  /**
   * 사용 가능한 모델 목록 조회(Codex model/list). 미지원 provider(Claude v1)는 이 메서드를 정의하지 않는다.
   * 반환은 비밀 아닌 표시 정보(id/label/effort 후보)만 담는다.
   */
  listModels?(sessionHandle: AgentSessionHandle): Promise<AgentModelOption[]>;

  /**
   * 다음 turn 이후에 적용할 model/effort override를 설정한다(Codex turn/start override).
   * 미지원 provider는 이 메서드를 정의하지 않는다. 세션 메모리 범위(영속 안 함) — 새 세션은 기본값.
   * undefined 필드는 변경하지 않고, null은 해당 override 해제를 뜻한다.
   */
  setTurnOptions?(
    sessionHandle: AgentSessionHandle,
    options: { model?: string | null; effort?: string | null },
  ): void;

  /**
   * 세션 이벤트 구독. 반환된 UnlistenFn으로 해제.
   * adapter가 provider wire → AgentEvent 변환 후 listener에 전달.
   */
  subscribeEvents(sessionHandle: AgentSessionHandle, listener: (event: AgentEvent) => void): UnlistenFn;

  /** 세션 종료: graceful shutdown(stdin close → timeout → kill). */
  shutdown(sessionHandle: AgentSessionHandle): Promise<void>;
}
