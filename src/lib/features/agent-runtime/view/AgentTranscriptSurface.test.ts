/**
 * AgentTranscriptSurface 테스트(T5.4·T5.6) — escalation modal·replay affordance 진입/폐기·live 미병합.
 *
 * fake port(createPort 주입)로 store에 event를 흘려 surface 상호작용을 검증한다. router registry는
 * 세션 핸들 단위로 등록되므로 테스트마다 reset한다.
 */

import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { TEST_IDS } from "../../../testids";
import type { AgentEvent } from "../contracts/normalized";
import type { AgentRuntimePort, SessionStartResult } from "../contracts/runtime-port";
import type { ReplayLoader } from "../service/runtime-replay";
import type { TranscriptCacheSnapshot } from "../service/transcript-cache";
import { resetRegistry } from "../controller/agent-event-router";
import AgentTranscriptSurface from "./AgentTranscriptSurface.svelte";

const editorMocks = vi.hoisted(() => ({
  searchSessionFiles: vi.fn(),
}));

vi.mock("../../../editors", () => ({
  searchSessionFiles: editorMocks.searchSessionFiles,
}));

// OQ-16: 진행 중 재개 id·transcript 캐시 저장 훅 검증용 mock(Task 4/5/6 서비스).
const resumeStoreMocks = vi.hoisted(() => ({
  saveResumeKeys: vi.fn().mockResolvedValue(undefined),
}));
const transcriptCacheMocks = vi.hoisted(() => ({
  saveTranscriptCache: vi.fn().mockResolvedValue(undefined),
  serializeTranscript: vi.fn<(model: unknown) => TranscriptCacheSnapshot>(() => ({
    schemaVersion: 1,
    visibleItemIds: [],
    items: [],
    turns: [],
  })),
}));

vi.mock("../service/resume-store", () => ({
  saveResumeKeys: resumeStoreMocks.saveResumeKeys,
}));
vi.mock("../service/transcript-cache", () => ({
  saveTranscriptCache: transcriptCacheMocks.saveTranscriptCache,
  serializeTranscript: transcriptCacheMocks.serializeTranscript,
}));

