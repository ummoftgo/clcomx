/**
 * Claude ACP — initialize 요청/응답 단위 테스트(11 §4.1, CL-1..CL-3).
 * protocolVersion=1, capability 위치 비대칭(loadSession 직속 bool vs sessionCapabilities.resume 중첩).
 */
import { describe, expect, it } from "vitest";
import {
  buildInitializeRequest,
  DEFAULT_CLIENT_CAPABILITIES,
  InitializeProtocolError,
  parseInitializeResponse,
} from "./claude-acp-initialize";

describe("buildInitializeRequest (CL-1)", () => {
  it("CL-1: {jsonrpc:2.0, protocolVersion:1, clientCapabilities, clientInfo} 전송", () => {
    const msg = buildInitializeRequest({ id: 1, appVersion: "0.9.0" }) as {
      jsonrpc: string;
      method: string;
      params: { protocolVersion: number; clientInfo: { name: string; version: string }; clientCapabilities: unknown };
    };
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.method).toBe("initialize");
    expect(msg.params.protocolVersion).toBe(1);
    expect(msg.params.clientInfo).toEqual({ name: "clcomx", version: "0.9.0" });
    expect(msg.params.clientCapabilities).toEqual(DEFAULT_CLIENT_CAPABILITIES);
  });

  it("OQ-43: fs/terminal/auth/elicitation/Claude meta capability를 보수적으로 미광고", () => {
    expect(DEFAULT_CLIENT_CAPABILITIES).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      auth: { terminal: false, _meta: { gateway: false } },
      elicitation: { form: null, url: null },
      _meta: { terminal_output: false, "terminal-auth": false },
    });

    const msg = buildInitializeRequest({ id: "init-1", appVersion: "0.9.0" }) as {
      params: { clientCapabilities: unknown };
    };
    expect(msg.params.clientCapabilities).toEqual(DEFAULT_CLIENT_CAPABILITIES);
  });
});

describe("parseInitializeResponse (CL-2/CL-3)", () => {
  it("CL-2: capability 위치 비대칭 — loadSession 직속 bool, resume sessionCapabilities 중첩", () => {
    const parsed = parseInitializeResponse({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        promptCapabilities: { image: true, embeddedContext: true },
      },
      agentInfo: { name: "claude-agent-acp", version: "0.51.0" },
    });
    expect(parsed.canLoad).toBe(true);
    expect(parsed.canResume).toBe(true);
    expect(parsed.promptImage).toBe(true);
    expect(parsed.promptEmbeddedContext).toBe(true);
    expect(parsed.agentInfo).toEqual({ name: "claude-agent-acp", version: "0.51.0" });
  });

  it("resume이 top-level이 아니라 sessionCapabilities에만 있을 때 정확 판독", () => {
    // loadSession은 없고 resume만 있는 케이스 → canLoad=false, canResume=true.
    const parsed = parseInitializeResponse({
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    });
    expect(parsed.canLoad).toBe(false);
    expect(parsed.canResume).toBe(true);
  });

  it("capability 부재 시 모두 false", () => {
    const parsed = parseInitializeResponse({ protocolVersion: 1, agentCapabilities: {} });
    expect(parsed.canLoad).toBe(false);
    expect(parsed.canResume).toBe(false);
    expect(parsed.promptImage).toBe(false);
  });

  it("CL-3: protocolVersion≠1 → InitializeProtocolError throw", () => {
    expect(() => parseInitializeResponse({ protocolVersion: 2 })).toThrow(InitializeProtocolError);
  });

  it("authMethods 파싱", () => {
    const parsed = parseInitializeResponse({
      protocolVersion: 1,
      authMethods: [{ id: "gateway", name: "Gateway", description: "via gateway" }],
    });
    expect(parsed.authMethods).toEqual([{ id: "gateway", name: "Gateway", description: "via gateway" }]);
  });
});
