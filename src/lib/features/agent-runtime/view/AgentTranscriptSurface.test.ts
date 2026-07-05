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
import type { ResumeKeys } from "../service/resume-store";
import type { TranscriptCacheSnapshot } from "../service/transcript-cache";
import type { TranscriptModel } from "../contracts/transcript";
import { resetRegistry } from "../controller/agent-event-router";
import AgentTranscriptSurface from "./AgentTranscriptSurface.svelte";

/**
 * ②-C: turn 옵션 셀렉터(mode/model/effort/approval)는 composer의 옵션 popover 뒤로 통합됐다.
 * 셀렉터가 채워지면 옵션 토글이 뜨므로, 이를 기다렸다 열어 셀렉터에 접근한다.
 */
async function openSurfaceOptions(
  findByTestId: (id: string) => Promise<HTMLElement>,
): Promise<void> {
  const toggle = await findByTestId(TEST_IDS.agentComposerOptionsToggle);
  await fireEvent.click(toggle);
}

const editorMocks = vi.hoisted(() => ({
  searchSessionFiles: vi.fn(),
}));

vi.mock("../../../editors", () => ({
  searchSessionFiles: editorMocks.searchSessionFiles,
}));

// OQ-16: 진행 중 재개 id·transcript 캐시 저장 훅 검증용 mock(Task 4/5/6 서비스).
// Task 9: cold restart resume 소스는 암호화 저장소(loadResumeKeys)이므로 로드 mock도 함께 둔다(기본 null).
const resumeStoreMocks = vi.hoisted(() => ({
  saveResumeKeys: vi.fn().mockResolvedValue(undefined),
  loadResumeKeys: vi.fn<(sessionHandle: string) => Promise<ResumeKeys | null>>(() =>
    Promise.resolve(null),
  ),
}));
const transcriptCacheMocks = vi.hoisted(() => ({
  saveTranscriptCache: vi.fn().mockResolvedValue(undefined),
  serializeTranscript: vi.fn<(model: unknown) => TranscriptCacheSnapshot>(() => ({
    schemaVersion: 1,
    visibleItemIds: [],
    items: [],
    turns: [],
  })),
  // OQ-16 Task 8: cold restart 캐시 즉시 hydrate 검증용(기본은 캐시 없음 → null).
  loadTranscriptCache: vi.fn<(sessionHandle: string) => Promise<TranscriptCacheSnapshot | null>>(
    () => Promise.resolve(null),
  ),
  deserializeTranscript: vi.fn<(snap: TranscriptCacheSnapshot) => TranscriptModel | null>(() => null),
}));

vi.mock("../service/resume-store", () => ({
  saveResumeKeys: resumeStoreMocks.saveResumeKeys,
  loadResumeKeys: resumeStoreMocks.loadResumeKeys,
}));
vi.mock("../service/transcript-cache", () => ({
  saveTranscriptCache: transcriptCacheMocks.saveTranscriptCache,
  serializeTranscript: transcriptCacheMocks.serializeTranscript,
  loadTranscriptCache: transcriptCacheMocks.loadTranscriptCache,
  deserializeTranscript: transcriptCacheMocks.deserializeTranscript,
}));

