/**
 * Claude ACP 어댑터 — initialize 요청 생성 + 응답 파싱(06 §3.2).
 *
 * protocolVersion=1 고정(ACP wire v1). capability **위치 비대칭** 정확 판독:
 * loadSession은 agentCapabilities.loadSession(직속 bool), resume은 agentCapabilities.sessionCapabilities.resume(중첩).
 */

import type { JsonRpcMessage } from "../../service/transport";
import type { ParsedInitialize } from "../../contracts/claude-acp";

/** initialize에서 광고할 client capability(06 §3.2 결정표 1차 값). */
export interface ClaudeAcpClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  terminal: boolean;
  auth?: { terminal: boolean; _meta?: Record<string, unknown> };
  elicitation?: { form: null; url: null } | null;
  _meta?: Record<string, unknown>;
}

/** 1차 client capability(fs/terminal/auth/elicitation/Claude meta 모두 미광고, 06 §3.2 / OQ-43). */
export const DEFAULT_CLIENT_CAPABILITIES: ClaudeAcpClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false, _meta: { gateway: false } },
  elicitation: { form: null, url: null },
  _meta: { terminal_output: false, "terminal-auth": false },
};

/**
 * initialize 요청 message 생성(ref-acp §3.1). 송신·응답 await는 rpcRequest(§3.1a)가 담당하고
 * 이 함수는 message만 만든다.
 */
export function buildInitializeRequest(opts: {
  id: string | number;
  appVersion: string;
  capabilities?: ClaudeAcpClientCapabilities;
}): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: opts.id,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: opts.capabilities ?? DEFAULT_CLIENT_CAPABILITIES,
      clientInfo: { name: "clcomx", version: opts.appVersion },
    },
  };
}

/** initialize 응답 파싱 실패(protocolVersion 불일치 등). 호출부가 status→failed + fallback로 전이. */
export class InitializeProtocolError extends Error {
  constructor(
    message: string,
    /** 수신한 protocolVersion(불일치 진단용). */
    public readonly received?: unknown,
  ) {
    super(message);
    this.name = "InitializeProtocolError";
  }
}

/**
 * initialize result 파싱·검증(ref-acp §3.1/§3.2/§3.5).
 * 1. protocolVersion !== 1이면 InitializeProtocolError throw(연결 종료·fallback 신호, §9).
 * 2. capability 위치 비대칭: loadSession=top-level bool, resume=sessionCapabilities.resume(존재=지원).
 * 3. agentCapabilities 값은 하드코딩하지 않고 응답에서 읽는다(0.x minor마다 변동, ref-claude-agent-acp §4).
 */
export function parseInitializeResponse(result: unknown): ParsedInitialize {
  const r = (result ?? {}) as Record<string, unknown>;
  const protocolVersion = r.protocolVersion;
  // 규칙 1: protocolVersion 불일치 → protocol error(§3.2 규칙 1).
  if (protocolVersion !== 1) {
    throw new InitializeProtocolError(
      `unsupported ACP protocolVersion (expected 1, got ${String(protocolVersion)})`,
      protocolVersion,
    );
  }

  const agentCaps = (r.agentCapabilities ?? {}) as Record<string, unknown>;
  // 규칙 2: loadSession은 agentCapabilities 직속 bool.
  const canLoad = agentCaps.loadSession === true;
  // 규칙 2: resume은 sessionCapabilities.resume(존재=지원). 한쪽에서 다른 쪽을 찾으면 항상 미지원 오판.
  const sessionCaps = (agentCaps.sessionCapabilities ?? {}) as Record<string, unknown>;
  const resumeCap = sessionCaps.resume;
  const canResume = resumeCap !== undefined && resumeCap !== null;

  const promptCaps = (agentCaps.promptCapabilities ?? {}) as Record<string, unknown>;
  const promptImage = promptCaps.image === true;
  const promptEmbeddedContext = promptCaps.embeddedContext === true;

  // authMethods가 비어있지 않으면 인증 미완 가능성(§3.3).
  const authMethodsRaw = Array.isArray(r.authMethods) ? r.authMethods : [];
  const authMethods = authMethodsRaw.map((m) => {
    const mm = (m ?? {}) as Record<string, unknown>;
    return {
      id: String(mm.id ?? ""),
      name: String(mm.name ?? ""),
      description: typeof mm.description === "string" ? mm.description : undefined,
    };
  });

  const agentInfoRaw = (r.agentInfo ?? undefined) as Record<string, unknown> | undefined;
  const agentInfo = agentInfoRaw
    ? {
        name: typeof agentInfoRaw.name === "string" ? agentInfoRaw.name : undefined,
        version: typeof agentInfoRaw.version === "string" ? agentInfoRaw.version : undefined,
      }
    : undefined;

  return {
    protocolVersion: 1,
    canLoad,
    canResume,
    promptImage,
    promptEmbeddedContext,
    authMethods,
    agentInfo,
    rawAgentCapabilities: r.agentCapabilities,
  };
}
