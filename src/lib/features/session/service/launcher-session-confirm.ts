import type { AgentId } from "../../../agents";
import type { SessionRuntimeKind } from "../../agent-runtime/contracts/metadata";

/**
 * createSession의 6-인자 시그니처(title/resumeToken이 runtimeKind보다 앞).
 * 런처 onConfirm 계약은 4-인자(runtimeKind가 4번째)라 위치가 어긋난다.
 */
export type CreateSessionFn = (
  agentId: AgentId,
  distro: string,
  workDir: string,
  title?: string,
  resumeToken?: string | null,
  runtimeKind?: SessionRuntimeKind,
) => void;

export type LauncherConfirmFn = (
  agentId: AgentId,
  distro: string,
  workDir: string,
  runtimeKind?: SessionRuntimeKind,
) => void;

/**
 * 런처 onConfirm 계약(agentId, distro, workDir, runtimeKind?)을 createSession(6-인자)에 위치 맞춰
 * 연결한다. createSession에 직접 바인딩하면 runtimeKind가 title 슬롯으로 새어 들어가, direct 세션이
 * 조용히 pty로 떨어지고 탭 제목이 runtimeKind 문자열로 표시된다(10 §5 회귀 방지).
 *
 * title은 createSession 기본값(workDir basename)을 쓰도록 undefined로, resumeToken은 새 세션이므로
 * null로 넘긴다.
 */
export function bindLauncherSessionConfirm(
  createSession: CreateSessionFn,
): LauncherConfirmFn {
  return (agentId, distro, workDir, runtimeKind) => {
    createSession(agentId, distro, workDir, undefined, null, runtimeKind);
  };
}