function makeFakePort(
  options: {
    canResume?: boolean;
    canLoad?: boolean;
    models?: unknown[];
    startModel?: string;
    startEffort?: string;
    startApprovalPolicy?: string;
  } = {},
) {
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
      ...(options.startModel ? { model: options.startModel } : {}),
      ...(options.startEffort ? { effort: options.startEffort } : {}),
      ...(options.startApprovalPolicy ? { approvalPolicy: options.startApprovalPolicy } : {}),
    }),
    resumeSession: vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      canResume,
      canLoad,
    }),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    cancelTurn: vi.fn().mockResolvedValue(undefined),
    respondApproval: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue(options.models ?? []),
    setTurnOptions: vi.fn(),
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
    resumeStoreMocks.loadResumeKeys.mockReset();
    resumeStoreMocks.loadResumeKeys.mockResolvedValue(null);
    transcriptCacheMocks.saveTranscriptCache.mockReset();
    transcriptCacheMocks.saveTranscriptCache.mockResolvedValue(undefined);
    transcriptCacheMocks.serializeTranscript.mockReset();
    transcriptCacheMocks.serializeTranscript.mockReturnValue({
      schemaVersion: 1,
      visibleItemIds: [],
      items: [],
      turns: [],
    });
    transcriptCacheMocks.loadTranscriptCache.mockReset();
    transcriptCacheMocks.loadTranscriptCache.mockResolvedValue(null);
    transcriptCacheMocks.deserializeTranscript.mockReset();
    transcriptCacheMocks.deserializeTranscript.mockReturnValue(null);
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

  it("②-B: 세션 시작 후 모델 목록을 채우고 세션 실제 모델을 override 없이 선택한다", async () => {
    const { port } = makeFakePort({
      startModel: "gpt-b",
      startEffort: "medium",
      models: [
        { id: "gpt-a", label: "GPT A", efforts: [{ id: "low" }, { id: "high" }], defaultEffort: "low" },
        { id: "gpt-b", label: "GPT B", efforts: [{ id: "medium" }], defaultEffort: "medium", isDefault: true },
      ],
    });
    const { findByTestId, getByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port),
    });

    // model/list가 채워지면 셀렉터가 뜨고, 세션 실제 모델(gpt-b)이 초기 선택된다.
    await openSurfaceOptions(findByTestId);
    const modelSelect = (await findByTestId(TEST_IDS.agentComposerModelSelect)) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe("gpt-b"));
    // 초기 선택은 세션 실제 모델과 일치하므로 setTurnOptions를 부르지 않는다(화면=wire).
    expect(port.setTurnOptions).not.toHaveBeenCalled();

    // 사용자가 다른 모델로 바꾸면 그때 override를 건다.
    await fireEvent.change(modelSelect, { target: { value: "gpt-a" } });
    expect(port.setTurnOptions).toHaveBeenCalledWith("S1", { model: "gpt-a", effort: "low" });
    // gpt-a는 effort 지원 → effort 셀렉터 노출.
    expect(getByTestId(TEST_IDS.agentComposerEffortSelect)).toBeTruthy();
  });

  it("②-B: 세션의 실제 current model(비 default)을 초기 선택으로 우선한다", async () => {
    const { port } = makeFakePort({
      startModel: "gpt-a",
      startEffort: "high",
      models: [
        { id: "gpt-a", label: "GPT A", efforts: [{ id: "low" }, { id: "high" }], defaultEffort: "low" },
        { id: "gpt-default", label: "GPT Default", efforts: [{ id: "medium" }], defaultEffort: "medium", isDefault: true },
      ],
    });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    await openSurfaceOptions(findByTestId);
    const modelSelect = (await findByTestId(TEST_IDS.agentComposerModelSelect)) as HTMLSelectElement;
    // isDefault는 gpt-default지만 세션 실제 모델(gpt-a)이 초기 선택된다.
    await waitFor(() => expect(modelSelect.value).toBe("gpt-a"));
    const effortSelect = (await findByTestId(TEST_IDS.agentComposerEffortSelect)) as HTMLSelectElement;
    expect(effortSelect.value).toBe("high"); // 실제 current effort.
    // 권위 값과 일치하므로 override는 안 건다.
    expect(port.setTurnOptions).not.toHaveBeenCalled();
  });

  it("②-B: 실제 model을 모르는 경로(replay resume)는 모델을 자동 선택하지 않고 placeholder를 둔다", async () => {
    // startModel 미지정 → SessionStartResult에 model 없음(thread/read replay 경로 모사).
    const { port } = makeFakePort({
      models: [
        { id: "gpt-a", label: "GPT A", efforts: [{ id: "low" }] },
        { id: "gpt-default", label: "GPT Default", efforts: [{ id: "medium" }], defaultEffort: "medium", isDefault: true },
      ],
    });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    await openSurfaceOptions(findByTestId);
    const modelSelect = (await findByTestId(TEST_IDS.agentComposerModelSelect)) as HTMLSelectElement;
    // catalog default(gpt-default)를 잘못 표시하지 않는다 — value는 빈 값(placeholder).
    await waitFor(() => expect(modelSelect.value).toBe(""));
    expect(port.setTurnOptions).not.toHaveBeenCalled();
  });

  it("②-B: 실제 current model이 catalog에 없으면 합성 옵션으로 표시가 어긋나지 않게 한다", async () => {
    const { port } = makeFakePort({
      startModel: "gpt-legacy",
      startEffort: "high",
      models: [
        { id: "gpt-default", label: "GPT Default", efforts: [{ id: "medium" }], defaultEffort: "medium", isDefault: true },
      ],
    });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    await openSurfaceOptions(findByTestId);
    const modelSelect = (await findByTestId(TEST_IDS.agentComposerModelSelect)) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe("gpt-legacy"));
    expect(port.setTurnOptions).not.toHaveBeenCalled();
  });

  it("②-B: effort 미지원 모델로 바꾸면 effort override를 null로 해제한다", async () => {
    const { port } = makeFakePort({
      startModel: "gpt-a",
      startEffort: "low",
      models: [
        { id: "gpt-a", label: "GPT A", efforts: [{ id: "low" }], defaultEffort: "low", isDefault: true },
        { id: "gpt-noeffort", label: "No Effort", efforts: [] },
      ],
    });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    await openSurfaceOptions(findByTestId);
    const modelSelect = (await findByTestId(TEST_IDS.agentComposerModelSelect)) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe("gpt-a"));

    await fireEvent.change(modelSelect, { target: { value: "gpt-noeffort" } });
    expect(port.setTurnOptions).toHaveBeenCalledWith("S1", { model: "gpt-noeffort", effort: null });
  });

  it("②-C: 세션 시작 approvalPolicy를 approval 셀렉터 초기값으로 두고 저위험 변경을 override로 건다", async () => {
    const { port } = makeFakePort({ startApprovalPolicy: "on-request" });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    await openSurfaceOptions(findByTestId);
    const approvalSelect = (await findByTestId(TEST_IDS.agentComposerApprovalSelect)) as HTMLSelectElement;
    await waitFor(() => expect(approvalSelect.value).toBe("on-request"));
    // 초기값은 세션 시작 권위값과 일치 → override 미설정.
    expect(port.setTurnOptions).not.toHaveBeenCalled();

    await fireEvent.change(approvalSelect, { target: { value: "on-failure" } });
    // base("on-request")와 다른 저위험 값 → 즉시 override 전달(확인 게이트 없음).
    expect(port.setTurnOptions).toHaveBeenCalledWith("S1", { approvalPolicy: "on-failure" });
  });

  it("②-C: 명시 scalar는 base와 같아도 그 값을 전송한다(stale base로 null revert 금지)", async () => {
    const { port } = makeFakePort({ startApprovalPolicy: "on-request" });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    await openSurfaceOptions(findByTestId);
    const approvalSelect = (await findByTestId(TEST_IDS.agentComposerApprovalSelect)) as HTMLSelectElement;
    await waitFor(() => expect(approvalSelect.value).toBe("on-request"));
    await fireEvent.change(approvalSelect, { target: { value: "on-failure" } });
    // base("on-request") 재선택 → null이 아니라 명시 on-request 전송(UI 표시=wire 값, 위험 은닉 방지).
    await fireEvent.change(approvalSelect, { target: { value: "on-request" } });
    expect(port.setTurnOptions).toHaveBeenLastCalledWith("S1", { approvalPolicy: "on-request" });
  });

  it("②-C: never override 후 안전 scalar 복귀는 그 scalar를 전송하고 고위험을 해제한다", async () => {
    const { port, emit } = makeFakePort({ startApprovalPolicy: "on-request" });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    emit({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      status: "ready",
    });
    await openSurfaceOptions(findByTestId);
    const approvalSelect = (await findByTestId(TEST_IDS.agentComposerApprovalSelect)) as HTMLSelectElement;
    await waitFor(() => expect(approvalSelect.value).toBe("on-request"));
    // never 적용(확인 게이트 통과).
    await fireEvent.change(approvalSelect, { target: { value: "never" } });
    // never 선택 시 popover가 닫히므로 확인 후 다시 열어 셀렉터에 접근한다.
    await fireEvent.click(await findByTestId(TEST_IDS.agentComposerApprovalConfirmAccept));
    expect(port.setTurnOptions).toHaveBeenLastCalledWith("S1", { approvalPolicy: "never" });
    await openSurfaceOptions(findByTestId);
    const approvalSelect2 = (await findByTestId(TEST_IDS.agentComposerApprovalSelect)) as HTMLSelectElement;
    // 안전 scalar 복귀 → 명시 on-request 전송(provider default null 아님) + 고위험 해제.
    await fireEvent.change(approvalSelect2, { target: { value: "on-request" } });
    expect(port.setTurnOptions).toHaveBeenLastCalledWith("S1", { approvalPolicy: "on-request" });
    const toggle = await findByTestId(TEST_IDS.agentComposerOptionsToggle);
    await waitFor(() => expect(toggle.textContent).not.toContain("High Risk"));
  });

  it("②-C: never override 확정 시 metadata에 고위험 override chip이 뜬다", async () => {
    const { port, emit } = makeFakePort({ startApprovalPolicy: "on-request" });
    const { findByTestId, queryByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    // 고위험 확인 게이트는 ready/idle에서만 유지된다 → ready 상태를 emit해 modeSelectEnabled를 만든다.
    emit({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      status: "ready",
    });
    await openSurfaceOptions(findByTestId);
    const approvalSelect = (await findByTestId(TEST_IDS.agentComposerApprovalSelect)) as HTMLSelectElement;
    await waitFor(() => expect(approvalSelect.value).toBe("on-request"));
    // never는 확인 게이트를 거쳐야 적용된다.
    await fireEvent.change(approvalSelect, { target: { value: "never" } });
    expect(queryByTestId(TEST_IDS.agentRuntimeApprovalOverride)).toBeNull(); // 확인 전엔 override 미확정.
    await fireEvent.click(await findByTestId(TEST_IDS.agentComposerApprovalConfirmAccept));
    expect(port.setTurnOptions).toHaveBeenCalledWith("S1", { approvalPolicy: "never" });
    // base badge는 유지되고, 다음 turn에 적용될 never가 고위험 chip으로 노출된다(위험 숨김 방지).
    const chip = await findByTestId(TEST_IDS.agentRuntimeApprovalOverride);
    expect(chip.closest("[data-risk='high']")).toBeTruthy();
  });

  it("②-C: 세션이 이미 never로 시작하면 override 없이도 고위험으로 표시한다(위험 은닉 방지)", async () => {
    const { port } = makeFakePort({ startApprovalPolicy: "never" });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    // override를 걸지 않아도 실효 정책(base=never)이 고위험이므로 metadata 항목에 data-risk=high가 붙는다.
    const approval = await findByTestId(TEST_IDS.agentRuntimeMetadata);
    await waitFor(() =>
      expect(approval.querySelector(".metadata-item[data-risk='high']")).toBeTruthy(),
    );
    // 옵션 토글에도 고위험 표시가 붙는다.
    const toggle = await findByTestId(TEST_IDS.agentComposerOptionsToggle);
    expect(toggle.textContent).toContain("High Risk");
  });

  it("②-C: thread/settings/updated로 approvalPolicy가 never로 바뀌면(override 없음) 고위험으로 갱신한다", async () => {
    const { port, emit } = makeFakePort({ startApprovalPolicy: "on-request" });
    const { findByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, { onAgentRuntimeMetadataChange: vi.fn() }),
    });
    const metadata = await findByTestId(TEST_IDS.agentRuntimeMetadata);
    // 시작값 on-request → 고위험 아님.
    await waitFor(() => expect(metadata.textContent).toContain("on-request"));
    const toggle = await findByTestId(TEST_IDS.agentComposerOptionsToggle);
    expect(toggle.textContent).not.toContain("High Risk");
    // 서버가 권위 설정을 never로 다시 알림 → 로컬 override 없으므로 실효 정책=never → 고위험.
    emit({
      type: "runtime_metadata_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      metadata: { approvalPolicy: "never" },
    });
    await waitFor(() => expect(toggle.textContent).toContain("High Risk"));
    const approval = [...metadata.querySelectorAll(".metadata-item[data-risk='high']")].find((el) =>
      el.textContent?.includes("Approval"),
    );
    expect(approval).toBeTruthy();
  });

  it("②-C: approvalPolicy 미상(replay resume)이면 fail-closed로 고위험 표시한다", async () => {
    // startApprovalPolicy 미지정 → SessionStartResult에 approvalPolicy 없음(thread/read replay 경로 모사).
    const { port } = makeFakePort();
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    // 실제 정책을 확인할 수 없으므로 안전한 상태로 보이지 않게 approval 항목이 data-risk=high로 남는다.
    const metadata = await findByTestId(TEST_IDS.agentRuntimeMetadata);
    await waitFor(() => {
      const approval = [...metadata.querySelectorAll(".metadata-item[data-risk='high']")].find((el) =>
        el.textContent?.includes("Approval"),
      );
      expect(approval).toBeTruthy();
    });
    const toggle = await findByTestId(TEST_IDS.agentComposerOptionsToggle);
    expect(toggle.textContent).toContain("High Risk");
  });

  it("②-C: provider 기본값(sentinel) 선택은 결과 정책 미상이라 fail-closed 고위험으로 남는다", async () => {
    // base가 known scalar(on-request)라도, provider default revert의 실제 결과 정책은 알 수 없다.
    const { port, emit } = makeFakePort({ startApprovalPolicy: "on-request" });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    emit({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      status: "ready",
    });
    await openSurfaceOptions(findByTestId);
    const approvalSelect = (await findByTestId(TEST_IDS.agentComposerApprovalSelect)) as HTMLSelectElement;
    await waitFor(() => expect(approvalSelect.value).toBe("on-request"));
    // 초기(base on-request)는 고위험 아님.
    const toggle = await findByTestId(TEST_IDS.agentComposerOptionsToggle);
    expect(toggle.textContent).not.toContain("High Risk");
    // provider 기본값 선택 → 결과 미상(never 가능)이라 확인 게이트를 거친다.
    await fireEvent.change(approvalSelect, { target: { value: "__provider_default__" } });
    await fireEvent.click(await findByTestId(TEST_IDS.agentComposerApprovalConfirmAccept));
    expect(port.setTurnOptions).toHaveBeenLastCalledWith("S1", { approvalPolicy: null });
    await waitFor(() => expect(toggle.textContent).toContain("High Risk"));
    const metadata = await findByTestId(TEST_IDS.agentRuntimeMetadata);
    const approval = [...metadata.querySelectorAll(".metadata-item[data-risk='high']")].find((el) =>
      el.textContent?.includes("Approval"),
    );
    expect(approval).toBeTruthy();
  });

  it("②-C: provider 기본값 대기 중 settings echo(on-request)가 오면 sentinel을 해소해 권위값으로 안전 표시한다", async () => {
    const { port, emit } = makeFakePort({ startApprovalPolicy: "on-request" });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port, { onAgentRuntimeMetadataChange: vi.fn() }) });
    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    emit({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      status: "ready",
    });
    await openSurfaceOptions(findByTestId);
    const approvalSelect = (await findByTestId(TEST_IDS.agentComposerApprovalSelect)) as HTMLSelectElement;
    await waitFor(() => expect(approvalSelect.value).toBe("on-request"));
    // provider 기본값 선택(확인 게이트) → sentinel 대기(fail-closed 고위험).
    await fireEvent.change(approvalSelect, { target: { value: "__provider_default__" } });
    await fireEvent.click(await findByTestId(TEST_IDS.agentComposerApprovalConfirmAccept));
    const toggle = await findByTestId(TEST_IDS.agentComposerOptionsToggle);
    await waitFor(() => expect(toggle.textContent).toContain("High Risk"));
    // 서버가 권위 approval echo(on-request)를 알림 → sentinel 해소, 실효=권위값 → 고위험 아님.
    emit({
      type: "runtime_metadata_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      metadata: { approvalPolicy: "on-request" },
    });
    await waitFor(() => expect(toggle.textContent).not.toContain("High Risk"));
  });

  it("②-C: base가 granular/미상이어도 provider 기본값 옵션으로 override를 null 해제할 수 있다", async () => {
    // granular base — scalar 후보에 없어 placeholder로 시작하고 fail-closed 고위험이다.
    const { port, emit } = makeFakePort({ startApprovalPolicy: "granular" });
    const { findByTestId } = render(AgentTranscriptSurface, { props: baseProps(port) });
    await waitFor(() => expect(port.startSession).toHaveBeenCalledOnce());
    emit({
      type: "session_status_changed",
      ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
      status: "ready",
    });
    await openSurfaceOptions(findByTestId);
    const approvalSelect = (await findByTestId(TEST_IDS.agentComposerApprovalSelect)) as HTMLSelectElement;
    // granular는 scalar 후보 밖 → placeholder(빈 값).
    await waitFor(() => expect(approvalSelect.value).toBe(""));
    // scalar override(저위험)를 건 뒤에도 provider 기본값으로 되돌릴 수 있어야 한다.
    await fireEvent.change(approvalSelect, { target: { value: "on-request" } });
    expect(port.setTurnOptions).toHaveBeenLastCalledWith("S1", { approvalPolicy: "on-request" });
    // provider 기본값 sentinel은 확인 게이트를 거친다(결과 미상). popover가 닫히므로 확인 배너에서 수락한다.
    await fireEvent.change(approvalSelect, { target: { value: "__provider_default__" } });
    await fireEvent.click(await findByTestId(TEST_IDS.agentComposerApprovalConfirmAccept));
    expect(port.setTurnOptions).toHaveBeenLastCalledWith("S1", { approvalPolicy: null });
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
      // approval은 known scalar를 줘 이 테스트를 sandbox/mode 배지에 집중시킨다(approval unknown fail-closed는 별도).
      approvalPolicy: "on-request",
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

  it("OQ-16 Task 8: cache hydrate renders cached transcript history immediately on cold restart", async () => {
    const { port } = makeFakePort();
    const cachedSnapshot: TranscriptCacheSnapshot = {
      schemaVersion: 1,
      visibleItemIds: ["cached-1"],
      items: [
        [
          "cached-1",
          {
            type: "message",
            id: "cached-1",
            role: "agent",
            content: [{ type: "text", text: "cached history line" }],
            streaming: false,
            ref: { provider: "codex", threadId: "thread-1" },
          },
        ],
      ],
      turns: [],
    };
    const cachedModel: TranscriptModel = {
      visibleItemIds: ["cached-1"],
      itemVersions: {},
      itemsById: new Map(cachedSnapshot.items),
      turnsById: new Map(),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };
    transcriptCacheMocks.loadTranscriptCache.mockResolvedValue(cachedSnapshot);
    transcriptCacheMocks.deserializeTranscript.mockReturnValue(cachedModel);

    const { findByText } = render(AgentTranscriptSurface, {
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

    // 캐시 히스토리가 provider resume 시작 전에 즉시 read-only로 렌더된다.
    await findByText("cached history line");
    expect(transcriptCacheMocks.loadTranscriptCache).toHaveBeenCalledWith("S1");

    // resume은 그대로 뒤이어 진행된다(이 task는 timing 변경 없음, Task 9 범위).
    await waitFor(() => {
      expect(port.resumeSession).toHaveBeenCalledOnce();
    });
  });

  it("OQ-16 Task 10: authoritative resume replay replaces cached history without duplicating items", async () => {
    const { port, emit } = makeFakePort({ canLoad: true });
    // resume(replay=true) 성공 경로: resumeSession이 캐시와 같은 provider item id로 권위 replay를 emit한다.
    port.resumeSession = vi.fn().mockImplementation(async () => {
      emit({
        type: "agent_message",
        ref: {
          provider: "codex",
          threadId: "thread-1",
          turnId: "replayed-turn",
          itemId: "cached-1",
        },
        content: [{ type: "text", text: "authoritative replay line" }],
        mode: "replace",
      } as AgentEvent);
      return {
        ref: { provider: "codex", threadId: "thread-1", sessionId: "session-tree-1" },
        canResume: true,
        canLoad: true,
      } satisfies SessionStartResult;
    });

    const cachedSnapshot: TranscriptCacheSnapshot = {
      schemaVersion: 1,
      visibleItemIds: ["cached-1"],
      items: [
        [
          "cached-1",
          {
            type: "message",
            id: "cached-1",
            role: "agent",
            content: [{ type: "text", text: "stale cached line" }],
            streaming: false,
            ref: { provider: "codex", threadId: "thread-1" },
          },
        ],
      ],
      turns: [],
    };
    const cachedModel: TranscriptModel = {
      visibleItemIds: ["cached-1"],
      itemVersions: {},
      itemsById: new Map(cachedSnapshot.items),
      turnsById: new Map(),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };
    transcriptCacheMocks.loadTranscriptCache.mockResolvedValue(cachedSnapshot);
    transcriptCacheMocks.deserializeTranscript.mockReturnValue(cachedModel);

    const { findByText, queryAllByText, queryByText } = render(AgentTranscriptSurface, {
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

    // 권위 replay 내용이 렌더되고, discard로 인해 캐시 잔여(stale)는 남지 않는다.
    await findByText("authoritative replay line");
    expect(queryByText("stale cached line")).toBeNull();
    // 같은 item id는 upsert로 dedup되어 정확히 1개만 렌더된다(중복 없음).
    expect(queryAllByText("authoritative replay line")).toHaveLength(1);

    await waitFor(() => {
      expect(port.resumeSession).toHaveBeenCalledOnce();
    });
    expect(port.startSession).not.toHaveBeenCalled();
  });

  it("OQ-16 Task 10: shows a read-only history affordance and keeps cache when resume is unsupported", async () => {
    const { port } = makeFakePort();
    // resume 소스 없음(scrub + 암호화 저장소도 없음) → buildResumeConfig가 undefined.
    resumeStoreMocks.loadResumeKeys.mockResolvedValue(null);

    const cachedSnapshot: TranscriptCacheSnapshot = {
      schemaVersion: 1,
      visibleItemIds: ["cached-1"],
      items: [
        [
          "cached-1",
          {
            type: "message",
            id: "cached-1",
            role: "agent",
            content: [{ type: "text", text: "read-only cached line" }],
            streaming: false,
            ref: { provider: "codex", threadId: "thread-1" },
          },
        ],
      ],
      turns: [],
    };
    const cachedModel: TranscriptModel = {
      visibleItemIds: ["cached-1"],
      itemVersions: {},
      itemsById: new Map(cachedSnapshot.items),
      turnsById: new Map(),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };
    transcriptCacheMocks.loadTranscriptCache.mockResolvedValue(cachedSnapshot);
    transcriptCacheMocks.deserializeTranscript.mockReturnValue(cachedModel);

    const { findByTestId, findByText, queryByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          // scrub되어 provider id 없음 → resume 불가.
          canResume: true,
          canLoad: true,
        },
      }),
    });

    // 캐시 히스토리는 read-only로 유지되고, historyReadOnly affordance notice가 표시된다.
    await findByText("read-only cached line");
    const notice = await findByTestId(TEST_IDS.agentHistoryReadOnlyNotice);
    expect(notice.textContent).toContain("read-only");

    // resume 소스가 없으므로 새 fresh 세션은 진행하되, 캐시를 지우지 않는다.
    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    expect(port.resumeSession).not.toHaveBeenCalled();
    // historyReadOnly가 restoreUnavailable을 대신하므로 복원 불가 notice는 뜨지 않는다.
    expect(queryByTestId(TEST_IDS.agentRestoreUnavailableNotice)).toBeNull();
  });

  it("OQ-16 Task 8: ignores a rejected cache load and still proceeds to resume", async () => {
    const { port } = makeFakePort();
    transcriptCacheMocks.loadTranscriptCache.mockRejectedValue(new Error("disk read error"));

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

    // 캐시 로드 실패가 startRuntime 진행을 막지 않는다(best-effort).
    await waitFor(() => {
      expect(port.resumeSession).toHaveBeenCalledOnce();
    });
  });

  it("OQ-16 Task 9: defers process spawn until the restored tab first becomes visible, then starts exactly once", async () => {
    const { port } = makeFakePort();
    resumeStoreMocks.loadResumeKeys.mockResolvedValue({
      providerThreadId: "thread-1",
      providerSessionId: "session-tree-1",
      canResume: true,
      canLoad: true,
    });
    const coldRestartProps = {
      agentRuntime: {
        sessionRuntimeKind: "direct-codex" as const,
        provider: "codex" as const,
        // cold restart에선 provider id가 scrub된다 — resume 소스는 loadResumeKeys여야 한다.
        canResume: true,
        canLoad: true,
      },
    };
    // 비활성 탭(visible=false)으로 마운트 → boot에서 프로세스를 띄우지 않는다(AppHang 방지).
    const view = render(AgentTranscriptSurface, {
      props: baseProps(port, { ...coldRestartProps, visible: false }),
    });

    // 캐시 hydrate/resume-key 로드는 즉시 하되, 실제 spawn(start/resume)은 아직 없어야 한다.
    await waitFor(() => {
      expect(resumeStoreMocks.loadResumeKeys).toHaveBeenCalledWith("S1");
    });
    await tick();
    await tick();
    expect(port.resumeSession).not.toHaveBeenCalled();
    expect(port.startSession).not.toHaveBeenCalled();

    // 탭이 전경(visible=true)이 되는 순간 정확히 1회 시작한다.
    await view.rerender(baseProps(port, { ...coldRestartProps, visible: true }));

    await waitFor(() => {
      expect(port.resumeSession).toHaveBeenCalledOnce();
    });

    // 이후 visible 재토글(false→true)이 반복돼도 재시작하지 않는다(1회 가드).
    await view.rerender(baseProps(port, { ...coldRestartProps, visible: false }));
    await view.rerender(baseProps(port, { ...coldRestartProps, visible: true }));
    await tick();
    await tick();
    expect(port.resumeSession).toHaveBeenCalledOnce();
    expect(port.startSession).not.toHaveBeenCalled();
  });

  it("OQ-16 Task 9: resumes with encrypted-store ids, not the scrubbed in-memory metadata", async () => {
    const { port } = makeFakePort();
    // 암호화 저장소에서 로드한 id가 resume 소스가 되어야 한다(props.agentRuntime의 scrub id 아님).
    resumeStoreMocks.loadResumeKeys.mockResolvedValue({
      providerThreadId: "stored-thread-9",
      providerSessionId: "stored-session-9",
      canResume: true,
      canLoad: true,
    });
    render(AgentTranscriptSurface, {
      props: baseProps(port, {
        visible: true,
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          // scrub되어 provider id 없음 — resume은 loadResumeKeys 값으로 이뤄져야 한다.
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
        providerSessionId: "stored-session-9",
        providerThreadId: "stored-thread-9",
        replay: true,
        options: undefined,
      });
    });
    expect(port.startSession).not.toHaveBeenCalled();
  });

  it("OQ-16 Task 9: a fresh visible session starts immediately on mount (no deferral)", async () => {
    const { port } = makeFakePort();
    // fresh 세션(agentRuntime 없음)은 생성 시 visible=true라 마운트 즉시 시작된다.
    render(AgentTranscriptSurface, {
      props: baseProps(port, { visible: true }),
    });

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    // fresh는 cold restart 경로가 아니므로 암호화 저장소를 로드하지 않는다.
    expect(resumeStoreMocks.loadResumeKeys).not.toHaveBeenCalled();
    expect(port.resumeSession).not.toHaveBeenCalled();
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

  it("OQ-16 후속: resume(replay) 실패 시 캐시를 read-only 히스토리로 복귀시킨다(부분 replay 잔여 없음)", async () => {
    const { port, emit } = makeFakePort({ canLoad: true });
    port.resumeSession = vi.fn().mockImplementation(async () => {
      // 거부 전에 부분 replay가 live 모드로 흘러든 상황 — 실패 후 잔여가 남으면 안 된다.
      emit({
        type: "agent_message",
        ref: {
          provider: "codex",
          threadId: "thread-1",
          turnId: "partial-turn",
          itemId: "partial-1",
        },
        content: [{ type: "text", text: "partial replay line" }],
        mode: "replace",
      } as AgentEvent);
      throw new Error("thread gone");
    });
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-2", sessionId: "session-tree-2" },
      canResume: true,
      canLoad: true,
    });

    const cachedSnapshot: TranscriptCacheSnapshot = {
      schemaVersion: 1,
      visibleItemIds: ["cached-1"],
      items: [
        [
          "cached-1",
          {
            type: "message",
            id: "cached-1",
            role: "agent",
            content: [{ type: "text", text: "cached history line" }],
            streaming: false,
            ref: { provider: "codex", threadId: "thread-1" },
          },
        ],
      ],
      turns: [],
    };
    const cachedModel: TranscriptModel = {
      visibleItemIds: ["cached-1"],
      itemVersions: {},
      itemsById: new Map(cachedSnapshot.items),
      turnsById: new Map(),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };
    transcriptCacheMocks.loadTranscriptCache.mockResolvedValue(cachedSnapshot);
    transcriptCacheMocks.deserializeTranscript.mockReturnValue(cachedModel);

    const { findByTestId, findByText, queryByTestId, queryByText } = render(
      AgentTranscriptSurface,
      {
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
      },
    );

    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    // 실패한 resume가 지운 캐시가 read-only 히스토리로 복귀하고 affordance notice가 뜬다.
    await findByText("cached history line");
    await findByTestId(TEST_IDS.agentHistoryReadOnlyNotice);
    // 복원 불가 notice는 historyReadOnly와 동시에 서지 않는다.
    expect(queryByTestId(TEST_IDS.agentRestoreUnavailableNotice)).toBeNull();
    // 실패 attempt의 부분 replay item은 재주입된 캐시에 섞이지 않는다.
    expect(queryByText("partial replay line")).toBeNull();
  });

  it("OQ-16 후속: replay 없는 resume 실패 시에도 캐시를 read-only 히스토리로 유지한다", async () => {
    const { port } = makeFakePort();
    port.resumeSession = vi.fn().mockRejectedValue(new Error("thread gone"));
    port.startSession = vi.fn().mockResolvedValue({
      ref: { provider: "codex", threadId: "thread-2", sessionId: "session-tree-2" },
      canResume: true,
      canLoad: false,
    });

    const cachedSnapshot: TranscriptCacheSnapshot = {
      schemaVersion: 1,
      visibleItemIds: ["cached-1"],
      items: [
        [
          "cached-1",
          {
            type: "message",
            id: "cached-1",
            role: "agent",
            content: [{ type: "text", text: "cached history line" }],
            streaming: false,
            ref: { provider: "codex", threadId: "thread-1" },
          },
        ],
      ],
      turns: [],
    };
    const cachedModel: TranscriptModel = {
      visibleItemIds: ["cached-1"],
      itemVersions: {},
      itemsById: new Map(cachedSnapshot.items),
      turnsById: new Map(),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };
    transcriptCacheMocks.loadTranscriptCache.mockResolvedValue(cachedSnapshot);
    transcriptCacheMocks.deserializeTranscript.mockReturnValue(cachedModel);

    const { findByTestId, findByText, queryByTestId } = render(AgentTranscriptSurface, {
      props: baseProps(port, {
        agentRuntime: {
          sessionRuntimeKind: "direct-codex",
          provider: "codex",
          providerSessionId: "session-tree-1",
          providerThreadId: "thread-1",
          canResume: true,
          // canLoad=false → buildResumeConfig가 replay 없는 resume(replay:false)을 만든다.
          canLoad: false,
        },
      }),
    });

    await waitFor(() => {
      expect(port.resumeSession).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(port.startSession).toHaveBeenCalledOnce();
    });
    // dispose가 지웠던 캐시가 read-only 히스토리로 복귀한다(실패 전 화면과 동일).
    await findByText("cached history line");
    await findByTestId(TEST_IDS.agentHistoryReadOnlyNotice);
    expect(queryByTestId(TEST_IDS.agentRestoreUnavailableNotice)).toBeNull();
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
