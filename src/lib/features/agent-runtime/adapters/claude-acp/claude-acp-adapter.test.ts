/**
 * Claude ACP — 어댑터 통합 테스트(11 §4.2, CL-4..CL-11, CL-24b, CL-25/26, lifecycle/cancel/shutdown).
 *
 * 모킹 transport: outbound message를 캡처하고, 테스트가 inbound(agent→client) message를 주입한다.
 * RPC request는 method별로 응답을 자동/수동 주입해 lifecycle을 진행한다.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createClaudeAcpAdapter,
  getClaudeAcpUnknownNotificationCount,
  getClaudeAcpUnknownNotificationRawPayloads,
  resetClaudeAcpUnknownNotifications,
} from "./claude-acp-adapter";
import type { ClaudeAcpAdapterDeps } from "../../contracts/claude-acp";
import type { AgentContent, AgentEvent } from "../../contracts/normalized";
import type { AgentRuntimeEvent, JsonRpcMessage, RuntimeId } from "../../service/transport";

/** 모킹 transport 하네스. */
function makeHarness() {
  const outbound: JsonRpcMessage[] = [];
  let handler: ((e: AgentRuntimeEvent) => void) | undefined;
  let nextId = 0;
  const RUNTIME_ID: RuntimeId = 1;

  const deps: ClaudeAcpAdapterDeps = {
    startRuntime: vi.fn(async () => RUNTIME_ID),
    sendMessage: vi.fn(async (_rid: RuntimeId, message: JsonRpcMessage) => {
      outbound.push(message);
    }),
    cancelRuntime: vi.fn(async () => {}),
    shutdownRuntime: vi.fn(async () => {}),
    subscribeRuntime: vi.fn((_rid: RuntimeId, h: (e: AgentRuntimeEvent) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    }),
    resolveLaunch: vi.fn(async () => ({ adapterEntryPath: "/wsl/node_modules/.../dist/index.js" })),
    nextRequestId: () => ++nextId,
    appVersion: "0.9.0",
    now: () => 0,
  };

  /** inbound(agent→client) message 주입. */
  function inject(message: JsonRpcMessage) {
    handler?.({ type: "message", runtimeId: RUNTIME_ID, message });
  }
  function injectEvent(e: AgentRuntimeEvent) {
    handler?.(e);
  }
  /** outbound에 해당 method request가 나올 때까지 flush(동적 import 대기, micro+macro task). */
  async function waitForOutbound(method: string): Promise<JsonRpcMessage> {
    for (let i = 0; i < 50; i++) {
      const req = [...outbound].reverse().find((m) => "method" in m && m.method === method && "id" in m);
      if (req) return req;
      // macrotask로 양보(동적 import resolution은 microtask만으론 부족할 수 있음).
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`no outbound request for ${method}`);
  }
  /** outbound request가 나올 때까지 기다린 뒤 result 응답을 주입(RPC settle). */
  async function respondToLast(method: string, result: unknown) {
    const req = (await waitForOutbound(method)) as { id: string | number };
    inject({ jsonrpc: "2.0", id: req.id, result });
  }
  function lastOutbound() {
    return outbound[outbound.length - 1];
  }

  return { deps, outbound, inject, injectEvent, respondToLast, waitForOutbound, lastOutbound, get RUNTIME_ID() { return RUNTIME_ID; } };
}

/** initialize + session/new 까지 진행해 ready 상태로 만든다. */
async function startReady(
  h: ReturnType<typeof makeHarness>,
  adapter: ReturnType<typeof createClaudeAcpAdapter>,
  _events: AgentEvent[],
  agentCapabilities: Record<string, unknown> = { loadSession: true, sessionCapabilities: { resume: {} } },
) {
  const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
  await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities });
  await h.respondToLast("session/new", { sessionId: "sess-1" });
  return startPromise;
}

function modeConfig(currentValue: string) {
  return {
    id: "mode",
    name: "Mode",
    type: "select",
    currentValue,
    options: [
      { id: "default", name: "Default" },
      { id: "acceptEdits", name: "Accept edits" },
      { id: "bypassPermissions", name: "Bypass permissions" },
      { id: "plan", name: "Plan" },
    ],
  };
}

type RuntimeMetadataEvent = {
  type: "runtime_metadata_changed";
  metadata: {
    sessionMode?: string;
    permissionMode?: string;
  };
};

function metadataEvents(events: AgentEvent[]): RuntimeMetadataEvent[] {
  return events.filter((e) => (e as { type: string }).type === "runtime_metadata_changed") as unknown as RuntimeMetadataEvent[];
}

function lastMetadataEvent(events: AgentEvent[]): RuntimeMetadataEvent | undefined {
  const matches = metadataEvents(events);
  return matches[matches.length - 1];
}

