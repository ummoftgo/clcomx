/**
 * Claude ACP 어댑터 — WSL launch 파라미터 생성(06 §2).
 *
 * S1 정본(command 비제어): adapter는 실행 executable(node 절대경로)을 생성하지 않는다.
 * backend가 provider="claude"로 신뢰 node 절대경로를 resolve한다(R4, 07 §8.1). adapter가 제어하는 것은
 * args(=[adapterEntryPath], 검증 대상)·distro·workDir·env(non-secret)뿐이다.
 */

import type { AgentRuntimeStartParams } from "../../service/transport";

/** buildClaudeAcpLaunchParams 입력(06 §2.2). */
export interface ClaudeAcpLaunchConfig {
  distro: string;
  /** WSL absolute path. ACP cwd는 absolute 필수(§7.3). */
  workDir: string;
  /**
   * WSL 안 claude-agent-acp dist/index.js 절대경로.
   * renderer 자유 입력이 아니다(S1): backend가 resolve/검증하는 대상이며 adapter는 그 값을 args[0]에 실을 뿐이다.
   */
  adapterEntryPath: string;
  /**
   * non-secret env 전용(C1 보안 경계, 07 §5.1). ANTHROPIC_API_KEY/OAuth token 등 secret은 절대 넣지 않는다 —
   * 이 env는 launch argv `-e env KEY=VAL` 경로로 흘러 OS 관측면(ps, /proc/<pid>/cmdline)에 평문 노출된다.
   */
  env?: Record<string, string>;
}

/**
 * Claude ACP launch용 AgentRuntimeStartParams(15 §8.1 jsonrpc-stdio + provider:"claude") 생성.
 * command(node)는 만들지 않는다(S1) — args=[adapterEntryPath]만 채운다.
 */
export function buildClaudeAcpLaunchParams(cfg: ClaudeAcpLaunchConfig): AgentRuntimeStartParams {
  return {
    transportKind: "jsonrpc-stdio",
    provider: "claude",
    distro: cfg.distro,
    workDir: cfg.workDir,
    // backend allowlist(07 §8.1)는 claude일 때 args.length==1 && args[0]==검증된 adapterEntryPath를 요구한다.
    args: [cfg.adapterEntryPath],
    // C1 경계: env는 non-secret 전용이다.
    env: cfg.env,
  };
}