function makeFakePort(options: { canResume?: boolean; canLoad?: boolean } = {}) {
  let listener: ((e: AgentEvent) => void) | null = null;
  // 실제 adapter 계약을 모사: 구독 전 emit된 event를 버퍼링했다가 구독 시 flush한다.
  // controller가 start/resume 전에 구독하지만 adapter deferred 계약도 같이 지킨다(Finding 1).
  // 이 버퍼가 없으면 start 중/직후
  // emit이 유실된다 — 실제 Codex/Claude adapter의 deferred 큐와 동형.
  const buffer: AgentEvent[] = [];
  const canResume = options.canResume ?? true;
  const canLoad = options.canLoad ?? true;
  const port: AgentRuntimePort = {
    startSession: vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      canResume,
      canLoad,
    }),
    resumeSession: vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      canResume,
      canLoad,
    }),
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
    editorMocks.searchSessionFiles.mockReset();
    editorMocks.searchSessionFiles.mockResolvedValue({ rootDir: "/w", results: [] });
    resumeStoreMocks.saveResumeKeys.mockReset();
    resumeStoreMocks.saveResumeKeys.mockResolvedValue(undefined);
    transcriptCacheMocks.saveTranscriptCache.mockReset();
    transcriptCacheMocks.saveTranscriptCache.mockResolvedValue(undefined);
    transcriptCacheMocks.serializeTranscript.mockReset();
    transcriptCacheMocks.serializeTranscript.mockReturnValue({
      schemaVersion: 1,
      visibleItemIds: [],
      items: [],
      turns: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("OQ-17: visible toggles hide the direct host without shutting down runtime", async () => {
    const { port } = makeFakePort();
    const view = render(AgentTranscriptSurface, { props: baseProps(port) });
    const shell = await view.findByTestId(TEST_IDS.agentRuntimeShell);

    expect(shell).not.toHaveClass("hidden");

    await view.rerender(baseProps(port, { visible: false }));

    expect(shell).toHaveClass("hidden");
    expect(port.shutdown).not.toHaveBeenCalled();

    await view.rerender(baseProps(port, { visible: true }));

    expect(shell).not.toHaveClass("hidden");
    expect(port.shutdown).not.toHaveBeenCalled();
  });

  it("10 §4.3: tab close unmount shuts down the direct runtime once", async () => {
    const { port } = makeFakePort();
    const view = render(AgentTranscriptSurface, { props: baseProps(port) });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });

    view.unmount();

    await waitFor(() => {
      expect(port.shutdown).toHaveBeenCalledWith("S1");
    });
    expect(port.shutdown).toHaveBeenCalledTimes(1);
  });

  it("wires tool location clicks to the host location handler", async () => {
    const { port, emit } = makeFakePort();
    const onOpenLocation = vi.fn();
    const location = { path: "src/host.ts", line: 9, column: 1 };
    const { getByRole, findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, { onOpenLocation }),
    });

    emit({
      type: "tool_call_updated",
      ref: { provider: "codex", threadId: "t", turnId: "u", toolCallId: "tc-host-location" },
      update: {
        id: "tc-host-location",
        kind: "read",
        status: "completed",
        title: "read match",
        locations: [location],
      },
    });

    await fireEvent.click(await findByTestId(TEST_IDS.agentToolCallToggle));
    await fireEvent.click(getByRole("button", { name: "src/host.ts:9:1" }));

    expect(onOpenLocation).toHaveBeenCalledWith(location);
  });

  it("09 §3.5: pagehide/webview reload disposes the runtime exactly once", async () => {
    const { port } = makeFakePort();
    const view = render(AgentTranscriptSurface, { props: baseProps(port) });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });

    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => {
      expect(port.shutdown).toHaveBeenCalledWith("S1");
    });

    window.dispatchEvent(new Event("pagehide"));
    view.unmount();

    expect(port.shutdown).toHaveBeenCalledTimes(1);
  });

  it("OQ-56: @ file mention search submits selected workspace file as resource content", async () => {
    editorMocks.searchSessionFiles.mockResolvedValueOnce({
      rootDir: "/w",
      results: [
        {
          wslPath: "/w/src/App.svelte",
          relativePath: "src/App.svelte",
          basename: "App.svelte",
        },
      ],
    });
    const { port, emit } = makeFakePort();
    const { getByTestId, findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    emit({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      status: "ready",
    });
    await waitFor(() => expect(input.disabled).toBe(false));

    await fireEvent.input(input, { target: { value: "@app" } });

    expect(await findByTestId(TEST_IDS.agentComposerResourcePalette)).toBeTruthy();
    expect(editorMocks.searchSessionFiles).toHaveBeenCalledWith("S1", "/w", "app", 8);

    await fireEvent.keyDown(input, { key: "Enter" });
    await fireEvent.input(input, { target: { value: "@src/App.svelte please inspect" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(port.sendPrompt).toHaveBeenCalledWith("S1", {
        content: [
          { type: "text", text: "@src/App.svelte please inspect" },
          { type: "resource", uri: "file:///w/src/App.svelte" },
        ],
      });
    });
  });

  it("OQ-56: resource action button opens workspace fallback results for an empty query", async () => {
    editorMocks.searchSessionFiles.mockResolvedValueOnce({
      rootDir: "/w",
      results: [
        {
          wslPath: "/w/README.md",
          relativePath: "README.md",
          basename: "README.md",
        },
      ],
    });
    const { port, emit } = makeFakePort();
    const { getByTestId, findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    emit({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      status: "ready",
    });
    await waitFor(() => expect(input.disabled).toBe(false));

    await fireEvent.click(getByTestId(TEST_IDS.agentComposerResourceButton));

    expect(await findByTestId(TEST_IDS.agentComposerResourcePalette)).toBeTruthy();
    expect(editorMocks.searchSessionFiles).toHaveBeenCalledWith("S1", "/w", "", 8);

    await fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("@README.md ");
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(port.sendPrompt).toHaveBeenCalledWith("S1", {
        content: [
          { type: "text", text: "@README.md" },
          { type: "resource", uri: "file:///w/README.md" },
        ],
      });
    });
  });

  it("OQ-56: @ mention uses provider-backed resource search before workspace fallback", async () => {
    const { port, emit } = makeFakePort();
    port.searchResources = vi.fn().mockResolvedValue([
      {
        label: "src/ProviderFile.ts",
        uri: "file:///w/src/ProviderFile.ts",
        detail: "/w/src/ProviderFile.ts",
      },
    ]);
    const { getByTestId, findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    emit({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      status: "ready",
    });
    await waitFor(() => expect(input.disabled).toBe(false));

    await fireEvent.input(input, { target: { value: "@prov" } });

    expect(await findByTestId(TEST_IDS.agentComposerResourcePalette)).toBeTruthy();
    expect(port.searchResources).toHaveBeenCalledWith("S1", {
      query: "prov",
      workDir: "/w",
      limit: 8,
    });
    expect(editorMocks.searchSessionFiles).not.toHaveBeenCalled();

    await fireEvent.keyDown(input, { key: "Enter" });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(port.sendPrompt).toHaveBeenCalledWith("S1", {
        content: [
          { type: "text", text: "@src/ProviderFile.ts" },
          { type: "resource", uri: "file:///w/src/ProviderFile.ts" },
        ],
      });
    });
  });

  it("OQ-56: ACP resource search empty result falls back to workspace file search", async () => {
    editorMocks.searchSessionFiles.mockResolvedValueOnce({
      rootDir: "/w",
      results: [
        {
          wslPath: "/w/src/Fallback.ts",
          relativePath: "src/Fallback.ts",
          basename: "Fallback.ts",
        },
      ],
    });
    const { port, emit } = makeFakePort();
    vi.mocked(port.startSession).mockResolvedValueOnce({
      ref: { provider: "claude", sessionId: "acp-session-1" },
      composerCapabilities: { image: false, embeddedContext: true, audio: false },
    } satisfies SessionStartResult);
    port.searchResources = vi.fn().mockResolvedValue([]);
    const { getByTestId, findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, { runtimeKind: "direct-claude" }),
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    emit({
      type: "session_status_changed",
      ref: { provider: "claude", sessionId: "acp-session-1" },
      status: "ready",
    });
    await waitFor(() => expect(input.disabled).toBe(false));

    await fireEvent.input(input, { target: { value: "@fallback" } });

    expect(await findByTestId(TEST_IDS.agentComposerResourcePalette)).toBeTruthy();
    expect(port.searchResources).toHaveBeenCalledWith("S1", {
      query: "fallback",
      workDir: "/w",
      limit: 8,
    });
    expect(editorMocks.searchSessionFiles).toHaveBeenCalledWith("S1", "/w", "fallback", 8);

    await fireEvent.keyDown(input, { key: "Enter" });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(port.sendPrompt).toHaveBeenCalledWith("S1", {
        content: [
          { type: "text", text: "@src/Fallback.ts" },
          { type: "resource", uri: "file:///w/src/Fallback.ts" },
        ],
      });
    });
  });

  it("OQ-56: file mention resource URI encodes path characters", async () => {
    editorMocks.searchSessionFiles.mockResolvedValueOnce({
      rootDir: "/w",
      results: [
        {
          wslPath: "/w/My Dir/app#main?.svelte",
          relativePath: "My Dir/app#main?.svelte",
          basename: "app#main?.svelte",
        },
      ],
    });
    const { port, emit } = makeFakePort();
    const { getByTestId, findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    emit({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      status: "ready",
    });
    await waitFor(() => expect(input.disabled).toBe(false));

    await fireEvent.input(input, { target: { value: "@app" } });
    expect(await findByTestId(TEST_IDS.agentComposerResourcePalette)).toBeTruthy();
    await fireEvent.keyDown(input, { key: "Enter" });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(port.sendPrompt).toHaveBeenCalledWith("S1", {
        content: [
          { type: "text", text: "@My Dir/app#main?.svelte" },
          { type: "resource", uri: "file:///w/My%20Dir/app%23main%3F.svelte" },
        ],
      });
    });
  });

  it("OQ-56: provider image capability exposes the composer image attachment control", async () => {
    const { port } = makeFakePort();
    vi.mocked(port.startSession).mockResolvedValueOnce({
      ref: { provider: "claude", sessionId: "acp-session-1" },
      composerCapabilities: { image: true, embeddedContext: true, audio: false },
    } satisfies SessionStartResult);

    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, { runtimeKind: "direct-claude" }),
    });

    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    expect(await findByTestId(TEST_IDS.agentComposerImageButton)).toBeTruthy();
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

  it("uses provider canLoad=false to show replay unavailable even when tombstones exist", async () => {
    vi.useFakeTimers();
    const { port, emit } = makeFakePort({ canLoad: false });
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          providerThreadId: "thread-1",
          canResume: true,
          canLoad: false,
        },
      }),
    });

    // 기본 hot-window(50)를 넘겨 evicted-tombstone affordance를 만든다.
    for (let i = 0; i < 55; i++) {
      const ref = { provider: "codex" as const, threadId: "t", turnId: `turn-${i}`, itemId: `item-${i}` };
      emit({
        type: "agent_message",
        ref,
        content: [{ type: "text", text: `message ${i}` }],
        mode: "replace",
      });
      emit({ type: "turn_completed", ref, status: "completed" });
    }
    await vi.advanceTimersByTimeAsync(1000);

    await fireEvent.click(await findByTestId(TEST_IDS.agentReplayAffordance));

    const panel = await findByTestId(TEST_IDS.agentReplayPanel);
    expect(panel.textContent).toContain("unavailable");
  });

  it("opens isolated replay history when canLoad=true and disposes the scratch loader", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const replayLoader: ReplayLoader = {
      canLoad: () => true,
      loadHistory: async () => [
        {
          type: "user_message",
          ref: {
            provider: "codex",
            threadId: "thread-1",
            turnId: "archived-turn",
            itemId: "archived-item",
          },
          content: [{ type: "text", text: "archived-only message" }],
          mode: "replace",
        },
      ],
      dispose: async () => dispose(),
    };
    const { port, emit } = makeFakePort({ canLoad: true });
    const { findByTestId, queryByText } = render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          providerThreadId: "thread-1",
          canResume: true,
          canLoad: true,
        },
        createReplayLoader: () => replayLoader,
      }),
    });

    for (let i = 0; i < 55; i++) {
      const ref = {
        provider: "codex" as const,
        threadId: "thread-1",
        turnId: `turn-${i}`,
        itemId: `item-${i}`,
      };
      emit({
        type: "agent_message",
        ref,
        content: [{ type: "text", text: `live message ${i}` }],
        mode: "replace",
      });
      emit({ type: "turn_completed", ref, status: "completed" });
    }
    await vi.advanceTimersByTimeAsync(1000);

    await fireEvent.click(await findByTestId(TEST_IDS.agentReplayAffordance));

    const panel = await findByTestId(TEST_IDS.agentReplayPanel);
    await waitFor(() => {
      expect(panel.textContent).toContain("archived-only message");
    });
    expect(queryByText("archived-only message")).toBeTruthy();
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));

    await fireEvent.click(await findByTestId(TEST_IDS.agentReplayClose));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("uses the default provider replay loader when no test replay loader is injected", async () => {
    vi.useFakeTimers();
    const live = makeFakePort({ canLoad: true });
    const replay = makeFakePort({ canLoad: true });
    replay.port.resumeSession = vi.fn().mockImplementation(async () => {
      replay.emit({
        type: "user_message",
        ref: {
          provider: "codex",
          threadId: "thread-1",
          turnId: "archived-turn",
          itemId: "archived-item",
        },
        content: [{ type: "text", text: "provider replay message" }],
        mode: "replace",
      });
      return {
        ref: { provider: "codex", threadId: "thread-1", sessionId: "scratch-session" },
        canResume: true,
        canLoad: true,
      } satisfies SessionStartResult;
    });
    const createPort = vi.fn()
      .mockReturnValueOnce(live.port)
      .mockReturnValueOnce(replay.port);
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(live.port, {
        createPort,
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          providerThreadId: "thread-1",
          canResume: true,
          canLoad: true,
        },
      }),
    });

    for (let i = 0; i < 55; i++) {
      const ref = {
        provider: "codex" as const,
        threadId: "thread-1",
        turnId: `turn-${i}`,
        itemId: `item-${i}`,
      };
      live.emit({
        type: "agent_message",
        ref,
        content: [{ type: "text", text: `live message ${i}` }],
        mode: "replace",
      });
      live.emit({ type: "turn_completed", ref, status: "completed" });
    }
    await vi.advanceTimersByTimeAsync(1000);

    await fireEvent.click(await findByTestId(TEST_IDS.agentReplayAffordance));

    const panel = await findByTestId(TEST_IDS.agentReplayPanel);
    await waitFor(() => {
      expect(panel.textContent).toContain("provider replay message");
    });
    expect(replay.port.resumeSession).toHaveBeenCalledWith({
      sessionHandle: "S1:replay",
      provider: "codex",
      distro: "Ubuntu",
      workDir: "/w",
      providerSessionId: undefined,
      providerThreadId: "thread-1",
      replay: true,
    });
    await waitFor(() => {
      expect(replay.port.shutdown).toHaveBeenCalledWith("S1:replay");
    });
    expect(replay.port.shutdown).toHaveBeenCalledTimes(1);

    await fireEvent.click(await findByTestId(TEST_IDS.agentReplayClose));
    expect(replay.port.shutdown).toHaveBeenCalledWith("S1:replay");
    expect(replay.port.shutdown).toHaveBeenCalledTimes(1);
  });

  it("publishes direct runtime metadata after a new session starts", async () => {
    const { port } = makeFakePort();
    const onAgentRuntimeMetadataChange = vi.fn();
    render(AgentTranscriptSurface, {
      props: baseProps(port, { onAgentRuntimeMetadataChange }),
    });

    await waitFor(() => {
      expect(onAgentRuntimeMetadataChange).toHaveBeenCalledWith({
        sessionRuntimeKind: "direct-codex",
        provider: "codex",
        providerSessionId: "session-tree-1",
        providerThreadId: "thread-1",
        lastTurnId: undefined,
        protocolVersion: undefined,
        adapterVersion: undefined,
        providerVersion: undefined,
        canResume: true,
        canLoad: true,
      });
    });
  });

  it("OQ-16: persists resume keys immediately and a debounced transcript cache snapshot when metadata is saved", async () => {
    vi.useFakeTimers();
    try {
      const { port } = makeFakePort();
      const onAgentRuntimeMetadataChange = vi.fn();
      const snapshot: TranscriptCacheSnapshot = {
        schemaVersion: 1,
        visibleItemIds: ["i1"],
        items: [],
        turns: [],
      };
      transcriptCacheMocks.serializeTranscript.mockReturnValue(snapshot);

      render(AgentTranscriptSurface, {
        props: baseProps(port, { onAgentRuntimeMetadataChange }),
      });

      await waitFor(() => {
        expect(onAgentRuntimeMetadataChange).toHaveBeenCalled();
      });

      // saveResumeKeys는 값이 싸므로 디바운스 없이 즉시 호출된다.
      await waitFor(() => {
        expect(resumeStoreMocks.saveResumeKeys).toHaveBeenCalledWith("S1", {
          providerThreadId: "thread-1",
          providerSessionId: "session-tree-1",
          canResume: true,
          canLoad: true,
        });
      });

      // transcript 캐시 저장은 디바운스되어 타이머가 도달하기 전에는 아직 호출되지 않는다.
      expect(transcriptCacheMocks.saveTranscriptCache).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(transcriptCacheMocks.saveTranscriptCache).toHaveBeenCalledWith("S1", snapshot);
    } finally {
      vi.useRealTimers();
    }
  });

  it("OQ-16: coalesces rapid metadata persists into a single debounced transcript cache save", async () => {
    vi.useFakeTimers();
    try {
      const { port, emit } = makeFakePort();
      render(AgentTranscriptSurface, {
        props: baseProps(port),
      });

      await waitFor(() => {
        expect(port.startSession).toHaveBeenCalledOnce();
      });
      // 첫 metadata persist(session start) 이후 곧바로 두 번째 patch를 흘려 짧은 시간 내 재트리거한다.
      transcriptCacheMocks.saveTranscriptCache.mockClear();
      emit({
        type: "runtime_metadata_changed",
        ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
        metadata: { permissionMode: "default" },
      } as unknown as AgentEvent);
      await vi.advanceTimersByTimeAsync(200);
      emit({
        type: "runtime_metadata_changed",
        ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
        metadata: { permissionMode: "bypassPermissions" },
      } as unknown as AgentEvent);

      // 디바운스 창(1000ms) 이전에는 아직 저장되지 않는다.
      expect(transcriptCacheMocks.saveTranscriptCache).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(transcriptCacheMocks.saveTranscriptCache).toHaveBeenCalledTimes(1);
      expect(transcriptCacheMocks.saveTranscriptCache).toHaveBeenCalledWith(
        "S1",
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("OQ-16: keeps the runtime alive when resume key / transcript cache persistence rejects", async () => {
    vi.useFakeTimers();
    try {
      const { port } = makeFakePort();
      resumeStoreMocks.saveResumeKeys.mockRejectedValue(new Error("secret store unavailable"));
      transcriptCacheMocks.saveTranscriptCache.mockRejectedValue(new Error("disk full"));
      const onAgentRuntimeMetadataChange = vi.fn();

      const { findByTestId } = render(AgentTranscriptSurface, {
        props: baseProps(port, { onAgentRuntimeMetadataChange }),
      });

      await waitFor(() => {
        expect(onAgentRuntimeMetadataChange).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(resumeStoreMocks.saveResumeKeys).toHaveBeenCalled();
      });

      await vi.advanceTimersByTimeAsync(1000);
      await waitFor(() => {
        expect(transcriptCacheMocks.saveTranscriptCache).toHaveBeenCalled();
      });

      // surface는 여전히 정상 렌더/구동 상태여야 한다(저장 실패가 runtime을 죽이지 않음).
      const shell = await findByTestId(TEST_IDS.agentRuntimeShell);
      expect(shell).toBeInTheDocument();
      const metadata = await findByTestId(TEST_IDS.agentRuntimeMetadata);
      expect(metadata.textContent).toContain("codex");
    } finally {
      vi.useRealTimers();
    }
  });

  it("OQ-06: publishes direct runtime status changes for tab badges", async () => {
    const { port, emit } = makeFakePort();
    const onAgentRuntimeStatusChange = vi.fn();
    render(AgentTranscriptSurface, {
      props: baseProps(port, { onAgentRuntimeStatusChange }),
    });

    emit({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "thread-1" },
      status: "running",
    });

    await waitFor(() => {
      expect(onAgentRuntimeStatusChange).toHaveBeenCalledWith("running");
    });
  });

  it("shows non-secret runtime metadata without exposing provider ids", async () => {
    const { port } = makeFakePort();
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-secret", sessionId: "session-secret" },
      protocolVersion: "codex-v2",
      adapterVersion: "adapter-1",
      providerVersion: "codex-0.142.2",
      canResume: true,
      canLoad: false,
    });
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });

    const metadata = await findByTestId(TEST_IDS.agentRuntimeMetadata);

    expect(metadata.textContent).toContain("codex");
    expect(metadata.textContent).toContain("codex-v2");
    expect(metadata.textContent).toContain("adapter-1");
    expect(metadata.textContent).toContain("codex-0.142.2");
    expect(metadata.textContent).toContain("Resume");
    expect(metadata.textContent).not.toContain("Load");
    expect(metadata.textContent).not.toContain("thread-secret");
    expect(metadata.textContent).not.toContain("session-secret");
  });

  it("shows Codex sandbox, approval policy, and approvals reviewer as session badges", async () => {
    const { port } = makeFakePort();
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });

    const metadata = await findByTestId(TEST_IDS.agentRuntimeMetadata);

    expect(metadata.textContent).toContain("Sandbox");
    expect(metadata.textContent).toContain("workspace-write");
    expect(metadata.textContent).toContain("Approval");
    expect(metadata.textContent).toContain("on-request");
    expect(metadata.textContent).toContain("Reviewer");
    expect(metadata.textContent).toContain("auto_review");
  });

  it("marks bypass/full-access metadata badges as high-risk warnings", async () => {
    const { port } = makeFakePort();
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      sandbox: "danger-full-access",
      permissionMode: "bypassPermissions",
    });
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });

    const metadata = await findByTestId(TEST_IDS.agentRuntimeMetadata);
    const highRiskBadges = metadata.querySelectorAll('[data-risk="high"]');

    expect(highRiskBadges).toHaveLength(2);
    expect(highRiskBadges[0].textContent).toContain("High Risk");
    expect(highRiskBadges[0].textContent).toContain("danger-full-access");
    expect(highRiskBadges[1].textContent).toContain("bypassPermissions");
  });

  it("updates Claude mode metadata badges from runtime metadata events", async () => {
    const { port, emit } = makeFakePort();
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "claude", sessionId: "claude-session-1" },
      sessionMode: "default",
      permissionMode: "default",
      canResume: true,
      canLoad: false,
    });
    const onAgentRuntimeMetadataChange = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentId: "claude",
        runtimeKind: "direct-claude",
        onAgentRuntimeMetadataChange,
      }),
    });

    const metadata = await findByTestId(TEST_IDS.agentRuntimeMetadata);
    await waitFor(() => {
      expect(metadata.textContent).toContain("Permission Mode");
      expect(metadata.textContent).toContain("default");
    });

    emit({
      type: "runtime_metadata_changed",
      ref: { provider: "claude", sessionId: "claude-session-1" },
      metadata: { sessionMode: "bypassPermissions", permissionMode: "bypassPermissions" },
    } as unknown as AgentEvent);

    await waitFor(() => {
      expect(metadata.textContent).toContain("Session Mode");
      expect(metadata.textContent).toContain("bypassPermissions");
      expect(onAgentRuntimeMetadataChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          provider: "claude",
          providerSessionId: "claude-session-1",
          sessionMode: "bypassPermissions",
          permissionMode: "bypassPermissions",
        }),
      );
    });
  });

  it("shows the current runtime mode near the composer and updates it from metadata events", async () => {
    const { port, emit } = makeFakePort();
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "claude", sessionId: "claude-session-1" },
      sessionMode: "default",
      permissionMode: "default",
      canResume: true,
      canLoad: false,
    });
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentId: "claude",
        runtimeKind: "direct-claude",
      }),
    });

    const composer = await findByTestId(TEST_IDS.agentComposer);
    await waitFor(() => {
      expect(composer.textContent).toContain("default");
    });

    emit({
      type: "runtime_metadata_changed",
      ref: { provider: "claude", sessionId: "claude-session-1" },
      metadata: { permissionMode: "bypassPermissions" },
    } as unknown as AgentEvent);

    await waitFor(() => {
      expect(composer.textContent).toContain("bypassPermissions");
    });
  });

  it("uses resumeSession when in-memory direct runtime metadata has provider ids", async () => {
    const { port } = makeFakePort();
    render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          providerSessionId: "session-tree-1",
          providerThreadId: "thread-1",
          canResume: true,
          canLoad: true,
        },
      }),
    });

    await waitFor(() => {
      expect(port.resumeSession).toHaveBeenCalledWith({
        sessionHandle: "S1",
        provider: "codex",
        distro: "Ubuntu",
        workDir: "/w",
        providerSessionId: "session-tree-1",
        providerThreadId: "thread-1",
        replay: true,
        options: undefined,
      });
    });
    expect(port.startSession).not.toHaveBeenCalled();
  });

  it("shows a cold-restore notice when scrubbed metadata has no provider ids", async () => {
    const { port } = makeFakePort();
    const { getByText } = render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          canResume: true,
          canLoad: true,
        },
      }),
    });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    expect(port.resumeSession).not.toHaveBeenCalled();
    expect(getByText("Previous conversation could not be restored.")).toBeInTheDocument();
  });

  it("starts a new direct session and shows a restore notice when provider resume fails", async () => {
    const { port } = makeFakePort();
    port.resumeSession = vi.fn().mockRejectedValue(new Error("thread gone"));
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-2", sessionId: "session-tree-2" },
      canResume: true,
      canLoad: true,
    });
    const { getByText, queryByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          providerSessionId: "session-tree-1",
          providerThreadId: "thread-1",
          canResume: true,
          canLoad: true,
        },
      }),
    });

    await waitFor(() => {
      expect(port.resumeSession).toHaveBeenCalledWith({
        sessionHandle: "S1",
        provider: "codex",
        distro: "Ubuntu",
        workDir: "/w",
        providerSessionId: "session-tree-1",
        providerThreadId: "thread-1",
        replay: true,
        options: undefined,
      });
    });
    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledWith({
        sessionHandle: "S1",
        provider: "codex",
        distro: "Ubuntu",
        workDir: "/w",
        options: undefined,
      });
    });
    expect(getByText("Previous conversation could not be restored.")).toBeInTheDocument();
    expect(queryByTestId(TEST_IDS.agentRuntimeFallback)).toBeNull();
  });

  it("does not persist metadata patches from a failed resume attempt into fresh start metadata", async () => {
    const { port, emit } = makeFakePort();
    port.resumeSession = vi.fn().mockImplementation(async () => {
      emit({
        type: "runtime_metadata_changed",
        ref: { provider: "codex", threadId: "failed-thread" },
        metadata: { permissionMode: "bypassPermissions" },
      } as AgentEvent);
      throw new Error("thread gone");
    });
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-2", sessionId: "session-tree-2" },
      canResume: true,
      canLoad: true,
    });
    const onAgentRuntimeMetadataChange = vi.fn();
    render(AgentTranscriptSurface, {
      props: baseProps(port, {
        onAgentRuntimeMetadataChange,
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          providerSessionId: "session-tree-1",
          providerThreadId: "thread-1",
          canResume: true,
          canLoad: true,
        },
      }),
    });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledWith({
        sessionHandle: "S1",
        provider: "codex",
        distro: "Ubuntu",
        workDir: "/w",
        options: undefined,
      });
    });
    await waitFor(() => {
      expect(onAgentRuntimeMetadataChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          provider: "codex",
          providerThreadId: "thread-2",
          providerSessionId: "session-tree-2",
        }),
      );
    });
    expect(onAgentRuntimeMetadataChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "bypassPermissions" }),
    );
  });

  it("does not merge replay transcript events from a failed resume attempt into the fresh start", async () => {
    const { port, emit } = makeFakePort();
    port.resumeSession = vi.fn().mockImplementation(async () => {
      emit({
        type: "agent_message",
        ref: {
          provider: "codex",
          threadId: "failed-thread",
          turnId: "failed-turn",
          itemId: "failed-item",
        },
        content: [{ type: "text", text: "Stale replay response" }],
        mode: "replace",
      } as AgentEvent);
      throw new Error("thread gone");
    });
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-2", sessionId: "session-tree-2" },
      canResume: true,
      canLoad: true,
    });
    const { queryByText } = render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          providerSessionId: "session-tree-1",
          providerThreadId: "thread-1",
          canResume: true,
          canLoad: true,
        },
      }),
    });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledWith({
        sessionHandle: "S1",
        provider: "codex",
        distro: "Ubuntu",
        workDir: "/w",
        options: undefined,
      });
    });
    await tick();
    await tick();

    expect(queryByText("Stale replay response")).toBeNull();
  });

  it("shows restoring state and locks the composer while resume replay is pending", async () => {
    const { port, emit } = makeFakePort();
    let resolveResume: ((value: SessionStartResult) => void) | undefined;
    const onAgentRuntimeStatusChange = vi.fn();
    port.resumeSession = vi.fn().mockImplementation(
      () =>
        new Promise<SessionStartResult>((resolve) => {
          resolveResume = resolve;
        }),
    );
    const { findByText, getByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          providerSessionId: "session-tree-1",
          providerThreadId: "thread-1",
          canResume: true,
          canLoad: true,
        },
        onAgentRuntimeStatusChange,
      }),
    });

    await waitFor(() => {
      expect(port.resumeSession).toHaveBeenCalledWith({
        sessionHandle: "S1",
        provider: "codex",
        distro: "Ubuntu",
        workDir: "/w",
        providerSessionId: "session-tree-1",
        providerThreadId: "thread-1",
        replay: true,
        options: undefined,
      });
    });

    expect(await findByText("Restoring…")).toBeTruthy();
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("Restoring session…");

    emit({
      type: "agent_message",
      ref: {
        provider: "codex",
        sessionId: "session-tree-1",
        threadId: "thread-1",
        turnId: "restored-turn",
        itemId: "restored-message",
      },
      content: [{ type: "text", text: "Restored replay message before result" }],
      mode: "replace",
    });

    expect(await findByText("Restored replay message before result")).toBeTruthy();
    expect(await findByText("Restoring…")).toBeTruthy();
    expect(input.disabled).toBe(true);
    expect(onAgentRuntimeStatusChange).not.toHaveBeenCalledWith("running");

    emit({
      type: "session_loaded",
      ref: { provider: "codex", sessionId: "session-tree-1", threadId: "thread-1" },
    });
    resolveResume?.({
      ref: { provider: "codex", sessionId: "session-tree-1", threadId: "thread-1" },
      canResume: true,
      canLoad: true,
    });

    await waitFor(() => {
      expect(input.disabled).toBe(false);
    });
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
      props: baseProps(failingPort, { onFallbackToPty, resumeToken: "legacy-resume-1" }),
    });

    const panel = await findByTestId(TEST_IDS.agentRuntimeFallback);
    expect(panel.getAttribute("aria-modal")).toBe("true");
    // 자동 폴백 금지 — 패널만 표시되고 PTY 전환은 아직 호출되지 않는다.
    expect(onFallbackToPty).not.toHaveBeenCalled();
  });

  it("OQ-60: keeps post-start fatal runtime errors on the notice path without fallback", async () => {
    const { port, emit } = makeFakePort();
    const ref = { provider: "codex" as const, threadId: "thread-1", sessionId: "session-tree-1" };
    const onFallbackToPty = vi.fn();
    const onAgentRuntimeStatusChange = vi.fn();
    const { getByText, queryByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, { onFallbackToPty, onAgentRuntimeStatusChange }),
    });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    emit({ type: "session_started", ref, cwd: "/w" });
    await waitFor(() => {
      expect(onAgentRuntimeStatusChange).toHaveBeenCalledWith("ready");
    });

    emit({ type: "error", ref, message: "fatal framing break", recoverable: false });

    await waitFor(() => {
      expect(getByText("An error occurred.")).toBeInTheDocument();
      expect(onAgentRuntimeStatusChange).toHaveBeenCalledWith("failed");
    });
    expect(queryByTestId(TEST_IDS.agentRuntimeFallback)).toBeNull();
    expect(onFallbackToPty).not.toHaveBeenCalled();
  });

  it("OQ-60: keeps post-start process exits on the notice path without fallback", async () => {
    const { port, emit } = makeFakePort();
    const ref = { provider: "codex" as const, threadId: "thread-1", sessionId: "session-tree-1" };
    const onFallbackToPty = vi.fn();
    const onAgentRuntimeStatusChange = vi.fn();
    const { getByText, queryByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, { onFallbackToPty, onAgentRuntimeStatusChange }),
    });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    emit({ type: "session_started", ref, cwd: "/w" });
    await waitFor(() => {
      expect(onAgentRuntimeStatusChange).toHaveBeenCalledWith("ready");
    });

    emit({ type: "process_exited", ref, code: 1 });

    await waitFor(() => {
      expect(getByText("The agent process has exited.")).toBeInTheDocument();
      expect(onAgentRuntimeStatusChange).toHaveBeenCalledWith("exited");
    });
    expect(queryByTestId(TEST_IDS.agentRuntimeFallback)).toBeNull();
    expect(onFallbackToPty).not.toHaveBeenCalled();
  });

  it("waits for the failed direct runtime shutdown before retrying start", async () => {
    let resolveShutdown: (() => void) | undefined;
    const firstPort: AgentRuntimePort = {
      startSession: vi.fn().mockRejectedValue(new Error("initialize timeout")),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn(() => vi.fn()),
      shutdown: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveShutdown = resolve;
          }),
      ),
    };
    const secondPort: AgentRuntimePort = {
      startSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn(() => vi.fn()),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const createPort = vi.fn().mockReturnValueOnce(firstPort).mockReturnValueOnce(secondPort);
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(firstPort, { createPort }),
    });

    const retryButton = await findByTestId(TEST_IDS.agentRuntimeFallbackRetry);
    await fireEvent.click(retryButton);

    expect(firstPort.shutdown).toHaveBeenCalledWith("S1");
    expect(secondPort.startSession).not.toHaveBeenCalled();

    resolveShutdown?.();

    await waitFor(() => {
      expect(secondPort.startSession).toHaveBeenCalledOnce();
    });
  });

  it("does not merge metadata patches from a failed start attempt into retry metadata", async () => {
    let firstListener: ((e: AgentEvent) => void) | null = null;
    const firstPort: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(async () => {
        firstListener?.({
          type: "runtime_metadata_changed",
          ref: { provider: "codex", threadId: "failed-thread" },
          metadata: { permissionMode: "bypassPermissions" },
        } as AgentEvent);
        throw new Error("initialize timeout");
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, listener) => {
        firstListener = listener;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const secondPort: AgentRuntimePort = {
      startSession: vi.fn().mockResolvedValue({
        ref: { provider: "codex", threadId: "thread-2", sessionId: "session-tree-2" },
        canResume: true,
        canLoad: true,
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn(() => vi.fn()),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const createPort = vi.fn().mockReturnValueOnce(firstPort).mockReturnValueOnce(secondPort);
    const onAgentRuntimeMetadataChange = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(firstPort, { createPort, onAgentRuntimeMetadataChange }),
    });

    const retryButton = await findByTestId(TEST_IDS.agentRuntimeFallbackRetry);
    await fireEvent.click(retryButton);

    await waitFor(() => {
      expect(secondPort.startSession).toHaveBeenCalledOnce();
      expect(onAgentRuntimeMetadataChange).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ permissionMode: "bypassPermissions" }),
      );
    });
  });

  it("ignores late metadata patches from a failed start while fallback is visible", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    const failingPort: AgentRuntimePort = {
      startSession: vi.fn().mockRejectedValue(new Error("initialize timeout")),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onAgentRuntimeMetadataChange = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(failingPort, {
        onAgentRuntimeMetadataChange,
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          canResume: false,
          canLoad: false,
        },
      }),
    });

    await findByTestId(TEST_IDS.agentRuntimeFallback);
    const emitRuntimeEvent = listener as ((event: AgentEvent) => void) | null;
    expect(emitRuntimeEvent).not.toBeNull();
    emitRuntimeEvent?.({
      type: "runtime_metadata_changed",
      ref: { provider: "codex", threadId: "failed-thread" },
      metadata: { permissionMode: "bypassPermissions" },
    } as AgentEvent);

    expect(onAgentRuntimeMetadataChange).not.toHaveBeenCalled();
  });

  it("ignores late title updates from a failed start while fallback is visible", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    const failingPort: AgentRuntimePort = {
      startSession: vi.fn().mockRejectedValue(new Error("initialize timeout")),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onSessionTitleChange = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(failingPort, { onSessionTitleChange }),
    });

    await findByTestId(TEST_IDS.agentRuntimeFallback);
    const emitRuntimeEvent = listener as ((event: AgentEvent) => void) | null;
    expect(emitRuntimeEvent).not.toBeNull();
    emitRuntimeEvent?.({
      type: "session_title_changed",
      ref: { provider: "codex", threadId: "failed-thread" },
      title: "Stale failed session",
    } as AgentEvent);

    expect(onSessionTitleChange).not.toHaveBeenCalled();
  });

  it("does not publish pre-result title updates from a start attempt that fails", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    const failingPort: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(async () => {
        listener?.({
          type: "session_title_changed",
          ref: { provider: "codex", threadId: "failed-thread" },
          title: "Pre-start failed session",
        } as AgentEvent);
        throw new Error("initialize timeout");
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onSessionTitleChange = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(failingPort, { onSessionTitleChange }),
    });

    await findByTestId(TEST_IDS.agentRuntimeFallback);

    expect(onSessionTitleChange).not.toHaveBeenCalled();
  });

  it("publishes pre-result title updates after the start attempt succeeds", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    let resolveStart: ((result: SessionStartResult) => void) | undefined;
    const port: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(() => {
        listener?.({
          type: "session_title_changed",
          ref: { provider: "codex", threadId: "thread-1" },
          title: "Pre-start successful session",
        } as AgentEvent);
        return new Promise<SessionStartResult>((resolve) => {
          resolveStart = resolve;
        });
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onSessionTitleChange = vi.fn();
    render(AgentTranscriptSurface, {
      props: baseProps(port, { onSessionTitleChange }),
    });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    await tick();
    expect(onSessionTitleChange).not.toHaveBeenCalled();

    resolveStart?.({
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      canResume: true,
      canLoad: true,
    });

    await waitFor(() => {
      expect(onSessionTitleChange).toHaveBeenCalledWith("Pre-start successful session");
    });
    expect(onSessionTitleChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the direct runtime active when pre-result title persistence fails", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    const port: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(async () => {
        listener?.({
          type: "session_title_changed",
          ref: { provider: "codex", threadId: "thread-1" },
          title: "Title persistence failure should not fail start",
        } as AgentEvent);
        return {
          ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
          canResume: true,
          canLoad: true,
        };
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onSessionTitleChange = vi.fn().mockRejectedValue(new Error("title store unavailable"));
    const { queryByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, { onSessionTitleChange }),
    });

    await waitFor(() => {
      expect(onSessionTitleChange).toHaveBeenCalledWith(
        "Title persistence failure should not fail start",
      );
    });
    await tick();

    expect(queryByTestId(TEST_IDS.agentRuntimeFallback)).toBeNull();
  });

  it("does not publish pre-result status updates from a start attempt that fails", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    const failingPort: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(async () => {
        listener?.({
          type: "session_status_changed",
          ref: { provider: "codex", threadId: "failed-thread" },
          status: "running",
        } as AgentEvent);
        throw new Error("initialize timeout");
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onAgentRuntimeStatusChange = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(failingPort, { onAgentRuntimeStatusChange }),
    });

    await findByTestId(TEST_IDS.agentRuntimeFallback);

    expect(onAgentRuntimeStatusChange).not.toHaveBeenCalledWith("running");
  });

  it("does not publish pre-result session_started status from a start attempt that fails", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    const failingPort: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(async () => {
        listener?.({
          type: "session_started",
          ref: { provider: "codex", threadId: "failed-thread", sessionId: "failed-session" },
          cwd: "/w",
        } as AgentEvent);
        throw new Error("initialize timeout");
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onAgentRuntimeStatusChange = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(failingPort, { onAgentRuntimeStatusChange }),
    });

    await findByTestId(TEST_IDS.agentRuntimeFallback);

    expect(onAgentRuntimeStatusChange).not.toHaveBeenCalledWith("ready");
  });

  it("does not render pre-result transcript events from a start attempt that fails", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    const failingPort: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(async () => {
        listener?.({
          type: "agent_message",
          ref: {
            provider: "codex",
            threadId: "failed-thread",
            turnId: "failed-turn",
            itemId: "failed-item",
          },
          content: [{ type: "text", text: "Stale failed start response" }],
          mode: "replace",
        } as AgentEvent);
        throw new Error("initialize timeout");
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const { findByTestId, queryByText } = render(AgentTranscriptSurface, {
      props: baseProps(failingPort),
    });

    await findByTestId(TEST_IDS.agentRuntimeFallback);
    await tick();
    await tick();

    expect(queryByText("Stale failed start response")).toBeNull();
  });

  it("renders pre-result transcript events after the start attempt succeeds", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    let resolveStart: ((result: SessionStartResult) => void) | undefined;
    const port: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(() => {
        listener?.({
          type: "agent_message",
          ref: {
            provider: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "item-1",
          },
          content: [{ type: "text", text: "Buffered successful start response" }],
          mode: "replace",
        } as AgentEvent);
        return new Promise<SessionStartResult>((resolve) => {
          resolveStart = resolve;
        });
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const { queryByText, findByText } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    await tick();
    expect(queryByText("Buffered successful start response")).toBeNull();

    resolveStart?.({
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      canResume: true,
      canLoad: true,
    });

    expect(await findByText("Buffered successful start response")).toBeTruthy();
  });

  it("publishes pre-result status updates after the start attempt succeeds", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    let resolveStart: ((result: SessionStartResult) => void) | undefined;
    const port: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(() => {
        listener?.({
          type: "session_status_changed",
          ref: { provider: "codex", threadId: "thread-1" },
          status: "running",
        } as AgentEvent);
        return new Promise<SessionStartResult>((resolve) => {
          resolveStart = resolve;
        });
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onAgentRuntimeStatusChange = vi.fn();
    render(AgentTranscriptSurface, {
      props: baseProps(port, { onAgentRuntimeStatusChange }),
    });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    await tick();
    expect(onAgentRuntimeStatusChange).not.toHaveBeenCalledWith("running");
    onAgentRuntimeStatusChange.mockClear();

    resolveStart?.({
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      canResume: true,
      canLoad: true,
    });

    await waitFor(() => {
      expect(onAgentRuntimeStatusChange).toHaveBeenCalledWith("running");
    });
    expect(onAgentRuntimeStatusChange).toHaveBeenCalledTimes(1);
  });

  it("publishes pre-result session_started status after the start attempt succeeds", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    let resolveStart: ((result: SessionStartResult) => void) | undefined;
    const port: AgentRuntimePort = {
      startSession: vi.fn().mockImplementation(() => {
        listener?.({
          type: "session_started",
          ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
          cwd: "/w",
        } as AgentEvent);
        return new Promise<SessionStartResult>((resolve) => {
          resolveStart = resolve;
        });
      }),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onAgentRuntimeStatusChange = vi.fn();
    render(AgentTranscriptSurface, {
      props: baseProps(port, { onAgentRuntimeStatusChange }),
    });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    await tick();
    expect(onAgentRuntimeStatusChange).not.toHaveBeenCalledWith("ready");
    onAgentRuntimeStatusChange.mockClear();

    resolveStart?.({
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      canResume: true,
      canLoad: true,
    });

    await waitFor(() => {
      expect(onAgentRuntimeStatusChange).toHaveBeenCalledWith("ready");
    });
    expect(onAgentRuntimeStatusChange).toHaveBeenCalledTimes(1);
  });

  it("ignores late status updates from a failed start while fallback is visible", async () => {
    let listener: ((e: AgentEvent) => void) | null = null;
    const failingPort: AgentRuntimePort = {
      startSession: vi.fn().mockRejectedValue(new Error("initialize timeout")),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn((_handle, next) => {
        listener = next;
        return vi.fn();
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const onAgentRuntimeStatusChange = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(failingPort, { onAgentRuntimeStatusChange }),
    });

    await findByTestId(TEST_IDS.agentRuntimeFallback);
    onAgentRuntimeStatusChange.mockClear();
    const emitRuntimeEvent = listener as ((event: AgentEvent) => void) | null;
    expect(emitRuntimeEvent).not.toBeNull();
    emitRuntimeEvent?.({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "failed-thread" },
      status: "running",
    } as AgentEvent);
    await tick();
    await tick();

    expect(onAgentRuntimeStatusChange).not.toHaveBeenCalledWith("running");
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
      props: baseProps(failingPort, { onFallbackToPty, resumeToken: "legacy-resume-1" }),
    });

    const ptyButton = await findByTestId(TEST_IDS.agentRuntimeFallbackPty);
    await fireEvent.click(ptyButton);

    await waitFor(() => {
      expect(onFallbackToPty).toHaveBeenCalledWith({
        sessionId: "S1",
        agentId: "codex",
        distro: "Ubuntu",
        workDir: "/w",
        resumeToken: "legacy-resume-1",
      });
    });
  });

  it("waits for the failed direct runtime shutdown before opening legacy PTY fallback", async () => {
    let resolveShutdown: (() => void) | undefined;
    const failingPort: AgentRuntimePort = {
      startSession: vi.fn().mockRejectedValue(new Error("initialize timeout")),
      resumeSession: vi.fn().mockResolvedValue({ ref: { provider: "codex" } }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancelTurn: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn(() => vi.fn()),
      shutdown: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveShutdown = resolve;
          }),
      ),
    };
    const onFallbackToPty = vi.fn();
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(failingPort, { onFallbackToPty, resumeToken: "legacy-resume-1" }),
    });

    const ptyButton = await findByTestId(TEST_IDS.agentRuntimeFallbackPty);
    await fireEvent.click(ptyButton);

    expect(failingPort.shutdown).toHaveBeenCalledWith("S1");
    expect(onFallbackToPty).not.toHaveBeenCalled();

    resolveShutdown?.();

    await waitFor(() => {
      expect(onFallbackToPty).toHaveBeenCalledWith({
        sessionId: "S1",
        agentId: "codex",
        distro: "Ubuntu",
        workDir: "/w",
        resumeToken: "legacy-resume-1",
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

  it("scrolls pending inline approval into view even when auto-follow is paused", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const { port, emit } = makeFakePort();
      const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
      const region = await findByTestId(TEST_IDS.agentTranscript);
      mockScrollMetrics(region, 1000, 200);

      // 사용자가 위로 스크롤해 auto-follow가 꺼져도 approval은 별도 경로로 view에 끌어온다.
      region.scrollTop = 0;
      await fireEvent.scroll(region);

      const ref = { provider: "codex" as const, threadId: "t", turnId: "u", toolCallId: "tool-1" };
      emit({
        type: "tool_call_updated",
        ref,
        update: {
          id: "tool-1",
          title: "Run command",
          kind: "execute",
          status: "pending",
        },
      });
      emit({
        type: "approval_requested",
        ref: { ...ref, requestId: "req-1" },
        request: {
          id: "req-1",
          title: "Run command?",
          toolCallId: "tool-1",
          options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
        },
      });

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