describe("Claude ACP adapter — mode metadata (09 §8)", () => {
  it("returns Claude session and permission mode metadata from session/new", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });

    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.respondToLast("session/new", {
      sessionId: "sess-1",
      modes: { currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan" }] },
      configOptions: [modeConfig("plan")],
    });

    const result = await startPromise;
    expect(result.sessionMode).toBe("plan");
    expect(result.permissionMode).toBe("plan");
  });

  it("returns prompt composer capabilities from initialize", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({
      sessionHandle: "A",
      provider: "claude",
      distro: "Ubuntu",
      workDir: "/home/u/proj",
    });

    await h.respondToLast("initialize", {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
      },
    });
    await h.respondToLast("session/new", { sessionId: "sess-1" });

    const result = await startPromise;
    expect(result.composerCapabilities).toEqual({
      image: true,
      embeddedContext: true,
      audio: false,
    });
  });

  it("exposes availableModes in start metadata for the mode selector", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.respondToLast("session/new", {
      sessionId: "sess-1",
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
    });
    const result = await startPromise;
    expect(result.availableModes).toEqual([
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ]);
  });

  it("setSessionMode: session/set_mode wire를 보내고, 모드 표시는 provider current_mode_update가 권위다", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.respondToLast("session/new", {
      sessionId: "sess-1",
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
    });
    await startPromise;

    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    const setPromise = adapter.setSessionMode!("A", "plan");
    const req = (await h.waitForOutbound("session/set_mode")) as {
      id: string | number;
      params: { sessionId: string; modeId: string };
    };
    expect(req.params).toEqual({ sessionId: "sess-1", modeId: "plan" });
    h.inject({ jsonrpc: "2.0", id: req.id, result: {} });
    await setPromise;

    // 낙관적 반영 없음 — RPC 성공만으로는 metadata event를 만들지 않는다(경쟁 원천 제거).
    expect(metadataEvents(events).length).toBe(0);

    // provider가 current_mode_update로 확정하면 그때 권위 metadata가 반영된다.
    h.inject({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "sess-1", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } },
    });
    expect(lastMetadataEvent(events)?.metadata).toMatchObject({ sessionMode: "plan", permissionMode: "plan" });
  });

  it("setSessionMode: 이전 요청의 늦은 current_mode_update가 최신 요청 확정을 오염시키지 않는다", async () => {
    // 낙관적 반영이 없으므로 모든 모드 표시는 provider echo의 arrival order로 수렴한다:
    // plan 성공 → (아직 echo 없음) → acceptEdits 성공 → 늦은 plan echo 도착 → acceptEdits echo 도착.
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.respondToLast("session/new", {
      sessionId: "sess-1",
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
          { id: "acceptEdits", name: "Accept Edits" },
        ],
      },
    });
    await startPromise;
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    const first = adapter.setSessionMode!("A", "plan");
    await h.respondToLast("session/set_mode", {});
    await first;
    const second = adapter.setSessionMode!("A", "acceptEdits");
    await h.respondToLast("session/set_mode", {});
    await second;

    // provider echo가 요청 순서대로 도착한다(plan 먼저, acceptEdits 나중).
    h.inject({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "sess-1", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } },
    });
    h.inject({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "sess-1", update: { sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" } },
    });

    // 최종 권위 값은 마지막 echo(acceptEdits)다 — 낙관적 반영이 없어 이전 요청의 echo가 최신을 덮지 않는다.
    expect(lastMetadataEvent(events)?.metadata).toMatchObject({ sessionMode: "acceptEdits", permissionMode: "acceptEdits" });
  });

  it("setSessionMode: RPC 실패는 reject되고 모드 표시를 바꾸지 않는다", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.respondToLast("session/new", {
      sessionId: "sess-1",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
    });
    await startPromise;
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    const setPromise = adapter.setSessionMode!("A", "plan");
    const req = (await h.waitForOutbound("session/set_mode")) as { id: string | number };
    h.inject({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "rejected" } });
    await expect(setPromise).rejects.toBeTruthy();

    // 거부는 어떤 모드 metadata event도 만들지 않는다(composer가 권위 값으로 롤백).
    expect(metadataEvents(events).length).toBe(0);
  });

  it("setSessionMode: RPC 성공 후 echo 전 도착한 승인은 요청 모드(bypassPermissions)로 escalation 판정한다", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.respondToLast("session/new", {
      sessionId: "sess-1",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "bypassPermissions", name: "Bypass" }] },
    });
    await startPromise;
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    // bypassPermissions로 전환 RPC 성공(아직 current_mode_update echo 없음).
    const setPromise = adapter.setSessionMode!("A", "bypassPermissions");
    await h.respondToLast("session/set_mode", {});
    await setPromise;

    // echo 전 창에 승인 요청이 먼저 도착 — currentModeId는 아직 default지만 pending 요청 모드로 보수 판정.
    h.inject({
      jsonrpc: "2.0",
      id: 501,
      method: "session/request_permission",
      params: {
        sessionId: "sess-1",
        toolCall: { toolCallId: "tc-1", title: "run" },
        options: [{ optionId: "allow", name: "Allow" }],
      },
    });

    const approvalEvent = events.find((e) => (e as { type: string }).type === "approval_requested") as
      | { request: { severity: string } }
      | undefined;
    expect(approvalEvent?.request.severity).toBe("escalation");
  });

  it("setSessionMode: set_mode 응답 전 도착한 승인도 요청 모드(bypass)로 escalation 판정한다", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.respondToLast("session/new", {
      sessionId: "sess-1",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "bypassPermissions", name: "Bypass" }] },
    });
    await startPromise;
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    // set_mode를 냈지만 아직 응답하지 않은 상태(in-flight).
    const setPromise = adapter.setSessionMode!("A", "bypassPermissions");
    await h.waitForOutbound("session/set_mode");

    // 응답 전에 승인 요청이 먼저 도착 — pending이 in-flight 단계부터 잡혀 escalation이어야 한다.
    h.inject({
      jsonrpc: "2.0",
      id: 701,
      method: "session/request_permission",
      params: { sessionId: "sess-1", toolCall: { toolCallId: "tc-3", title: "run" }, options: [{ optionId: "allow", name: "Allow" }] },
    });
    const approvalEvent = events.find((e) => (e as { type: string }).type === "approval_requested") as
      | { request: { severity: string } }
      | undefined;
    expect(approvalEvent?.request.severity).toBe("escalation");

    await h.respondToLast("session/set_mode", {});
    await setPromise;
  });

  it("setSessionMode: RPC 실패 시 이 시도가 남긴 pending을 되돌린다(정리 불변식)", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.respondToLast("session/new", {
      sessionId: "sess-1",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "bypassPermissions", name: "Bypass" }] },
    });
    await startPromise;
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    const setPromise = adapter.setSessionMode!("A", "bypassPermissions");
    const req = (await h.waitForOutbound("session/set_mode")) as { id: string | number };
    h.inject({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "rejected" } });
    await expect(setPromise).rejects.toBeTruthy();

    // 실패로 pending이 해제됐으므로, 이후 승인은 currentModeId(default) 기준 normal이다.
    h.inject({
      jsonrpc: "2.0",
      id: 702,
      method: "session/request_permission",
      params: { sessionId: "sess-1", toolCall: { toolCallId: "tc-4", title: "run" }, options: [{ optionId: "allow", name: "Allow" }] },
    });
    const approvalEvent = events.find((e) => (e as { type: string }).type === "approval_requested") as
      | { request: { severity: string } }
      | undefined;
    expect(approvalEvent?.request.severity).toBe("normal");
  });

  it("setSessionMode: 비매칭 stale echo는 고위험 pending fail-safe를 풀지 않는다", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.respondToLast("session/new", {
      sessionId: "sess-1",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "bypassPermissions", name: "Bypass" }] },
    });
    await startPromise;
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    // bypass 전환 성공 → pendingRequestedMode=bypassPermissions.
    const setPromise = adapter.setSessionMode!("A", "bypassPermissions");
    await h.respondToLast("session/set_mode", {});
    await setPromise;

    // 실제 bypass echo 전에 저위험 stale echo(default)가 먼저 도착한다.
    h.inject({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "sess-1", update: { sessionUpdate: "current_mode_update", currentModeId: "default" } },
    });

    // 그 뒤 승인 요청 도착 — currentModeId는 default(저위험)지만 고위험 pending이 유지돼 escalation이어야 한다.
    h.inject({
      jsonrpc: "2.0",
      id: 601,
      method: "session/request_permission",
      params: { sessionId: "sess-1", toolCall: { toolCallId: "tc-2", title: "run" }, options: [{ optionId: "allow", name: "Allow" }] },
    });
    const approvalEvent = events.find((e) => (e as { type: string }).type === "approval_requested") as
      | { request: { severity: string } }
      | undefined;
    expect(approvalEvent?.request.severity).toBe("escalation");

    // 실제 bypass echo가 오면 pending이 해제된다(이후 승인은 currentModeId 기준).
    h.inject({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "sess-1", update: { sessionUpdate: "current_mode_update", currentModeId: "bypassPermissions" } },
    });
    expect(lastMetadataEvent(events)?.metadata).toMatchObject({ sessionMode: "bypassPermissions" });
  });

  it("setSessionMode: availableModes에 없는 모드는 wire 전송 없이 거부한다", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.respondToLast("session/new", {
      sessionId: "sess-1",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
    });
    await startPromise;

    await expect(adapter.setSessionMode!("A", "nonexistent")).rejects.toThrow(/unknown session mode/);
    expect(h.outbound.some((m) => "method" in m && m.method === "session/set_mode")).toBe(false);
  });

  it("emits metadata updates for current_mode_update", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    h.inject({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "current_mode_update", currentModeId: "bypassPermissions" },
      },
    });

    expect(lastMetadataEvent(events)?.metadata).toMatchObject({
      sessionMode: "bypassPermissions",
      permissionMode: "bypassPermissions",
    });
  });

  it("emits metadata updates for config_option_update mode currentValue", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    h.inject({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "config_option_update", configOptions: [modeConfig("acceptEdits")] },
      },
    });

    expect(lastMetadataEvent(events)?.metadata).toMatchObject({
      sessionMode: "acceptEdits",
      permissionMode: "acceptEdits",
    });
  });
});

