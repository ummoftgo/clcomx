/**
 * Agent runtime 표시 경계 redaction 유틸(09 §5.2 TB-4).
 *
 * rawInput/rawOutput, transcript text, fallback 진단 문구를 렌더·상태 노출 직전에만 마스킹한다.
 * normalize 전 원본 event/raw는 라우팅·감사용으로 보존하고, 화면/진단 상태에 나가는 문자열에서
 * credential-like 값만 줄인다.
 */

/** 표시용 문자열에서 credential-like 값을 `[REDACTED]`로 치환한다. */
export function redactDisplayText(value: string): string {
  return value
    .replace(
      /("(?:[^"]*(?:api[_-]?key|auth[_-]?token|bearer[_-]?token|access[_-]?token|refresh[_-]?token|resume[_-]?token|authorization|cookie|password|secret|credential)[^"]*)"\s*:\s*")([^"]+)(")/gi,
      `$1[REDACTED]$3`,
    )
    .replace(
      /\b(?:ANTHROPIC_AUTH_TOKEN|AWS_BEARER_TOKEN_BEDROCK|ANTHROPIC_API_KEY|OPENAI_API_KEY|[A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|BEARER_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|RESUME_TOKEN|AUTHORIZATION|COOKIE|PASSWORD|SECRET|CREDENTIAL)[A-Z0-9_]*)=([^\s"']+)/g,
      (match) => match.replace(/=([^\s"']+)/, "=[REDACTED]"),
    )
    .replace(
      /\b((?:Authorization|Cookie|Set-Cookie|X-API-Key|API-Key|Password)\s*[:=]\s*)([^\r\n]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{12,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bghp_[A-Za-z0-9_]+\b/g, "[REDACTED]");
}

/** JSON-RPC envelope처럼 보이는 object인지 판정한다. */
function isJsonRpcEnvelope(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.jsonrpc === "2.0" ||
    (typeof rec.method === "string" && ("params" in rec || "id" in rec)) ||
    "result" in rec ||
    "error" in rec
  );
}

/** 표시용 raw에서 JSON-RPC envelope 구조 자체를 숨긴다. 원본 raw는 reducer/store에 그대로 남긴다. */
function scrubJsonRpcEnvelopeForDisplay(value: unknown): unknown {
  if (isJsonRpcEnvelope(value)) return "[REDACTED_JSONRPC_ENVELOPE]";
  if (Array.isArray(value)) return value.map(scrubJsonRpcEnvelopeForDisplay);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        scrubJsonRpcEnvelopeForDisplay(child),
      ]),
    );
  }
  return value;
}

/** 표시용 raw의 env map 값은 key만 남기고 숨긴다(MCP/command env 표시 경계). */
export function scrubEnvValuesForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubEnvValuesForDisplay);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key === "env" && child && typeof child === "object" && !Array.isArray(child)) {
          return [
            key,
            Object.fromEntries(
              Object.keys(child as Record<string, unknown>).map((envKey) => [
                envKey,
                "[REDACTED]",
              ]),
            ),
          ];
        }

        return [key, scrubEnvValuesForDisplay(child)];
      }),
    );
  }
  return value;
}

/** unknown raw 값을 redacted pretty JSON 문자열로 변환한다. */
export function stringifyRedactedRaw(value: unknown): string {
  try {
    return redactDisplayText(
      JSON.stringify(
        scrubEnvValuesForDisplay(scrubJsonRpcEnvelopeForDisplay(value)),
        null,
        2,
      ) ?? "",
    );
  } catch {
    return redactDisplayText(String(value));
  }
}
