/**
 * Direct runtime launch env 검증 헬퍼.
 *
 * `AgentRuntimeStartParams.env`는 argv `-e env KEY=VAL` 경로로 전달되므로 non-secret만 허용한다.
 */

const SECRET_KEY_RE =
  /(?:api[_-]?key|auth[_-]?token|bearer[_-]?token|access[_-]?token|refresh[_-]?token|resume[_-]?token|authorization|cookie|password|secret|credential)/i;

const SECRET_VALUE_RES = [
  /\bsk-[A-Za-z0-9_-]{6,}\b/i,
  /\bsk-ant-[A-Za-z0-9_-]{6,}\b/i,
  /\bghp_[A-Za-z0-9_]{6,}\b/i,
  /\bAKIA[A-Z0-9]{8,}\b/,
  /\bBearer\s+\S+/i,
  /\b(?:ANTHROPIC_AUTH_TOKEN|AWS_BEARER_TOKEN_BEDROCK|OPENAI_API_KEY)\s*=/i,
] as const;

/**
 * launch env가 non-secret 계약을 지키는지 검사한다.
 * @param provider 오류 메시지에 표시할 provider 이름.
 * @param env 검사할 launch env map.
 */
export function assertNonSecretLaunchEnv(
  provider: "codex" | "claude",
  env: Record<string, string> | undefined,
): void {
  if (!env) return;
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_KEY_RE.test(key)) {
      throw new Error(`secret env key is not allowed for ${provider} launch env: ${key}`);
    }
    if (SECRET_VALUE_RES.some((pattern) => pattern.test(value))) {
      throw new Error(`secret-looking env value is not allowed for ${provider} launch env: ${key}`);
    }
  }
}