describe("Claude ACP adapter — lifecycle (CL-4/CL-7/CL-8)", () => {
  it("startSession → initialize → session/new → session_started + ready", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const events: AgentEvent[] = [];
    // subscribe는 핸들이 존재해야 하므로 startSession 호출 후 등록할 수 없음 → 먼저 startReady 진행하며 listener를 createRuntime 후 등록.
    // 대신 events 수집을 위해 startSession 내부 emit을 보려면 subscribeEvents가 필요. 여기선 결과 ref만 검증.
    const result = await startReady(h, adapter, events);
    expect(result.ref.sessionId).toBe("sess-1");
    // initialize outbound 확인(CL-1 통합).
    const init = h.outbound.find((m) => "method" in m && m.method === "initialize");
    expect(init).toBeTruthy();
  });

  it("CL-7/CL-8: sendPrompt → running, turn id 합성, stopReason → turn_completed + idle", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    const promptPromise = adapter.sendPrompt("A", { content: [{ type: "text", text: "hi" }] });
    await Promise.resolve();
    // ACP는 라이브 prompt를 wire echo하지 않으므로 로컬 optimistic user_message echo를 넣는다(정확히 1건, running 이전).
    const userEchoes = events.filter((e) => e.type === "user_message");
    expect(userEchoes).toHaveLength(1);
    const userEcho = userEchoes[0];
    expect(userEcho).toMatchObject({
      type: "user_message",
      content: [{ type: "text", text: "hi" }],
      mode: "replace",
    });
    expect(userEcho.ref.turnId).toBe("sess-1:t1");
    expect(userEcho.ref.messageId).toBe("sess-1:t1:u");
    // echo는 running 전이보다 먼저.
    const echoIdx = events.findIndex((e) => e.type === "user_message");
    const runningIdx = events.findIndex((e) => e.type === "session_status_changed" && e.status === "running");
    expect(echoIdx).toBeGreaterThanOrEqual(0);
    expect(echoIdx).toBeLessThan(runningIdx);
    // running 전이.
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "running")).toBe(true);
    // turn id 합성: sess-1:t1.
    const running = events.find((e) => e.type === "session_status_changed" && e.status === "running");
    expect(running?.ref.turnId).toBe("sess-1:t1");

    // update 스트림이 같은 turnId를 받는지.
    h.inject({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "yo" }, messageId: "m1" } } });
    const delta = events.find((e) => e.type === "agent_message_delta");
    expect(delta?.ref.turnId).toBe("sess-1:t1");

    await h.respondToLast("session/prompt", { stopReason: "end_turn" });
    await promptPromise;
    expect(events.some((e) => e.type === "turn_completed" && e.status === "completed")).toBe(true);
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "idle")).toBe(true);
  });

  it("OQ-57: optimistic user echo preserves original non-text content and unique turn message ids", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, [], {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { image: true, embeddedContext: true },
    });
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    const originalContent: AgentContent[] = [
      { type: "image", uri: "data:image/png;base64,QUJD", mimeType: "image/png" },
      { type: "resource", uri: "file:///home/u/proj/a.txt", text: "body" },
    ];
    const firstPrompt = adapter.sendPrompt("A", { content: originalContent });
    await Promise.resolve();
    const firstEcho = events.find((e) => e.type === "user_message");
    expect(firstEcho).toMatchObject({
      type: "user_message",
      ref: { turnId: "sess-1:t1", messageId: "sess-1:t1:u" },
      content: originalContent,
      mode: "replace",
    });
    await h.respondToLast("session/prompt", { stopReason: "end_turn" });
    await firstPrompt;

    const secondPrompt = adapter.sendPrompt("A", { content: [{ type: "text", text: "next" }] });
    await Promise.resolve();
    const userEchoes = events.filter((e) => e.type === "user_message");
    expect(userEchoes).toHaveLength(2);
    expect(userEchoes[1].ref.messageId).toBe("sess-1:t2:u");
    expect(userEchoes[1].ref.messageId).not.toBe(userEchoes[0].ref.messageId);
    await h.respondToLast("session/prompt", { stopReason: "end_turn" });
    await secondPrompt;
  });

  it("gates image and resource prompt content with ACP promptCapabilities", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, [], {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { image: false, embeddedContext: false },
    });
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    const prompt = adapter.sendPrompt("A", {
      content: [
        { type: "text", text: "keep" },
        { type: "image", uri: "data:image/png;base64,QUJD", mimeType: "image/png" },
        { type: "resource", uri: "file:///home/u/proj/a.txt", text: "body" },
      ],
    });

    const promptRequest = await h.waitForOutbound("session/prompt") as {
      params: { prompt: unknown[] };
    };
    expect(promptRequest.params.prompt).toEqual([{ type: "text", text: "keep" }]);
    const echo = events.find((e) => e.type === "user_message");
    expect(echo).toMatchObject({
      type: "user_message",
      content: [{ type: "text", text: "keep" }],
    });

    await h.respondToLast("session/prompt", { stopReason: "end_turn" });
    await prompt;
  });

  it("preserves link-only ACP resources without embeddedContext capability", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, [], {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { image: false, embeddedContext: false },
    });
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    const prompt = adapter.sendPrompt("A", {
      content: [
        { type: "resource", uri: "file:///home/u/proj/a.txt", mimeType: "text/plain" },
        { type: "resource", uri: "file:///home/u/proj/b.txt", text: "embedded" },
      ],
    });

    const promptRequest = await h.waitForOutbound("session/prompt") as {
      params: { prompt: unknown[] };
    };
    expect(promptRequest.params.prompt).toEqual([
      {
        type: "resource_link",
        name: "file:///home/u/proj/a.txt",
        uri: "file:///home/u/proj/a.txt",
        mimeType: "text/plain",
      },
    ]);
    const echo = events.find((e) => e.type === "user_message");
    expect(echo).toMatchObject({
      type: "user_message",
      content: [{ type: "resource", uri: "file:///home/u/proj/a.txt", mimeType: "text/plain" }],
    });

    await h.respondToLast("session/prompt", { stopReason: "end_turn" });
    await prompt;
  });

  it("OQ-56: ACP provider-backed resource search is explicitly unsupported in v1", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    h.outbound.length = 0;

    const results = await adapter.searchResources!("A", {
      query: "app",
      workDir: "/home/u/proj",
      limit: 8,
    });

    expect(results).toEqual([]);
    expect(h.outbound).toEqual([]);
  });

  it("does not send an empty ACP prompt when every content item is gated out", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, [], {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { image: false, embeddedContext: false },
    });
    h.outbound.length = 0;
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    const prompt = adapter.sendPrompt("A", {
      content: [
        { type: "image", uri: "data:image/png;base64,QUJD", mimeType: "image/png" },
        { type: "resource", uri: "file:///home/u/proj/a.txt", text: "body" },
      ],
    });
    await Promise.resolve();
    const sentPrompt = h.outbound.some((m) => "method" in m && m.method === "session/prompt");
    if (sentPrompt) {
      await h.respondToLast("session/prompt", { stopReason: "end_turn" });
      await prompt;
    }

    expect(sentPrompt).toBe(false);
    expect(events.some((e) => e.type === "user_message")).toBe(false);
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "running")).toBe(false);
    expect(events).toContainEqual({
      type: "error",
      ref: { provider: "claude", sessionId: "sess-1", turnId: undefined },
      message: "prompt content is not supported by this ACP session",
      recoverable: true,
    });
  });

  it("maps available_commands_update → available_commands_updated (name 필수, input.hint 추출, 미지 무시)", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    h.inject({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "compact", description: "Compact context", input: { hint: "<turns>" } },
            { name: "/review", description: "Review changes" },
            { name: "plan" },
            { description: "no name — ignored" },
            { name: "" },
          ],
        },
      },
    });

    const evt = events.find((e) => e.type === "available_commands_updated");
    expect(evt).toBeTruthy();
    if (evt?.type !== "available_commands_updated") throw new Error("unreachable");
    expect(evt.commands).toEqual([
      { name: "compact", description: "Compact context", inputHint: "<turns>" },
      { name: "review", description: "Review changes", inputHint: undefined },
      { name: "plan", description: undefined, inputHint: undefined },
    ]);
  });

  it("maps session_info_update title to a session title event", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));

    h.inject({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "session_info_update",
          title: "Provider title",
          updatedAt: "2026-06-28T00:00:00.000Z",
        },
      },
    });

    const evt = events.find((e) => (e as { type: string }).type === "session_title_changed");
    expect(evt).toMatchObject({
      type: "session_title_changed",
      ref: { provider: "claude", sessionId: "sess-1", raw: { updatedAt: "2026-06-28T00:00:00.000Z" } },
      title: "Provider title",
    });
  });

  it("CL-9: stopReason=cancelled → turn_completed{cancelled}", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    const p = adapter.sendPrompt("A", { content: [{ type: "text", text: "x" }] });
    await Promise.resolve();
    await h.respondToLast("session/prompt", { stopReason: "cancelled" });
    await p;
    expect(events.some((e) => e.type === "turn_completed" && e.status === "cancelled")).toBe(true);
  });

  it("CL-10: stopReason=refusal → completed + raw stopReason for UI notice", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    const p = adapter.sendPrompt("A", { content: [{ type: "text", text: "x" }] });
    await Promise.resolve();
    await h.respondToLast("session/prompt", { stopReason: "refusal" });
    await p;

    const completed = events.find((e) => e.type === "turn_completed") as
      | Extract<AgentEvent, { type: "turn_completed" }>
      | undefined;
    expect(completed).toMatchObject({
      type: "turn_completed",
      status: "completed",
      ref: { raw: { stopReason: "refusal" } },
    });
    expect(
      events.some(
        (e) =>
          e.type === "session_status_changed" &&
          e.status === "idle" &&
          e.reason === "refusal",
      ),
    ).toBe(true);
  });

  it("CL-11: stopReason=max_tokens → completed + raw stopReason", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    const p = adapter.sendPrompt("A", { content: [{ type: "text", text: "x" }] });
    await Promise.resolve();
    await h.respondToLast("session/prompt", { stopReason: "max_tokens" });
    await p;

    const completed = events.find((e) => e.type === "turn_completed") as
      | Extract<AgentEvent, { type: "turn_completed" }>
      | undefined;
    expect(completed).toMatchObject({
      type: "turn_completed",
      status: "completed",
      ref: { raw: { stopReason: "max_tokens" } },
    });
  });

  it("CL-11b: unknown stopReason → failed turn + unrecoverable protocol error", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    const p = adapter.sendPrompt("A", { content: [{ type: "text", text: "x" }] });
    await Promise.resolve();
    await h.respondToLast("session/prompt", { stopReason: "unknown_stop" });
    await p;

    const completed = events.find((e) => e.type === "turn_completed") as
      | Extract<AgentEvent, { type: "turn_completed" }>
      | undefined;
    expect(completed).toMatchObject({
      type: "turn_completed",
      status: "failed",
      ref: { raw: { stopReason: "unknown_stop" } },
    });

    const protocolError = events.find((e) => e.type === "error") as
      | Extract<AgentEvent, { type: "error" }>
      | undefined;
    expect(protocolError).toMatchObject({
      type: "error",
      recoverable: false,
      ref: { raw: { stopReason: "unknown_stop" } },
    });
    expect(protocolError?.message).toContain("unknown_stop");
  });

  it("idle 중 늦게 도착한 update는 ref.turnId undefined", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    const p = adapter.sendPrompt("A", { content: [{ type: "text", text: "x" }] });
    await Promise.resolve();
    await h.respondToLast("session/prompt", { stopReason: "end_turn" });
    await p;
    // turn 종료 후 늦은 update.
    h.inject({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" }, messageId: "m9" } } });
    const late = [...events].reverse().find((e) => e.type === "agent_message_delta");
    expect(late?.ref.turnId).toBeUndefined();
  });
});

