import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntimePort } from "../contracts/runtime-port";
import type { ClaudeAcpAdapterDeps } from "../contracts/claude-acp";
import type { CodexAdapterDeps } from "../adapters/codex/codex-app-server-adapter";
import type { AgentRuntimeEvent } from "./transport";
import { AGENT_RUNTIME_EVENTS } from "./transport";
import { createDefaultPortFactory } from "./runtime-port-factory";

const mocks = vi.hoisted(() => {
  const listenRegistrations: Array<{
    event: string;
    handler: (e: { payload: AgentRuntimeEvent }) => void;
  }> = [];
  const unlisten = vi.fn();
  const listen = vi.fn(async (event: string, handler: (e: { payload: AgentRuntimeEvent }) => void) => {
    listenRegistrations.push({ event, handler });
    return unlisten;
  });
  return {
    listenRegistrations,
    unlisten,
    listen,
    invoke: vi.fn(async () => undefined as unknown),
    createCodexAppServerAdapter: vi.fn(),
    createClaudeAcpAdapter: vi.fn(),
    codexDeps: undefined as unknown,
    claudeDeps: undefined as unknown,
  };
});

vi.mock("../../../tauri/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("../../../tauri/event", () => ({
  listen: mocks.listen,
}));

vi.mock("../adapters/codex/codex-app-server-adapter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../adapters/codex/codex-app-server-adapter")>();
  return {
    ...actual,
    createCodexAppServerAdapter: mocks.createCodexAppServerAdapter,
  };
});

vi.mock("../adapters/claude-acp/claude-acp-adapter", () => ({
  createClaudeAcpAdapter: mocks.createClaudeAcpAdapter,
}));

beforeEach(() => {
  mocks.listenRegistrations.length = 0;
  mocks.unlisten.mockClear();
  mocks.listen.mockClear();
  mocks.invoke.mockClear();
  mocks.codexDeps = undefined;
  mocks.claudeDeps = undefined;
  mocks.createCodexAppServerAdapter.mockReset();
  mocks.createCodexAppServerAdapter.mockImplementation((deps: CodexAdapterDeps) => {
    mocks.codexDeps = deps;
    return {} as AgentRuntimePort;
  });
  mocks.createClaudeAcpAdapter.mockReset();
  mocks.createClaudeAcpAdapter.mockImplementation((deps: ClaudeAcpAdapterDeps) => {
    mocks.claudeDeps = deps;
    return {} as AgentRuntimePort;
  });
});

/**
 * 캡처된 Tauri listen registration 중 지정 event 채널의 handler를 호출한다.
 * @param event 발생시킬 Tauri event 이름.
 * @param payload handler에 전달할 runtime event payload.
 */
function fire(event: string, payload: AgentRuntimeEvent): void {
  for (const registration of mocks.listenRegistrations) {
    if (registration.event === event) registration.handler({ payload });
  }
}

describe("createDefaultPortFactory", () => {
  it("Claude subscribeRuntime ignores payloads whose type does not match the Tauri event channel", () => {
    const factory = createDefaultPortFactory({ appVersion: "1.2.3" });
    factory("direct-claude");
    const deps = mocks.claudeDeps as ClaudeAcpAdapterDeps;
    const received: AgentRuntimeEvent[] = [];

    deps.subscribeRuntime(42, (event) => received.push(event));

    fire(AGENT_RUNTIME_EVENTS.stderr, {
      type: "message",
      runtimeId: 42,
      message: { id: 1, result: {} },
    });
    fire(AGENT_RUNTIME_EVENTS.message, {
      type: "message",
      runtimeId: 42,
      message: { id: 2, result: {} },
    });

    expect(received).toEqual([
      {
        type: "message",
        runtimeId: 42,
        message: { id: 2, result: {} },
      },
    ]);
  });

  it("Codex listenRuntime ignores payloads whose type does not match the Tauri event channel", async () => {
    const factory = createDefaultPortFactory({ appVersion: "1.2.3" });
    factory("direct-codex");
    const deps = mocks.codexDeps as CodexAdapterDeps;
    const received: AgentRuntimeEvent[] = [];

    await deps.listenRuntime(AGENT_RUNTIME_EVENTS.stderr, (event) => {
      received.push(event.payload);
    });

    fire(AGENT_RUNTIME_EVENTS.stderr, {
      type: "message",
      runtimeId: 7,
      message: { id: 1, result: {} },
    });
    fire(AGENT_RUNTIME_EVENTS.stderr, {
      type: "stderr",
      runtimeId: 7,
      line: "diagnostic",
    });

    expect(received).toEqual([
      {
        type: "stderr",
        runtimeId: 7,
        line: "diagnostic",
      },
    ]);
  });
});
