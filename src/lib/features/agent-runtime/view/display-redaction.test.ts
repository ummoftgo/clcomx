/**
 * display-redaction 테스트 — TB-4 표시 직전 credential-like 값 마스킹(09 §5.1/§5.2).
 */

import { describe, expect, it } from "vitest";
import { redactDisplayText, stringifyRedactedRaw } from "../service/display-redaction";

describe("display-redaction", () => {
  it("redacts auth, cookie, password and resume-token shaped raw JSON fields", () => {
    const text = stringifyRedactedRaw({
      websocket: { authToken: "ws-secret-token" },
      headers: {
        Authorization: "Token account-secret",
        Cookie: "sid=session-secret",
      },
      password: "password-secret",
      providerResumeToken: "resume-secret",
      safeUrl: "https://api.example.test",
    });

    expect(text).toContain("https://api.example.test");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("ws-secret-token");
    expect(text).not.toContain("account-secret");
    expect(text).not.toContain("session-secret");
    expect(text).not.toContain("password-secret");
    expect(text).not.toContain("resume-secret");
  });

  it("redacts header-like auth and cookie values in plain display text", () => {
    const text = redactDisplayText(
      [
        "Authorization: Token account-secret",
        "Cookie: sid=session-secret",
        "X-API-Key: x-api-secret",
        "safe line",
      ].join("\n"),
    );

    expect(text).toContain("safe line");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("account-secret");
    expect(text).not.toContain("session-secret");
    expect(text).not.toContain("x-api-secret");
  });

  it("does not expose raw JSON-RPC envelopes in displayed raw details", () => {
    const text = stringifyRedactedRaw({
      jsonrpc: "2.0",
      id: 42,
      method: "session/request_permission",
      params: {
        command: "cat secret.txt",
        authorization: "Bearer account-token-123",
      },
    });

    expect(text).toContain("[REDACTED_JSONRPC_ENVELOPE]");
    expect(text).not.toContain("jsonrpc");
    expect(text).not.toContain("session/request_permission");
    expect(text).not.toContain("params");
    expect(text).not.toContain("account-token-123");
  });

  it("redacts MCP server env object values in displayed raw details", () => {
    const text = stringifyRedactedRaw({
      mcpServers: {
        docs: {
          command: "node",
          args: ["server.js"],
          env: {
            SAFE_ROUTING_HINT: "workspace-alpha",
            FEATURE_FLAG: "enabled",
          },
        },
      },
    });

    expect(text).toContain("mcpServers");
    expect(text).toContain("SAFE_ROUTING_HINT");
    expect(text).toContain("FEATURE_FLAG");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("workspace-alpha");
    expect(text).not.toContain("enabled");
  });
});
