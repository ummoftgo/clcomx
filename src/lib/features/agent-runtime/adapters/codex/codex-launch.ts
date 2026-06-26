/**
 * Direct Agent Runtime — Codex app-server launch params 생성(05 §2.2).
 *
 * S1 정본: 어댑터/renderer는 실행 파일 `command`를 만들지 않는다. backend가
 * `provider="codex"`로 신뢰 절대경로를 resolve·재검증한다(07 §8.1). 어댑터는
 * provider/distro/workDir/args(검증 대상)/env(non-secret)만 채운다.
 */

import type { AgentRuntimeStartParams } from "../../service/transport";

/** buildCodexStartParams 입력. workDir는 WSL absolute path(backend canonicalize). */
export interface CodexLaunchInput {
  /** WSL distro 이름. */
  distro: string;
  /** WSL absolute path(backend가 canonicalize, 07 §WSL 경계). */
  workDir: string;
  /** ⚠️ non-secret env 전용(07 §5.1·09). secret(API key/token)은 argv 비경유. */
  extraEnv?: Record<string, string>;
}

/**
 * Codex app-server 기동 파라미터(`AgentRuntimeStartParams`, 15 §8.1)를 만든다.
 * - ref-codex §1.1: stdio 기본. 명시적으로 `--stdio` 부여(experimental 플래그 불필요).
 * - S1 정본: command 미생성 — backend가 provider="codex"로 신뢰 절대경로 resolve.
 * - 07 §8.1: backend가 args를 정확히 `["app-server","--stdio"]`로 재검증한다.
 * @param input distro/workDir/extraEnv.
 */
export function buildCodexStartParams(input: CodexLaunchInput): AgentRuntimeStartParams {
  return {
    transportKind: "jsonrpc-stdio",
    provider: "codex",
    distro: input.distro,
    workDir: input.workDir,
    // 07 §8.1: backend가 정확히 ["app-server","--stdio"]로 재검증(동명 바이너리 우회 불가).
    args: ["app-server", "--stdio"],
    // non-secret 전용(07 §5.1·09). secret은 argv 비경유(env()+WSLENV passthrough).
    env: input.extraEnv,
  };
}
