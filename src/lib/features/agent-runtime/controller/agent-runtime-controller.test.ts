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

    await controller.start({
      sessionHandle: "S1",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
    });

    expect(port.startSession).toHaveBeenCalledOnce();
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

    await controller.start({
      sessionHandle: "S2",
      runtimeKind: "direct-codex",
      distro: "Ubuntu",
      workDir: "/w",
      resume: { providerThreadId: "th1", replay: true },
    });

    expect(port.resumeSession).toHaveBeenCalledOnce();
    expect(port.startSession).not.toHaveBeenCalled();
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

    await controller.approve({ requestId: "7", outcome: "selected", optionId: "o1" });
    expect(port.respondApproval).toHaveBeenCalledWith("S3", {
      requestId: "7",
      outcome: "selected",
      optionId: "o1",
    });

    await controller.cancel();
    expect(port.cancelTurn).toHaveBeenCalledWith("S3", undefined);
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
});
