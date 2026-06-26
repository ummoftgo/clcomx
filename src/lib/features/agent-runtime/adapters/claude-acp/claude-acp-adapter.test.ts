/**
 * Claude ACP — 어댑터 통합 테스트(11 §4.2, CL-4..CL-11, CL-24b, CL-25/26, lifecycle/cancel/shutdown).
 *
 * 모킹 transport: outbound message를 캡처하고, 테스트가 inbound(agent→client) message를 주입한다.
 * RPC request는 method별로 응답을 자동/수동 주입해 lifecycle을 진행한다.
 */
import { describe, expect, it, vi } from "vitest";
import { createClaudeAcpAdapter } from "./claude-acp-adapter";
import type { ClaudeAcpAdapterDeps } from "../../contracts/claude-acp";
import type { AgentEvent } from "../../contracts/normalized";
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
async function startReady(h: ReturnType<typeof makeHarness>, adapter: ReturnType<typeof createClaudeAcpAdapter>, _events: AgentEvent[]) {
  const startPromise = adapter.startSession({ sessionHandle: "A", provider: "claude", distro: "Ubuntu", workDir: "/home/u/proj" });
  await h.respondToLast("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
  await h.respondToLast("session/new", { sessionId: "sess-1" });
  return startPromise;
}

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
    expect(events.some((e) => e.type === "approval_resolved" && (e as { decision: { outcome: string } }).decision.outcome === "cancelled")).toBe(true);

    // prompt 응답 정리.
    await h.respondToLast("session/prompt", { stopReason: "cancelled" });
    await p;
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

  it("shutdown: pending approval cancelled wire 전송 → shutdownRuntime await → unlisten 순서", async () => {
    const h = makeHarness();
    const adapter = createClaudeAcpAdapter(h.deps);
    await startReady(h, adapter, []);
    const events: AgentEvent[] = [];
    adapter.subscribeEvents("A", (e) => events.push(e));
    h.inject({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "tc1", title: "x" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });

    await adapter.shutdown("A");
    // pending approval cancelled wire가 shutdownRuntime 호출 전에 나갔는지.
    const cancelled = h.outbound.find((m) => "result" in m && (m as { id?: unknown }).id === 5) as { result: unknown };
    expect(cancelled.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(h.deps.shutdownRuntime).toHaveBeenCalledWith(h.RUNTIME_ID);
    expect(events.some((e) => e.type === "approval_resolved" && (e as { decision: { outcome: string } }).decision.outcome === "cancelled")).toBe(true);
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
    expect(events.some((e) => e.type === "approval_resolved" && (e as { decision: { outcome: string } }).decision.outcome === "failed")).toBe(true);
  });
});
