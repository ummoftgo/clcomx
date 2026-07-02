/**
 * agent-runtime-controller 단위 테스트(T5.1) — fake port로 조립·lifecycle 배선 검증.
 *
 * start→subscribeEvents(event→store.dispatch), submit→sendPrompt, approve→respondApproval,
 * cancel→cancelTurn, dispose→unsubscribe+shutdown 경로를 vi.fn deps로 확인한다.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../contracts/normalized";
import type { AgentRuntimePort } from "../contracts/runtime-port";
import { createAgentRuntimeStore } from "../state/agent-runtime-store.svelte";
import { createAgentRuntimeController } from "./agent-runtime-controller";
import { resetRegistry, getSessionStore } from "./agent-event-router";

/** subscribeEvents listener를 캡처하는 fake port. */
function makeFakePort() {
  let listener: ((e: AgentEvent) => void) | null = null;
  const unsubscribe = vi.fn();
  const port: AgentRuntimePort = {
    startSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
    resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    cancelTurn: vi.fn().mockResolvedValue(undefined),
    respondApproval: vi.fn().mockResolvedValue(undefined),
    subscribeEvents: vi.fn((_h, l) => {
      listener = l;
      return unsubscribe;
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  return { port, emit: (e: AgentEvent) => listener?.(e), unsubscribe };
}

describe("agent-runtime-controller", () => {
  beforeEach(() => resetRegistry());

  it("starts the session, registers store, and routes events to the store", async () => {
    const { port, emit } = makeFakePort();
    const store = createAgentRuntimeStore({ sessionHandle: "S1", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });

    const result = await controller.start({
      sessionHandle: "S1",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
    });

    expect(port.startSession).toHaveBeenCalledOnce();
    expect(result).toEqual({ ref: { provider: "codex" } });
    expect(getSessionStore("S1")).toBe(store);

    // subscribeEvents로 들어온 event가 store에 반영되는지.
    emit({
      type: "agent_message_delta",
      ref: { provider: "codex", itemId: "m1" },
      delta: "hi",
    });
    expect(store.visibleItemIds.length).toBe(1);
  });

  it("uses resumeSession when resume config is given", async () => {
    const { port } = makeFakePort();
    const store = createAgentRuntimeStore({ sessionHandle: "S2", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });

    const result = await controller.start({
      sessionHandle: "S2",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
      resume: { providerThreadId: "th1", replay: true },
    });

    expect(port.resumeSession).toHaveBeenCalledOnce();
    expect(port.startSession).not.toHaveBeenCalled();
    expect(result).toEqual({ ref: { provider: "codex" } });
  });

  it("applies composer capabilities from the session start result to the store", async () => {
    const { port } = makeFakePort();
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "claude" },
      composerCapabilities: { image: true, embeddedContext: true, audio: false },
    });
    const store = createAgentRuntimeStore({ sessionHandle: "S2C", provider: "claude" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });

    await controller.start({
      sessionHandle: "S2C",
      runtimeKind: "direct-claude",
      distro: "Ubuntu",
      workDir: "/w",
    });

    expect(store.capabilities).toEqual({ image: true, embeddedContext: true, audio: false });
  });

  it("forwards session title events to the host callback", async () => {
    const { port, emit } = makeFakePort();
    const store = createAgentRuntimeStore({ sessionHandle: "S2T", provider: "claude" });
    const onSessionTitleChange = vi.fn();
    const controller = createAgentRuntimeController({
      createPort: () => port,
      store,
      onSessionTitleChange,
    } as Parameters<typeof createAgentRuntimeController>[0]);
    await controller.start({
      sessionHandle: "S2T",
      runtimeKind: "direct-claude",
      distro: "Ubuntu",
      workDir: "/w",
    });

    emit({
      type: "session_title_changed",
      ref: { provider: "claude", sessionId: "claude-session-1" },
      title: "Provider title",
    } as unknown as AgentEvent);

    expect(onSessionTitleChange).toHaveBeenCalledWith("Provider title");
  });

  it("forwards submit/approve/cancel to the port", async () => {
    const { port } = makeFakePort();
    const store = createAgentRuntimeStore({ sessionHandle: "S3", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });
    await controller.start({
      sessionHandle: "S3",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
    });

    await controller.submit([{ type: "text", text: "go" }]);
    expect(port.sendPrompt).toHaveBeenCalledWith("S3", {
      content: [{ type: "text", text: "go" }],
    });

    store.dispatch({
      type: "approval_requested",
      ref: { provider: "codex", requestId: "7" },
      request: { id: "7", title: "x", options: [{ id: "o1", label: "ok", kind: "allow_once" }] },
    });
    await controller.approve({ requestId: "7", outcome: "selected", optionId: "o1" });
    expect(port.respondApproval).toHaveBeenCalledWith("S3", {
      requestId: "7",
      outcome: "selected",
      optionId: "o1",
    });

    await controller.cancel();
    expect(port.cancelTurn).toHaveBeenCalledWith("S3", undefined);
  });

  it("forwards resource search to the active port with the current workDir", async () => {
    const { port } = makeFakePort();
    port.searchResources = vi.fn().mockResolvedValue([
      { label: "src/App.svelte", uri: "file:///w/src/App.svelte", detail: "/w/src/App.svelte" },
    ]);
    const store = createAgentRuntimeStore({ sessionHandle: "S3R", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });
    await controller.start({
      sessionHandle: "S3R",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
    });

    const results = await controller.searchResources("app", 8);

    expect(port.searchResources).toHaveBeenCalledWith("S3R", {
      query: "app",
      workDir: "/w",
      limit: 8,
    });
    expect(results).toEqual([
      { label: "src/App.svelte", uri: "file:///w/src/App.svelte", detail: "/w/src/App.svelte" },
    ]);
  });

  it("forwards an empty resource query so the source can provide default candidates", async () => {
    const { port } = makeFakePort();
    port.searchResources = vi.fn().mockResolvedValue([
      { label: "README.md", uri: "file:///w/README.md", detail: "/w/README.md" },
    ]);
    const store = createAgentRuntimeStore({ sessionHandle: "S3RE", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });
    await controller.start({
      sessionHandle: "S3RE",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
    });

    const results = await controller.searchResources("", 8);

    expect(port.searchResources).toHaveBeenCalledWith("S3RE", {
      query: "",
      workDir: "/w",
      limit: 8,
    });
    expect(results).toEqual([
      { label: "README.md", uri: "file:///w/README.md", detail: "/w/README.md" },
    ]);
  });

  it("NM-20: rejects failed approval decisions before they can reach the port", async () => {
    const { port } = makeFakePort();
    const store = createAgentRuntimeStore({ sessionHandle: "S3F", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });
    await controller.start({
      sessionHandle: "S3F",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
    });

    await expect(controller.approve({ requestId: "7", outcome: "failed" })).rejects.toThrow(
      "failed approval decisions are client-internal",
    );
    expect(port.respondApproval).not.toHaveBeenCalled();
  });

  it("SEC-APPROVAL: rejects approval decisions for requestIds not pending in the store", async () => {
    const { port } = makeFakePort();
    const store = createAgentRuntimeStore({ sessionHandle: "S3M", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });
    await controller.start({
      sessionHandle: "S3M",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
    });

    await expect(
      controller.approve({ requestId: "missing", outcome: "selected", optionId: "ok" }),
    ).rejects.toThrow("approval requestId is not pending");
    expect(port.respondApproval).not.toHaveBeenCalled();
  });

  it("unsubscribes and shuts down on dispose", async () => {
    const { port, unsubscribe } = makeFakePort();
    const store = createAgentRuntimeStore({ sessionHandle: "S4", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });
    await controller.start({
      sessionHandle: "S4",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
    });

    await controller.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(port.shutdown).toHaveBeenCalledWith("S4");
    expect(getSessionStore("S4")).toBeUndefined();
  });

  it("does not let a stale controller dispose unregister a newer controller for the same session", async () => {
    const first = makeFakePort();
    const firstStore = createAgentRuntimeStore({ sessionHandle: "S4R", provider: "codex" });
    const firstController = createAgentRuntimeController({
      createPort: () => first.port,
      store: firstStore,
    });
    await firstController.start({
      sessionHandle: "S4R",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
    });

    const second = makeFakePort();
    const secondStore = createAgentRuntimeStore({ sessionHandle: "S4R", provider: "codex" });
    const secondController = createAgentRuntimeController({
      createPort: () => second.port,
      store: secondStore,
    });
    await secondController.start({
      sessionHandle: "S4R",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
    });

    await firstController.dispose();

    expect(getSessionStore("S4R")).toBe(secondStore);

    await secondController.dispose();
    expect(getSessionStore("S4R")).toBeUndefined();
  });

  // ── Codex 검토 발견 회귀 방지(lifecycle ordering, 실제 adapter 계약 고정) ──

  it("Finding 1 + New-F2: subscribes BEFORE start (pre-registration) so start-time events stream live", async () => {
    const order: string[] = [];
    let liveListener: ((e: AgentEvent) => void) | null = null;
    const port: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(async () => {
        order.push("start");
        // start 중 emit되는 lifecycle/replay event는 이미 pre-registered된 listener로 곧장 흘러야 한다
        // (deferred 버퍼에 unbounded로 쌓이지 않고 store seal/eviction으로 즉시 bounded).
        liveListener?.({ type: "session_started", ref: { provider: "codex", threadId: "t" }, cwd: "/w" });
        liveListener?.({ type: "agent_message_delta", ref: { provider: "codex", itemId: "m1" }, delta: "live" });
        return { ref: { provider: "codex" } };
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      // 실제 adapter처럼 세션 미생성 상태의 구독을 pre-register(throw·no-op 아님).
      subscribeEvents: vi.fn((_h, l) => {
        order.push("subscribe");
        liveListener = l;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const store = createAgentRuntimeStore({ sessionHandle: "S5", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });

    await controller.start({ sessionHandle: "S5", runtimeKind: "direct-codex", distro: "Ubuntu", workDir: "/w" });
    // 구독이 start보다 먼저(pre-registration). start 중 emit된 event가 유실 없이 store에 반영.
    expect(order).toEqual(["subscribe", "start"]);
    expect(store.visibleItemIds.length).toBe(1);
  });

  it("Finding 2: keeps the pending approval open when the wire send fails (no optimistic close)", async () => {
    const { port } = makeFakePort();
    (port.respondApproval as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("send failed"));
    const store = createAgentRuntimeStore({ sessionHandle: "S6", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });
    await controller.start({ sessionHandle: "S6", runtimeKind: "direct-codex", distro: "Ubuntu", workDir: "/w" });

    store.dispatch({
      type: "approval_requested",
      ref: { provider: "codex", threadId: "t", turnId: "u", requestId: "9" },
      request: { id: "9", title: "x", options: [{ id: "o", label: "ok", kind: "allow_once" }] },
    });
    expect(store.pendingApprovals.length).toBe(1);

    // wire 실패 → approve가 reject되고 pending은 유지(UI 닫힘/provider 대기 분기 방지).
    await expect(
      controller.approve({ requestId: "9", outcome: "selected", optionId: "o" }),
    ).rejects.toThrow("send failed");
    expect(store.pendingApprovals.length).toBe(1);
  });

  it("Finding 3: shuts down BEFORE unsubscribing so shutdown-time cleanup events still reach the store", async () => {
    const order: string[] = [];
    const unsubscribe = vi.fn(() => {
      order.push("unsubscribe");
    });
    const port: AgentRuntimePort = {
      startSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn(() => unsubscribe),
      shutdown: vi.fn().mockImplementation(async () => {
        order.push("shutdown");
      }),
    };
    const store = createAgentRuntimeStore({ sessionHandle: "S7", provider: "codex" });
    const controller = createAgentRuntimeController({ createPort: () => port, store });
    await controller.start({ sessionHandle: "S7", runtimeKind: "direct-codex", distro: "Ubuntu", workDir: "/w" });

    await controller.dispose();
    expect(order).toEqual(["shutdown", "unsubscribe"]);
  });
});
