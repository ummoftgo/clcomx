import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Direct Agent Runtime transport 단위 테스트. invoke/listen을 모킹해 wire 매핑·구독 필터링을 검증한다
 * (11 §5.6/§5.7 대응 — frontend 측). `../../../tauri/core`·`../../../tauri/event`를 모킹한다.
 */

interface ListenRegistration {
  event: string;
  handler: (e: { payload: unknown }) => void;
}

const mocks = vi.hoisted(() => {
  const invokeMock = vi.fn(async () => undefined as unknown);
  const listenRegistrations: ListenRegistration[] = [];
  const unlistenMock = vi.fn();
  const listenMock = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    listenRegistrations.push({ event, handler });
    return unlistenMock;
  });
  return { invokeMock, listenMock, unlistenMock, listenRegistrations };
});

vi.mock("../../../tauri/core", () => ({
  invoke: mocks.invokeMock,
}));
vi.mock("../../../tauri/event", () => ({
  listen: mocks.listenMock,
}));

import {
  agentRuntimeStart,
  agentRuntimeSend,
  agentRuntimeCancel,
  agentRuntimeShutdown,
  agentRuntimeGetSnapshot,
  agentRuntimeResolveAdapterEntry,
  createAgentTransportController,
  AGENT_RUNTIME_EVENTS,
  type AgentRuntimeStartParams,
} from "./transport";
import * as transportModule from "./transport";

beforeEach(() => {
  mocks.invokeMock.mockReset();
  mocks.invokeMock.mockResolvedValue(undefined as unknown);
  mocks.listenMock.mockClear();
  mocks.unlistenMock.mockClear();
  mocks.listenRegistrations.length = 0;
});

function lastInvoke() {
  const calls = mocks.invokeMock.mock.calls;
  return calls[calls.length - 1] as unknown as [string, Record<string, unknown>];
}

