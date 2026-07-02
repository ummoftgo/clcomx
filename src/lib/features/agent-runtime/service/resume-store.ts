/**
 * Direct Agent Runtime — 재개 id 암호화 저장소 invoke 래퍼(OQ-16).
 * backend secret_store 커맨드를 감싼다. 재개 id는 workspace.json이 아닌 별도 암호화 파일에 있다.
 */
import { invoke } from "../../../tauri/core";

/** 세션별 재개 식별자(암호화 저장). resumeToken은 저장하지 않는다. */
export interface ResumeKeys {
  providerThreadId?: string;
  providerSessionId?: string;
  canResume: boolean;
  canLoad: boolean;
}

/** 재개 id를 암호화 저장한다. */
export function saveResumeKeys(sessionHandle: string, keys: ResumeKeys): Promise<void> {
  return invoke("agent_runtime_save_resume_keys", { sessionHandle, keys });
}

/** 재개 id를 로드한다. 없음/복호화 실패 시 null. */
export function loadResumeKeys(sessionHandle: string): Promise<ResumeKeys | null> {
  return invoke("agent_runtime_load_resume_keys", { sessionHandle });
}

/** 세션 재개 id 파일을 삭제한다(탭 삭제 GC). */
export function clearResumeKeys(sessionHandle: string): Promise<void> {
  return invoke("agent_runtime_clear_resume_keys", { sessionHandle });
}
