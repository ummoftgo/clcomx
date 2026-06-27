/**
 * AgentTranscriptSurface 테스트(T5.4·T5.6) — escalation modal·replay affordance 진입/폐기·live 미병합.
 *
 * fake port(createPort 주입)로 store에 event를 흘려 surface 상호작용을 검증한다. router registry는
 * 세션 핸들 단위로 등록되므로 테스트마다 reset한다.
 */

import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { TEST_IDS } from "../../../testids";
import type { AgentEvent } from "../contracts/normalized";
import type { AgentRuntimePort } from "../contracts/runtime-port";
import type { ReplayLoader } from "../service/runtime-replay";
import { resetRegistry } from "../controller/agent-event-router";
import AgentTranscriptSurface from "./AgentTranscriptSurface.svelte";

function makeFakePort() {
  let listener: ((e: AgentEvent) => void) | null = null;
  // 실제 adapter 계약을 모사: 구독 전 emit된 event를 버퍼링했다가 구독 시 flush한다.
  // controller가 start/resume **후** 구독하므로(Finding 1), 이 버퍼가 없으면 start 중/직후
  // emit이 유실된다 — 실제 Codex/Claude adapter의 deferred 큐와 동형.
  const buffer: AgentEvent[] = [];
  const port: AgentRuntimePort = {
    startSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
    resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    cancelTurn: vi.fn().mockResolvedValue(undefined),
    respondApproval: vi.fn().mockResolvedValue(undefined),
    subscribeEvents: vi.fn((_h, l) => {
      listener = l;
      for (const e of buffer.splice(0)) l(e);
      return vi.fn();
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  return {
    port,
    emit: (e: AgentEvent) => {
      if (listener) listener(e);
      else buffer.push(e);
    },
  };
}

function baseProps(port: AgentRuntimePort, extra: Record<string, unknown> = {}) {
  return {
    sessionId: "S1",
    agentId: "codex",
    ptyId: 0,
    runtimeKind: "direct-codex" as const,
    distro: "Ubuntu",
    workDir: "/w",
    visible: true,
    createPort: () => port,
    ...extra,
  };
}

describe("AgentTranscriptSurface", () => {
  beforeEach(() => {
    resetRegistry();
    initializeI18n("en", "en-US");
  });

  it("shows the escalation approval modal when escalationApproval is present", async () => {
    const { port, emit } = makeFakePort();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });

    emit({
      type: "approval_requested",
      ref: { provider: "codex", threadId: "t", turnId: "u", requestId: "req-esc" },
      request: {
        id: "req-esc",
        title: "Grant full access?",
        severity: "escalation",
        options: [{ id: "opt-grant", label: "Grant", kind: "allow_once" }],
      },
    });

    const modal = await findByTestId(TEST_IDS.agentApprovalModal);
    expect(modal.getAttribute("aria-modal")).toBe("true");
  });

  it("does not show the replay affordance when there is no evicted history", () => {
    const { port } = makeFakePort();
    const { queryByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });
    expect(queryByTestId(TEST_IDS.agentReplayAffordance)).toBeNull();
  });

  it("never auto-enters the replay panel without an explicit user action (read-only inspection only)", async () => {
    const { port, emit } = makeFakePort();
    const replayLoader: ReplayLoader = {
      canLoad: () => true,
      loadHistory: async () => [],
      dispose: async () => {},
    };
    const { queryByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, { createReplayLoader: () => replayLoader }),
    });

    // 라이브 event가 흘러도 replay 패널은 자동 진입하지 않는다(사용자 명시 진입만, 10 §4.7).
    emit({
      type: "agent_message_delta",
      ref: { provider: "codex", threadId: "t", turnId: "u", itemId: "m1" },
      delta: "live",
    });
    await waitFor(() => {
      expect(queryByTestId(TEST_IDS.agentTranscript)).toBeTruthy();
    });
    expect(queryByTestId(TEST_IDS.agentReplayPanel)).toBeNull();
  });

  it("shows the fallback panel when direct runtime start fails (no auto fallback)", async () => {
    const failingPort: AgentRuntimePort = {
      startSession: vi.fn().mockRejectedValue(new Error("spawn ENOENT codex")),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn(() => vi.fn()),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onFallbackToPty = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(failingPort, { onFallbackToPty }),
    });

    const panel = await findByTestId(TEST_IDS.agentRuntimeFallback);
    expect(panel.getAttribute("aria-modal")).toBe("true");
    // 자동 폴백 금지 — 패널만 표시되고 PTY 전환은 아직 호출되지 않는다.
    expect(onFallbackToPty).not.toHaveBeenCalled();
  });

  it("invokes the PTY fallback callback with session context when chosen", async () => {
    const failingPort: AgentRuntimePort = {
      startSession: vi.fn().mockRejectedValue(new Error("initialize timeout")),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn(() => vi.fn()),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onFallbackToPty = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(failingPort, { onFallbackToPty }),
    });

    const ptyButton = await findByTestId(TEST_IDS.agentRuntimeFallbackPty);
    await fireEvent.click(ptyButton);

    await waitFor(() => {
      expect(onFallbackToPty).toHaveBeenCalledWith({
        sessionId: "S1",
        agentId: "codex",
        distro: "Ubuntu",
        workDir: "/w",
      });
    });
  });

  // JSDOM은 layout이 없어 scroll 메트릭을 직접 모킹한다.
  function mockScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  }

  it("auto-scrolls the transcript to the bottom on new content (auto-follow on by default)", async () => {
    const { port, emit } = makeFakePort();
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    const region = await findByTestId(TEST_IDS.agentTranscript);
    mockScrollMetrics(region, 1000, 200);
    region.scrollTop = 0;

    emit({
      type: "agent_message_delta",
      ref: { provider: "codex", threadId: "t", turnId: "u", itemId: "m1" },
      delta: "hello",
    });

    await waitFor(() => {
      expect(region.scrollTop).toBe(1000);
    });
  });

  it("stops auto-following when the user scrolls up, then resumes at the bottom", async () => {
    const { port, emit } = makeFakePort();
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    const region = await findByTestId(TEST_IDS.agentTranscript);
    mockScrollMetrics(region, 1000, 200);

    // 사용자가 위로 스크롤(바닥 아님) → auto-follow 정지.
    region.scrollTop = 0;
    await fireEvent.scroll(region);

    // 새 content가 와도 바닥으로 끌어내리지 않는다.
    region.scrollTop = 0;
    emit({
      type: "agent_message_delta",
      ref: { provider: "codex", threadId: "t", turnId: "u", itemId: "m1" },
      delta: "more",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(region.scrollTop).toBe(0);

    // 바닥으로 복귀하면(scrollHeight-clientHeight=800) 추종 재개.
    region.scrollTop = 800;
    await fireEvent.scroll(region);
    region.scrollTop = 0;
    emit({
      type: "agent_message_delta",
      ref: { provider: "codex", threadId: "t", turnId: "u", itemId: "m2" },
      delta: "again",
    });
    await waitFor(() => {
      expect(region.scrollTop).toBe(1000);
    });
  });
});