describe("invoke 래퍼", () => {
  it("agentRuntimeStart는 params를 래핑해 호출하고 RuntimeId를 반환한다", async () => {
    mocks.invokeMock.mockResolvedValueOnce(7);
    const params: AgentRuntimeStartParams = {
      transportKind: "jsonrpc-stdio",
      provider: "codex",
      distro: "Ubuntu-24.04",
      workDir: "/home/tester/work",
      args: ["app-server", "--stdio"],
    };
    const id = await agentRuntimeStart(params);
    expect(id).toBe(7);
    const [cmd, payload] = lastInvoke();
    expect(cmd).toBe("agent_runtime_start");
    expect(payload).toEqual({ params });
  });

  it("agentRuntimeSend는 runtimeId/message를 camelCase로 넘긴다", async () => {
    await agentRuntimeSend(3, { id: 1, method: "initialize", params: {} });
    const [cmd, payload] = lastInvoke();
    expect(cmd).toBe("agent_runtime_send");
    expect(payload.runtimeId).toBe(3);
    expect((payload.message as { method: string }).method).toBe("initialize");
  });

  it("agentRuntimeCancel은 target을 그대로 전달한다", async () => {
    await agentRuntimeCancel(3, { type: "process" });
    const [cmd, payload] = lastInvoke();
    expect(cmd).toBe("agent_runtime_cancel");
    expect(payload).toEqual({ runtimeId: 3, target: { type: "process" } });
  });

  it("agentRuntimeShutdown은 runtimeId만 넘긴다", async () => {
    await agentRuntimeShutdown(9);
    const [cmd, payload] = lastInvoke();
    expect(cmd).toBe("agent_runtime_shutdown");
    expect(payload).toEqual({ runtimeId: 9 });
  });

  it("agentRuntimeGetSnapshot은 snapshot을 반환한다", async () => {
    mocks.invokeMock.mockResolvedValueOnce({
      runtimeId: 1,
      provider: "codex",
      status: "running",
      startedAt: 100,
      pendingRequestIds: [],
    });
    const snap = await agentRuntimeGetSnapshot(1);
    expect(snap.provider).toBe("codex");
    expect(snap.status).toBe("running");
  });

  it("agentRuntimeResolveAdapterEntry는 provider/distro를 넘겨 entry path를 반환한다", async () => {
    mocks.invokeMock.mockResolvedValueOnce("/opt/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
    const entryPath = await agentRuntimeResolveAdapterEntry("claude", "Ubuntu-24.04");
    expect(entryPath).toContain("claude-agent-acp/dist/index.js");
    const [cmd, payload] = lastInvoke();
    expect(cmd).toBe("agent_runtime_resolve_adapter_entry");
    expect(payload).toEqual({ provider: "claude", distro: "Ubuntu-24.04" });
  });
});

describe("createAgentTransportController", () => {
  it("exports the ordered runtime event name list from the transport boundary", () => {
    expect((transportModule as { AGENT_RUNTIME_EVENT_NAMES?: readonly string[] }).AGENT_RUNTIME_EVENT_NAMES).toEqual([
      AGENT_RUNTIME_EVENTS.message,
      AGENT_RUNTIME_EVENTS.stderr,
      AGENT_RUNTIME_EVENTS.exit,
      AGENT_RUNTIME_EVENTS.error,
      AGENT_RUNTIME_EVENTS.backpressure,
    ]);
  });

  it("diagnostic event만 listen하고 raw message bridge는 public controller에 노출하지 않는다", async () => {
    const received: string[] = [];
    const controller = createAgentTransportController(5, {
      onStderr: (rid, line) => received.push(`stderr:${rid}:${line}`),
      onExit: (rid, code) => received.push(`exit:${rid}:${code}`),
      onError: (rid, _msg, recoverable, code) => received.push(`error:${rid}:${recoverable}:${code}`),
      onBackpressure: (rid, dropped) => received.push(`bp:${rid}:${dropped}`),
    });
    await controller.start();

    expect(mocks.listenMock).toHaveBeenCalledTimes(4);
    const events = mocks.listenRegistrations.map((r) => r.event);
    expect(events).toEqual([
      AGENT_RUNTIME_EVENTS.stderr,
      AGENT_RUNTIME_EVENTS.exit,
      AGENT_RUNTIME_EVENTS.error,
      AGENT_RUNTIME_EVENTS.backpressure,
    ]);

    function fire(event: string, payload: unknown) {
      for (const reg of mocks.listenRegistrations) {
        if (reg.event === event) reg.handler({ payload });
      }
    }

    // raw message는 provider adapter 전용 bridge라 public controller가 구독하지 않는다(OQ-59).
    fire(AGENT_RUNTIME_EVENTS.message, {
      type: "message",
      runtimeId: 5,
      message: { id: 1, result: {} },
    });
    // 일치 runtimeId(5) diagnostic event → 디스패치.
    fire(AGENT_RUNTIME_EVENTS.stderr, { type: "stderr", runtimeId: 5, line: "log" });
    fire(AGENT_RUNTIME_EVENTS.exit, { type: "exit", runtimeId: 5, code: 0 });
    fire(AGENT_RUNTIME_EVENTS.error, {
      type: "error",
      runtimeId: 5,
      message: "bad",
      recoverable: true,
      code: "framing_broken",
    });
    fire(AGENT_RUNTIME_EVENTS.backpressure, {
      type: "backpressure",
      runtimeId: 5,
      droppedMessages: 256,
    });

    // 다른 runtimeId(99) → 무시.
    fire(AGENT_RUNTIME_EVENTS.message, {
      type: "message",
      runtimeId: 99,
      message: { id: 2, result: {} },
    });

    expect(received).toEqual(["stderr:5:log", "exit:5:0", "error:5:true:framing_broken", "bp:5:256"]);
  });

  it("dispose는 모든 unlisten을 호출한다", async () => {
    const controller = createAgentTransportController(1, {});
    await controller.start();
    await controller.dispose();
    expect(mocks.unlistenMock).toHaveBeenCalledTimes(4);
  });

  it("start를 중복 호출해도 구독은 한 번만 등록한다", async () => {
    const controller = createAgentTransportController(1, {});
    await controller.start();
    await controller.start();
    expect(mocks.listenMock).toHaveBeenCalledTimes(4);
  });

  it("dispose가 start 중 listen 등록 완료보다 먼저 호출되면 늦게 도착한 구독도 해제한다", async () => {
    const lateUnlisten = vi.fn();
    const resolvers: Array<() => void> = [];
    mocks.listenMock.mockImplementation(
      async (event: string, handler: (e: { payload: unknown }) => void) => {
        mocks.listenRegistrations.push({ event, handler });
        await new Promise<void>((resolve) => resolvers.push(resolve));
        return lateUnlisten;
      },
    );

    const controller = createAgentTransportController(1, {});
    const startPromise = controller.start();
    expect(mocks.listenMock).toHaveBeenCalledTimes(4);

    await controller.dispose();
    for (const resolve of resolvers) resolve();
    await startPromise;

    expect(lateUnlisten).toHaveBeenCalledTimes(4);
  });
});