describe("Claude ACP adapter — replay (CL-5/CL-6)", () => {
  it("CL-5: session/load replay → loadingReplay true during, session_loaded on resolve", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const events: AgentEvent[] = [];
    const startP = adapter.resumeSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/p", providerSessionId: "sess-1", replay: true });
    // initialize outbound가 나오면 createRuntime이 끝나 핸들이 등록됨 → 그 뒤 subscribe.
    await h.waitForOutbound("initialize");
    adapter.subscribeEvents("A", (e) => events.push(e));
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    await h.waitForOutbound("session/load");
    // load request가 나갔는지.
    expect(h.outbound.some((m) => "method" in m && m.method === "session/load")).toBe(true);
    // replay update 주입.
    h.inject({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "past" }, messageId: "u1" } } });
    // load response resolve → session_loaded.
    await h.respondToLast("session/load", {});
    await startP;
    expect(events.some((e) => e.type === "session_loaded")).toBe(true);
  });

  it("CL-6: session/resume → session_loaded (replay 없음)", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const events: AgentEvent[] = [];
    const startP = adapter.resumeSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/p", providerSessionId: "sess-1", replay: false });
    await h.waitForOutbound("initialize");
    adapter.subscribeEvents("A", (e) => events.push(e));
    await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } });
    await h.waitForOutbound("session/resume");
    expect(h.outbound.some((m) => "method" in m && m.method === "session/resume")).toBe(true);
    await h.respondToLast("session/resume", {});
    await startP;
    expect(events.some((e) => e.type === "session_loaded")).toBe(true);
  });
});

