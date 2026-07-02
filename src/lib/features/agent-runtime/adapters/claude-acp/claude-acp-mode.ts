/**
 * Claude ACP 어댑터 — session mode / set_config_option wire 생성(06 §8).
 *
 * ACP session mode ↔ SDK permissionMode는 동일 id. mode 6종: auto/default/acceptEdits/bypassPermissions/dontAsk/plan.
 */

import type { JsonRpcMessage } from "../../service/transport";

/** Claude 어댑터가 인식하는 session mode 6종(ref-claude-agent-acp §3). */
export const CLAUDE_SESSION_MODES = [
  "auto",
  "default",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
  "plan",
] as const;
export type ClaudeSessionMode = (typeof CLAUDE_SESSION_MODES)[number];

/** session/set_mode request 생성(ref-acp §10, request → {}). modeId는 availableModes에 존재해야 한다(호출부 검증). */
export function buildSetMode(id: string | number, sessionId: string, modeId: string): JsonRpcMessage {
  return { jsonrpc: "2.0", id, method: "session/set_mode", params: { sessionId, modeId } };
}

/**
 * session/set_config_option request 생성(ref-acp §10).
 * 응답은 빈 객체가 아니라 {configOptions}(전체 set + 현재 값) — 호출부가 빈 result로 가정하지 않는다(§8.2).
 */
export function buildSetConfigOption(
  id: string | number,
  sessionId: string,
  configId: string,
  value: unknown,
): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/set_config_option",
    params: { sessionId, configId, value },
  };
}

/** ACP SessionConfigOption 배열에서 Claude mode selector의 currentValue를 추출한다. */
export function extractModeConfigValue(configOptions: unknown[] | null | undefined): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const option of configOptions) {
    if (!option || typeof option !== "object") continue;
    const record = option as Record<string, unknown>;
    if (record.id !== "mode") continue;
    return typeof record.currentValue === "string" ? record.currentValue : undefined;
  }
  return undefined;
}