describe("Claude ACP adapter — permission + cancel (CL-19/CL-22, 04 §4.2)", () => {
  it("request_permission → approval_requested + requires_action; respond → wire + approval_resolved", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    h.inject({ jsonrpc: "2.0", id: 42, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "tc1", title: "Edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "requires_action")).toBe(true);

    await adapter.respondApproval("A", { requestId: "42", outcome: "selected", optionId: "allow" });
    // wire 응답이 numeric id 42로 나갔는지(R3).
    const resp = h.outbound.find((m) => "result" in m && (m as { id?: unknown }).id === 42) as { id: unknown; result: unknown };
    expect(resp.id).toBe(42);
    expect(resp.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(events.some((e) => e.type === "approval_resolved")).toBe(true);
  });

  it("NM-20: respondApproval(failed)는 provider wire로 전송하지 않는다", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    adapter.subscribeEvents("A", () => undefined);
    h.inject({ jsonrpc: "2.0", id: 42, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "tc1", title: "Edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
    h.outbound.length = 0;

    await adapter.respondApproval("A", { requestId: "42", outcome: "failed" });

    expect(h.outbound).toEqual([]);
  });

  it("SEC-APPROVAL: unknown optionId is rejected before provider wire", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    adapter.subscribeEvents("A", () => undefined);
    h.inject({ jsonrpc: "2.0", id: 42, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "tc1", title: "Edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
    h.outbound.length = 0;

    await expect(
      adapter.respondApproval("A", { requestId: "42", outcome: "selected", optionId: "not-shown" }),
    ).rejects.toThrow("unknown approval optionId");

    expect(h.outbound).toEqual([]);

    await adapter.respondApproval("A", { requestId: "42", outcome: "selected", optionId: "allow" });
    expect(h.outbound[0]).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
  });

  it("CL-22: cancelTurn → pending approval cancelled wire 먼저, 그 다음 session/cancel (approval-first)", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    // active turn 시작.
    const p = adapter.sendPrompt("A", { content: [{ type: "text", text: "x" }] });
    await Promise.resolve();
    h.inject({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "tc1", title: "Edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });

    const beforeLen = h.outbound.length;
    await adapter.cancelTurn("A", "sess-1:t1");
    const after = h.outbound.slice(beforeLen);
    // 첫 outbound = cancelled 응답(id 7), 그 다음 session/cancel.
    const cancelledResp = after.find((m) => "result" in m && (m as { id?: unknown }).id === 7) as { result: unknown };
    expect(cancelledResp.result).toEqual({ outcome: { outcome: "cancelled" } });
    const cancelIdx = after.findIndex((m) => "method" in m && m.method === "session/cancel");
    const respIdx = after.findIndex((m) => "result" in m && (m as { id?: unknown }).id === 7);
    expect(respIdx).toBeLessThan(cancelIdx); // approval-first
    const resolved = events.find((e) => e.type === "approval_resolved" && (e as { decision: { outcome: string } }).decision.outcome === "cancelled");
    expect(resolved).toMatchObject({ decidedBy: "cleanup" });

    // prompt 응답 정리.
    await h.respondToLast("session/prompt", { stopReason: "cancelled" });
    await p;
  });

  it("New-F1: exit teardown 중 respondApproval send 실패 시 approval_resolved{failed}·throw 없음(exit 경로)", async () => {
    let rejectSend: () => void = () => {};
    const outbound: JsonRpcMessage[] = [];
    let handler: ((e: AgentRuntimeEvent) => void) | undefined;
    let nextId = 0;
    const RID: RuntimeId = 1;
    const isPermResponse = (m: JsonRpcMessage) =>
      "result" in (m as object) && !!(m as { result?: { outcome?: unknown } }).result?.outcome;
    const deps: ClaudeAcpAdapterDeps = {
      startRuntime: vi.fn(async () => RID),
      sendMessage: vi.fn(async (_rid: RuntimeId, message: JsonRpcMessage) => {
        // permission 응답({result:{outcome}})을 hang시켰다 reject(stdin closed 모사). 그 외는 통과.
        if (isPermResponse(message)) {
          await new Promise<void>((_res, rej) => {
            rejectSend = () => rej(new Error("stdin closed"));
          });
          return;
        }
        outbound.push(message);
      }),
      cancelRuntime: vi.fn(async () => {}),
      shutdownRuntime: vi.fn(async () => {}),
      subscribeRuntime: vi.fn((_rid: RuntimeId, h: (e: AgentRuntimeEvent) => void) => {
        handler = h;
        return () => {
          handler = undefined;
        };
      }),
      resolveLaunch: vi.fn(async () => ({ adapterEntryPath: "/wsl/x/dist/index.js" })),
      nextRequestId: () => ++nextId,
      appVersion: "0.9.0",
      now: () => 0,
    };
    const adapter = createClaudeAcpAdapter(deps);
    const inject = (message: JsonRpcMessage) => handler?.({ type: "message", runtimeId: RID, message });
    const injectEvent = (e: AgentRuntimeEvent) => handler?.(e);
    const waitFor = async (method: string) => {
      for (let i = 0; i < 50; i++) {
        const req = outbound.find((m) => "method" in m && m.method === method && "id" in m) as { id: string | number } | undefined;
        if (req) return req;
        await new Promise((r) => setTimeout(r, 0));
      }
      throw new Error(`no outbound ${method}`);
    };

    // lifecycle: startSession → initialize → session/new(요청은 outbound로 흐름).
    const startP = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/p" });
    inject({ jsonrpc: "2.0", id: (await waitFor("initialize")).id, result: { protocolVersion: 1, agentCapabilities: {} } });
    inject({ jsonrpc: "2.0", id: (await waitFor("session/new")).id, result: { sessionId: "sess-1" } });
    await startP;

    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    inject({ jsonrpc: "2.0", id: 42, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "tc1", title: "Edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });

    // respondApproval 시작(ap.closing=true 선점, send in-flight).
    const respP = adapter.respondApproval("A", { requestId: "42", outcome: "selected", optionId: "allow" });
    await Promise.resolve();
    await Promise.resolve();
    // exit 도착 → tearingDown=true, closePending이 closing(선점)을 건너뜀.
    injectEvent({ type: "exit", runtimeId: RID, code: 0 });
    // stdin closed → permission send reject.
    rejectSend();

    // throw 없이 resolve + approval_resolved{failed}.
    await expect(respP).resolves.toBeUndefined();
    const resolved = events.filter((e) => e.type === "approval_resolved");
    expect(resolved.some((e) => (e as Extract<AgentEvent, { type: "approval_resolved" }>).decision.outcome === "failed")).toBe(true);
  });
});

describe("Claude ACP adapter — unsupported request / framing (CL-24b/CL-25/CL-26)", () => {
  it("CL-24b: 미지원 server request → JSON-RPC error(-32601), id 원본 타입 보존, 정확히 1개 응답", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const before = h.outbound.length;
    h.inject({ jsonrpc: "2.0", id: 99, method: "fs/read_text_file", params: { path: "/x" } });
    const after = h.outbound.slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual({ jsonrpc: "2.0", id: 99, error: { code: -32601, message: "Method not found" } });
  });

  it("CL-24b: string id 미지원 request → error id 'r1' 보존", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const before = h.outbound.length;
    h.inject({ jsonrpc: "2.0", id: "r1", method: "terminal/create", params: {} });
    const after = h.outbound.slice(before);
    expect((after[0] as { id: unknown }).id).toBe("r1");
  });

  it("CL-26: ACP 메시지 아님(method/result/error 없음) → error{recoverable:false}", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    h.inject({ jsonrpc: "2.0", id: 1 } as unknown as JsonRpcMessage);
    expect(events.some((e) => e.type === "error" && !(e as { recoverable: boolean }).recoverable)).toBe(true);
  });

  it("CL-27: 미지원 notification(id 없음) → outbound 없음, crash 없음", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const before = h.outbound.length;
    h.inject({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "plan_removed", id: "p1" } } });
    expect(h.outbound.length).toBe(before); // 응답 없음
  });

  it("CL-27b: 미지원 notification raw payload를 adapter 진단 카운터에 보존한다", async () => {
    resetClaudeAcpUnknownNotifications();
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const before = h.outbound.length;

    h.inject({ jsonrpc: "2.0", method: "window/show_message", params: { message: "hello" } });
    h.inject({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1" } });

    expect(h.outbound.length).toBe(before);
    expect(getClaudeAcpUnknownNotificationCount()).toBe(2);
    expect(getClaudeAcpUnknownNotificationRawPayloads()).toEqual([
      { method: "window/show_message", params: { message: "hello" } },
      { method: "session/update", params: { sessionId: "sess-1" } },
    ]);
  });
});

describe("Claude ACP adapter — protocol error + shutdown (CL-3, S3)", () => {
  it("CL-3: protocolVersion≠1 → startSession reject + failed", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    const events: AgentEvent[] = [];
    const p = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/p" });
    await h.waitForOutbound("initialize");
    adapter.subscribeEvents("A", (e) => events.push(e));
    await h.respondToLast("initialize", { protocolVersion: 2 });
    await expect(p).rejects.toThrow();
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "failed")).toBe(true);
  });

  it("shutdown: pending approval/RPC 정리 → shutdownRuntime await → unlisten, late exit 멱등", async () => {
    const order: string[] = [];
    const h = makeHarness();
    const realSend = h.deps.sendMessage;
    h.deps.sendMessage = vi.fn(async (rid, message) => {
      if ("result" in message && (message as { id?: unknown }).id === 5) {
        order.push("approval-cancelled");
      }
      await realSend(rid, message);
    });
    let releaseShutdown: () => void = () => {};
    const shutdownRuntime = vi.fn(async () => {
      order.push("backend-shutdown");
      await new Promise<void>((resolve) => {
        releaseShutdown = resolve;
      });
    });
    h.deps.shutdownRuntime = shutdownRuntime;
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    const promptPromise = adapter.sendPrompt("A", { content: [{ type: "text", text: "pending RPC" }] });
    const promptRejected = expect(promptPromise).rejects.toThrow("runtime closed before session/prompt response");
    await h.waitForOutbound("session/prompt");
    h.inject({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "tc1", title: "x" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });

    const shutdownPromise = adapter.shutdown("A");
    await Promise.resolve();
    // pending approval cancelled wire가 shutdownRuntime 호출 전에 나갔는지.
    const cancelled = h.outbound.find((m) => "result" in m && (m as { id?: unknown }).id === 5) as { result: unknown };
    expect(cancelled.result).toEqual({ outcome: { outcome: "cancelled" } });
    for (let i = 0; i < 10 && shutdownRuntime.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(shutdownRuntime).toHaveBeenCalledWith(h.RUNTIME_ID);
    expect(order).toEqual(["approval-cancelled", "backend-shutdown"]);
    const resolved = events.filter((e) => e.type === "approval_resolved" && (e as { decision: { outcome: string } }).decision.outcome === "cancelled");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ decidedBy: "cleanup" });
    await promptRejected;

    // shutdown await 중 늦은 exit → process_exited는 1회만, pending은 재차 닫지 않음.
    h.injectEvent({ type: "exit", runtimeId: h.RUNTIME_ID, code: 0 });
    expect(events.filter((e) => e.type === "process_exited")).toHaveLength(1);
    expect(events.filter((e) => e.type === "approval_resolved")).toHaveLength(1);
    releaseShutdown();
    await shutdownPromise;

    events.length = 0;
    h.injectEvent({ type: "exit", runtimeId: h.RUNTIME_ID, code: 0 });
    expect(events).toHaveLength(0);
  });

  it("S3: shutdown awaits async pending approval cancel response before backend shutdown", async () => {
    const h = makeHarness();
    const realSend = h.deps.sendMessage;
    let releaseCancelResponse: () => void = () => {};
    let cancelResponseStarted: () => void = () => {};
    const cancelResponseStartedPromise = new Promise<void>((resolve) => {
      cancelResponseStarted = resolve;
    });
    h.deps.sendMessage = vi.fn(async (rid, message) => {
      if ("result" in message && (message as { id?: unknown }).id === 5) {
        cancelResponseStarted();
        await new Promise<void>((resolve) => {
          releaseCancelResponse = resolve;
        });
      }
      await realSend(rid, message);
    });
    const shutdownRuntime = vi.fn(async () => {});
    h.deps.shutdownRuntime = shutdownRuntime;

    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    adapter.subscribeEvents("A", () => undefined);
    h.inject({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "tc1", title: "x" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });

    const shutdownPromise = adapter.shutdown("A");
    await cancelResponseStartedPromise;
    const shutdownCallsBeforeCancelResponse = shutdownRuntime.mock.calls.length;
    releaseCancelResponse();
    await shutdownPromise;

    expect(shutdownCallsBeforeCancelResponse).toBe(0);
    expect(shutdownRuntime).toHaveBeenCalledWith(h.RUNTIME_ID);
  });

  it("OQ-44: process-per-session shutdown은 session/close wire를 보내지 않는다", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    h.outbound.length = 0;

    await adapter.shutdown("A");

    expect(h.deps.shutdownRuntime).toHaveBeenCalledWith(h.RUNTIME_ID);
    expect(h.outbound.some((m) => "method" in m && m.method === "session/close")).toBe(false);
  });

  it("process exit → process_exited emit + pending 정리(멱등)", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    h.inject({ jsonrpc: "2.0", id: 8, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "tc1", title: "x" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
    h.injectEvent({ type: "exit", runtimeId: h.RUNTIME_ID, code: 0 });
    expect(events.some((e) => e.type === "process_exited")).toBe(true);
    // exit 경로는 wire 송신 불가 → approval_resolved{failed} 내부 emit.
    const resolved = events.find((e) => e.type === "approval_resolved" && (e as { decision: { outcome: string } }).decision.outcome === "failed");
    expect(resolved).toMatchObject({ decidedBy: "cleanup" });

    events.length = 0;
    h.injectEvent({ type: "exit", runtimeId: h.RUNTIME_ID, code: 0 });
    expect(events).toHaveLength(0);
  });
});
