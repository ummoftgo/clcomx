/**
 * Codex 어댑터 통합 테스트(11 §3 CX-1/CX-2/CX-12..15/CX-17/CX-19 + 05 §10 lifecycle/cancel/shutdown).
 * mock transport(deps)로 process spawn·send·listen·shutdown을 주입하고, inbound message를
 * listener에 주입해 wire→AgentEvent 변환과 outbound wire를 검증한다.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentRuntimeErrorCode } from "../../contracts/normalized";
import type { AgentRuntimeEvent, JsonRpcMessage } from "../../service/transport";
import { AGENT_RUNTIME_EVENTS } from "../../service/transport";
import { createCodexAppServerAdapter, type CodexAdapterDeps } from "./codex-app-server-adapter";

/** mock transport harness. send 캡처 + 자동 응답 + inbound 주입. */
function makeHarness(opts?: { autoRespond?: (msg: JsonRpcMessage) => unknown }) {
  const sent: JsonRpcMessage[] = [];
  // 실제 transport처럼 event 이름별로 listener를 분리(한 message 주입이 한 handler만 부른다).
  const byEvent = new Map<string, Array<(e: { payload: AgentRuntimeEvent }) => void>>();
  const runtimeId = 1;
  let idCounter = 0;

  function fire(eventName: string, payload: AgentRuntimeEvent): void {
    for (const l of byEvent.get(eventName) ?? []) l({ payload });
  }

  // inbound 주입: backend → frontend event(이름별 1개 채널만).
  function inject(message: JsonRpcMessage): void {
    fire(AGENT_RUNTIME_EVENTS.message, { type: "message", runtimeId, message });
  }
  function injectExit(code?: number, signal?: string): void {
    fire(AGENT_RUNTIME_EVENTS.exit, { type: "exit", runtimeId, code, signal });
  }
  function injectError(message: string, recoverable: boolean, code?: AgentRuntimeErrorCode): void {
    fire(AGENT_RUNTIME_EVENTS.error, { type: "error", runtimeId, message, recoverable, code });
  }

  const deps: CodexAdapterDeps = {
    start: async () => runtimeId,
    send: async (_rid, message) => {
      sent.push(message);
      // 자동 응답: 우리가 보낸 request에 result를 주입(handshake/thread/start/turn 등).
      const auto = opts?.autoRespond?.(message);
      if (auto !== undefined && "id" in message && "method" in message) {
        // 다음 tick에 응답 주입(Promise 체인 정상 동작).
        queueMicrotask(() => inject({ id: (message as { id: number }).id, result: auto }));
      }
    },
    cancel: async () => {},
    shutdown: async () => {},
    listenRuntime: async (event, h) => {
      const arr = byEvent.get(event) ?? [];
      arr.push(h);
      byEvent.set(event, arr);
      return () => {
        const cur = byEvent.get(event) ?? [];
        const i = cur.indexOf(h);
        if (i >= 0) cur.splice(i, 1);
      };
    },
    appVersion: "test",
    nextRpcId: () => (idCounter += 1),
  };

  return { deps, sent, inject, injectExit, injectError, runtimeId };
}

/** initialize/thread/start/turn/start/turn/interrupt 자동 응답기. */
function autoResponder(message: JsonRpcMessage): unknown {
  if (!("method" in message)) return undefined;
  const m = message.method;
  if (m === "initialize") return { userAgent: "codex 0.142.0", codexHome: "/h", platformFamily: "unix", platformOs: "linux" };
  if (m === "thread/start") return { thread: { id: "th_1", sessionId: "s1", cwd: "/work", turns: [] } };
  if (m === "thread/resume") return { thread: { id: "th_1", sessionId: "s1", cwd: "/work", turns: [] } };
  if (m === "thread/read")
    return {
      thread: {
        id: "th_1",
        sessionId: "s1",
        cwd: "/work",
        turns: [
          { id: "t0", items: [{ type: "agentMessage", id: "i0", text: "old msg", phase: null, memoryCitation: null }], itemsView: "full", status: "completed" },
        ],
      },
    };
  if (m === "turn/start") return { turn: { id: "t1", status: "inProgress" } };
  if (m === "turn/interrupt") return {};
  if (m === "skills/list") return { data: [] };
  return undefined;
}

async function startReadySession() {
  const h = makeHarness({ autoRespond: autoResponder });
  const adapter = createCodexAppServerAdapter(h.deps);
  const events: AgentEvent[] = [];
  // subscribe AFTER start? we need listener before lifecycle emits; subscribe via separate path.
  // startSession은 listener 등록 전 starting을 deferred 큐에 쌓는다 → subscribe 시 flush.
  await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });
  // 구독은 start 완료 후. 구독 전 emit된 lifecycle 이벤트는 deferred 버퍼에서 flush된다.
  const unlisten = adapter.subscribeEvents("H", (e) => events.push(e));
  return { adapter, events, h, unlisten };
}

describe("startSession lifecycle (CX-1)", () => {
  it("emits starting → session_started → ready; handshake sends initialize+initialized; thread/start", async () => {
    const { events, h } = await startReadySession();
    const types = events.map((e) => e.type);
    expect(types).toContain("session_status_changed");
    expect(types).toContain("session_started");
    const started = events.find((e) => e.type === "session_started") as Extract<AgentEvent, { type: "session_started" }>;
    expect(started.ref).toMatchObject({ threadId: "th_1", sessionId: "s1" });
    expect(started.cwd).toBe("/work");
    // 마지막 status는 ready
    const statuses = events.filter((e) => e.type === "session_status_changed") as Array<Extract<AgentEvent, { type: "session_status_changed" }>>;
    expect(statuses[0].status).toBe("starting");
    expect(statuses[statuses.length - 1].status).toBe("ready");

    // outbound: initialize(req), initialized(notif), thread/start(req)
    const methods = h.sent.filter((m) => "method" in m).map((m) => (m as { method: string }).method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start"]);
    // Codex envelope: jsonrpc 필드 없음
    for (const m of h.sent) expect((m as { jsonrpc?: string }).jsonrpc).toBeUndefined();
  });

  it("thread/started notification after response is idempotent (no duplicate session_started)", async () => {
    const { events, h } = await startReadySession();
    const before = events.filter((e) => e.type === "session_started").length;
    h.inject({ method: "thread/started", params: { thread: { id: "th_1", sessionId: "s1", cwd: "/work" } } });
    const after = events.filter((e) => e.type === "session_started").length;
    expect(after).toBe(before); // 멱등(response 권위)
  });

  it("returns Codex sandbox and approval policy metadata from thread/start", async () => {
    const h = makeHarness({
      autoRespond: (message) => {
        if (!("method" in message)) return undefined;
        if (message.method === "thread/start") {
          return {
            thread: { id: "th_1", sessionId: "s1", cwd: "/work", turns: [] },
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: "workspace-write",
          };
        }
        return autoResponder(message);
      },
    });
    const adapter = createCodexAppServerAdapter(h.deps);

    const result = await adapter.startSession({
      sessionHandle: "H",
      provider: "codex",
      distro: "Ubuntu",
      workDir: "/work",
    });

    expect(result).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  });
});

describe("resumeSession replay (CX-2)", () => {
  it("returns Codex sandbox and approval policy metadata from thread/resume", async () => {
    const h = makeHarness({
      autoRespond: (message) => {
        if (!("method" in message)) return undefined;
        if (message.method === "thread/resume") {
          return {
            thread: { id: "th_1", sessionId: "s1", cwd: "/work", turns: [] },
            approvalPolicy: "on-failure",
            approvalsReviewer: "user",
            sandbox: { type: "readOnly" },
          };
        }
        return autoResponder(message);
      },
    });
    const adapter = createCodexAppServerAdapter(h.deps);

    const result = await adapter.resumeSession({
      sessionHandle: "H",
      provider: "codex",
      distro: "Ubuntu",
      workDir: "/work",
      providerThreadId: "th_1",
      replay: false,
    });

    expect(result).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "on-failure",
      approvalsReviewer: "user",
    });
  });

  it("formats Codex external sandbox policy metadata in kebab-case", async () => {
    const h = makeHarness({
      autoRespond: (message) => {
        if (!("method" in message)) return undefined;
        if (message.method === "thread/resume") {
          return {
            thread: { id: "th_1", sessionId: "s1", cwd: "/work", turns: [] },
            sandbox: { type: "externalSandbox", networkAccess: "restricted" },
          };
        }
        return autoResponder(message);
      },
    });
    const adapter = createCodexAppServerAdapter(h.deps);

    const result = await adapter.resumeSession({
      sessionHandle: "H",
      provider: "codex",
      distro: "Ubuntu",
      workDir: "/work",
      providerThreadId: "th_1",
      replay: false,
    });

    expect(result.sandbox).toBe("external-sandbox");
  });

  it("replay=true → thread/read, session_loaded + replayed item events", async () => {
    const h = makeHarness({ autoRespond: autoResponder });
    const adapter = createCodexAppServerAdapter(h.deps);
    const events: AgentEvent[] = [];
    await adapter.resumeSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work", providerThreadId: "th_1", replay: true });
    adapter.subscribeEvents("H", (e) => events.push(e));
    const types = events.map((e) => e.type);
    expect(types).toContain("session_loaded");
    // replayed agentMessage completed → agent_message replace
    const replayed = events.find((e) => e.type === "agent_message") as Extract<AgentEvent, { type: "agent_message" }>;
    expect(replayed.content).toEqual([{ type: "text", text: "old msg" }]);
    const methods = h.sent.filter((m) => "method" in m).map((m) => (m as { method: string }).method);
    expect(methods).toContain("thread/read");
    const read = h.sent.find((m) => "method" in m && m.method === "thread/read") as
      | { params: { threadId: string; includeTurns?: boolean } }
      | undefined;
    expect(read?.params).toEqual({ threadId: "th_1", includeTurns: true });
  });
});

describe("sendPrompt (turn/start outbound)", () => {
  it("OQ-20: sends turn/start with stable threadId/input only, emits running", async () => {
    const { adapter, events, h } = await startReadySession();
    h.sent.length = 0;
    events.length = 0;
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "hi" }] });
    const turnStart = h.sent.find((m) => "method" in m && (m as { method: string }).method === "turn/start") as { params: { threadId: string; input: unknown[] } };
    expect(turnStart.params).toEqual({
      threadId: "th_1",
      input: [{ type: "text", text: "hi", text_elements: [] }],
    });
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "running")).toBe(true);
  });

  it("②-B: turn/start에 설정된 model/effort override를 실어 보낸다", async () => {
    const { adapter, h } = await startReadySession();
    h.sent.length = 0;
    adapter.setTurnOptions!("H", { model: "gpt-x", effort: "high" });
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "hi" }] });
    const turnStart = h.sent.find(
      (m) => "method" in m && (m as { method: string }).method === "turn/start",
    ) as { params: { threadId: string; input: unknown[]; model?: string; effort?: string } };
    expect(turnStart.params).toMatchObject({ threadId: "th_1", model: "gpt-x", effort: "high" });
  });

  it("②-B: override 미설정이면 turn/start에 model/effort를 넣지 않는다(OQ-20 기존 동작)", async () => {
    const { adapter, h } = await startReadySession();
    h.sent.length = 0;
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "hi" }] });
    const turnStart = h.sent.find(
      (m) => "method" in m && (m as { method: string }).method === "turn/start",
    ) as { params: Record<string, unknown> };
    expect(turnStart.params).not.toHaveProperty("model");
    expect(turnStart.params).not.toHaveProperty("effort");
  });

  it("②-B: setTurnOptions null은 turn/start에 명시적 null을 실어 override를 revert한다", async () => {
    const { adapter, h } = await startReadySession();
    adapter.setTurnOptions!("H", { model: "gpt-x", effort: "high" });
    adapter.setTurnOptions!("H", { model: null });
    h.sent.length = 0;
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "hi" }] });
    const turnStart = h.sent.find(
      (m) => "method" in m && (m as { method: string }).method === "turn/start",
    ) as { params: Record<string, unknown> };
    // null clear는 wire로 전달돼야 provider override가 revert된다(누수 방지).
    expect(turnStart.params).toHaveProperty("model", null);
    expect(turnStart.params).toMatchObject({ effort: "high" }); // effort는 유지.
  });

  it("②-C: turn/start에 설정된 approvalPolicy override(never)를 실어 보낸다", async () => {
    const { adapter, h } = await startReadySession();
    h.sent.length = 0;
    adapter.setTurnOptions!("H", { approvalPolicy: "never" });
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "hi" }] });
    const turnStart = h.sent.find(
      (m) => "method" in m && (m as { method: string }).method === "turn/start",
    ) as { params: { threadId: string; approvalPolicy?: string } };
    expect(turnStart.params).toMatchObject({ threadId: "th_1", approvalPolicy: "never" });
  });

  it("②-C: approvalPolicy 미설정이면 turn/start에 approvalPolicy를 넣지 않는다", async () => {
    const { adapter, h } = await startReadySession();
    h.sent.length = 0;
    adapter.setTurnOptions!("H", { model: "gpt-x" });
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "hi" }] });
    const turnStart = h.sent.find(
      (m) => "method" in m && (m as { method: string }).method === "turn/start",
    ) as { params: Record<string, unknown> };
    expect(turnStart.params).not.toHaveProperty("approvalPolicy");
  });

  it("②-C: setTurnOptions null은 approvalPolicy override를 명시적으로 revert한다", async () => {
    const { adapter, h } = await startReadySession();
    adapter.setTurnOptions!("H", { approvalPolicy: "never" });
    adapter.setTurnOptions!("H", { approvalPolicy: null });
    h.sent.length = 0;
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "hi" }] });
    const turnStart = h.sent.find(
      (m) => "method" in m && (m as { method: string }).method === "turn/start",
    ) as { params: Record<string, unknown> };
    expect(turnStart.params).toHaveProperty("approvalPolicy", null);
  });

  it("②-C: model/effort/approvalPolicy 부분 업데이트는 서로 clobber하지 않는다", async () => {
    const { adapter, h } = await startReadySession();
    // 각각 다른 호출로 설정 — 하나를 갱신해도 나머지는 유지돼야 한다.
    adapter.setTurnOptions!("H", { model: "gpt-x" });
    adapter.setTurnOptions!("H", { effort: "high" });
    adapter.setTurnOptions!("H", { approvalPolicy: "on-request" });
    adapter.setTurnOptions!("H", { model: "gpt-y" }); // model만 갱신.
    h.sent.length = 0;
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "hi" }] });
    const turnStart = h.sent.find(
      (m) => "method" in m && (m as { method: string }).method === "turn/start",
    ) as { params: Record<string, unknown> };
    expect(turnStart.params).toMatchObject({
      model: "gpt-y",
      effort: "high",
      approvalPolicy: "on-request",
    });
  });

  it("②-B: listModels가 model/list를 정규화하고 hidden 모델을 제외한다", async () => {
    const h = makeHarness({
      autoRespond: (m) => {
        if ("method" in m && m.method === "model/list") {
          return {
            data: [
              {
                id: "gpt-a",
                model: "gpt-a",
                displayName: "GPT A",
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "빠름" },
                  { reasoningEffort: "high", description: "정밀" },
                ],
                defaultReasoningEffort: "low",
              },
              { id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden", hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: "low" },
            ],
            nextCursor: null,
          };
        }
        return autoResponder(m);
      },
    });
    const adapter = createCodexAppServerAdapter(h.deps);
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });

    const models = await adapter.listModels!("H");
    expect(models).toEqual([
      {
        id: "gpt-a",
        label: "GPT A",
        efforts: [
          { id: "low", description: "빠름" },
          { id: "high", description: "정밀" },
        ],
        defaultEffort: "low",
      },
    ]);
  });

  it("②-B: thread/start 응답의 실제 model/effort를 SessionStartResult로 전달한다", async () => {
    const h = makeHarness({
      autoRespond: (m) => {
        if ("method" in m && m.method === "thread/start") {
          return {
            thread: { id: "th_1", sessionId: "s1", cwd: "/work", turns: [] },
            model: "gpt-actual",
            reasoningEffort: "high",
          };
        }
        return autoResponder(m);
      },
    });
    const adapter = createCodexAppServerAdapter(h.deps);
    const result = await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });
    expect(result).toMatchObject({ model: "gpt-actual", effort: "high" });
  });

  it("②-B: listModels가 nextCursor를 따라 모든 페이지를 수집해 뒤 페이지 isDefault도 본다", async () => {
    const page1 = {
      data: [{ id: "gpt-a", model: "gpt-a", displayName: "GPT A", hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: "low" }],
      nextCursor: "cur-2",
    };
    const page2 = {
      data: [{ id: "gpt-default", model: "gpt-default", displayName: "GPT Default", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" }],
      nextCursor: null,
    };
    const h = makeHarness({
      autoRespond: (m) => {
        if ("method" in m && m.method === "model/list") {
          const cursor = (m as { params?: { cursor?: string } }).params?.cursor;
          return cursor === "cur-2" ? page2 : page1;
        }
        return autoResponder(m);
      },
    });
    const adapter = createCodexAppServerAdapter(h.deps);
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });

    const models = await adapter.listModels!("H");
    expect(models.map((mm) => mm.id)).toEqual(["gpt-a", "gpt-default"]);
    expect(models.find((mm) => mm.isDefault)?.id).toBe("gpt-default");
    // model/list가 두 번(페이지 1, 2) 호출됐다.
    expect(h.sent.filter((m) => "method" in m && (m as { method: string }).method === "model/list").length).toBe(2);
  });

  it("CX-4c: does not send turn/start when all prompt content is unsupported", async () => {
    const { adapter, events, h } = await startReadySession();
    h.sent.length = 0;
    events.length = 0;

    await adapter.sendPrompt("H", {
      content: [{ type: "image", uri: "https://example.test/image.png", mimeType: "image/png" }],
    });

    expect(h.sent.some((m) => "method" in m && m.method === "turn/start")).toBe(false);
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "running")).toBe(false);
    expect(events).toContainEqual({
      type: "error",
      ref: { provider: "codex", threadId: "th_1" },
      message: "prompt content is not supported by this Codex session",
      recoverable: true,
    });
  });

  it("H3: turn/start error → error event + status restored to ready, no active turn", async () => {
    const h = makeHarness({
      autoRespond: (m) => {
        if (!("method" in m)) return undefined;
        if (m.method === "turn/start") return undefined; // handled below by error injection
        return autoResponder(m);
      },
    });
    // turn/start에 error 응답을 주입하도록 send 래핑
    const realSend = h.deps.send;
    h.deps.send = async (rid, message) => {
      await realSend(rid, message);
      if ("method" in message && message.method === "turn/start") {
        queueMicrotask(() => h.inject({ id: (message as { id: number }).id, error: { code: -32000, message: "turn failed" } }));
      }
    };
    const adapter = createCodexAppServerAdapter(h.deps);
    const events: AgentEvent[] = [];
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "U", workDir: "/work" });
    adapter.subscribeEvents("H", (e) => events.push(e));
    events.length = 0;
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "x" }] });
    expect(events.some((e) => e.type === "error" && e.message === "turn failed")).toBe(true);
    const lastStatus = events.filter((e) => e.type === "session_status_changed").pop() as Extract<AgentEvent, { type: "session_status_changed" }>;
    expect(lastStatus.status).toBe("ready");
  });
});

describe("provider-backed resource search (OQ-56)", () => {
  it("maps Codex fuzzyFileSearch results to file resource suggestions", async () => {
    const h = makeHarness({
      autoRespond: (message) => {
        if (!("method" in message)) return undefined;
        if (message.method === "fuzzyFileSearch") {
          return {
            files: [
              {
                root: "/work",
                path: "src/App.svelte",
                match_type: "file",
                file_name: "App.svelte",
                score: 42,
                indices: [4, 5, 6],
              },
              {
                root: "/work",
                path: "My Dir/app#main?.svelte",
                match_type: "file",
                file_name: "app#main?.svelte",
                score: 38,
                indices: null,
              },
            ],
          };
        }
        return autoResponder(message);
      },
    });
    const adapter = createCodexAppServerAdapter(h.deps);
    await adapter.startSession({
      sessionHandle: "H",
      provider: "codex",
      distro: "Ubuntu",
      workDir: "/work",
    });
    h.sent.length = 0;

    const results = await adapter.searchResources!("H", {
      query: "app",
      workDir: "/work",
      limit: 2,
    });

    const search = h.sent.find((m) => "method" in m && m.method === "fuzzyFileSearch") as
      | { params: { query: string; roots: string[]; cancellationToken: string | null } }
      | undefined;
    expect(search?.params).toEqual({
      query: "app",
      roots: ["/work"],
      cancellationToken: null,
    });
    expect(results).toEqual([
      {
        label: "src/App.svelte",
        uri: "file:///work/src/App.svelte",
        detail: "/work/src/App.svelte",
      },
      {
        label: "My Dir/app#main?.svelte",
        uri: "file:///work/My%20Dir/app%23main%3F.svelte",
        detail: "/work/My Dir/app#main?.svelte",
      },
    ]);
  });

  it("maps Codex skills/list results to skill resource suggestions", async () => {
    const h = makeHarness({
      autoRespond: (message) => {
        if (!("method" in message)) return undefined;
        if (message.method === "fuzzyFileSearch") {
          return { files: [] };
        }
        if (message.method === "skills/list") {
          return {
            data: [
              {
                cwd: "/work",
                skills: [
                  {
                    name: "review",
                    description: "Review changes before merge",
                    shortDescription: "Review changes",
                    interface: null,
                    path: "/home/tester/.codex/skills/review/SKILL.md",
                    scope: "user",
                    enabled: true,
                  },
                  {
                    name: "disabled-review",
                    description: "Disabled",
                    shortDescription: null,
                    interface: null,
                    path: "/home/tester/.codex/skills/disabled/SKILL.md",
                    scope: "user",
                    enabled: false,
                  },
                ],
                errors: [],
              },
            ],
          };
        }
        return autoResponder(message);
      },
    });
    const adapter = createCodexAppServerAdapter(h.deps);
    await adapter.startSession({
      sessionHandle: "H",
      provider: "codex",
      distro: "Ubuntu",
      workDir: "/work",
    });
    h.sent.length = 0;

    const results = await adapter.searchResources!("H", {
      query: "review",
      workDir: "/work",
      limit: 8,
    });

    const skillsList = h.sent.find((m) => "method" in m && m.method === "skills/list") as
      | { params: { cwds?: string[]; forceReload?: boolean } }
      | undefined;
    expect(skillsList?.params).toEqual({ cwds: ["/work"] });
    expect(results).toEqual([
      {
        label: "review",
        uri: "file:///home/tester/.codex/skills/review/SKILL.md",
        detail: "Review changes",
        mimeType: "application/vnd.codex.skill",
        text: "review",
        resourceKind: "skill",
      },
    ]);
  });
});

describe("approval roundtrip (CX-12/CX-13/CX-14)", () => {
  it("approval_requested → respondApproval(allow_once) → outbound {id:7,result:{decision:accept}} no jsonrpc", async () => {
    const { adapter, events, h } = await startReadySession();
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });
    const req = events.find((e) => e.type === "approval_requested") as Extract<AgentEvent, { type: "approval_requested" }>;
    expect(req.request.id).toBe("7");
    h.sent.length = 0;
    await adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" });
    expect(h.sent[0]).toEqual({ id: 7, result: { decision: "accept" } });
    expect((h.sent[0] as { jsonrpc?: string }).jsonrpc).toBeUndefined();
    expect(events.some((e) => e.type === "approval_resolved")).toBe(true);
  });

  it("NM-20: respondApproval(failed)는 provider wire로 전송하지 않는다", async () => {
    const { adapter, h } = await startReadySession();
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });
    h.sent.length = 0;

    await adapter.respondApproval("H", { requestId: "7", outcome: "failed" });

    expect(h.sent).toEqual([]);
  });

  it("SEC-APPROVAL: unknown optionId is rejected before provider wire", async () => {
    const { adapter, h } = await startReadySession();
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });
    h.sent.length = 0;

    await expect(
      adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "not-shown" }),
    ).rejects.toThrow("unknown approval optionId");

    expect(h.sent).toEqual([]);

    await adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" });
    expect(h.sent[0]).toEqual({ id: 7, result: { decision: "accept" } });
  });

  it("CX-13: allow_always → acceptForSession; CX-14: reject_always → decline", async () => {
    const { adapter, h } = await startReadySession();
    h.inject({ id: 8, method: "item/fileChange/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "f1", startedAtMs: 1 } });
    h.sent.length = 0;
    await adapter.respondApproval("H", { requestId: "8", outcome: "selected", optionId: "allow_always" });
    expect(h.sent[0]).toEqual({ id: 8, result: { decision: "acceptForSession" } });

    h.inject({ id: 9, method: "item/fileChange/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "f2", startedAtMs: 1 } });
    h.sent.length = 0;
    await adapter.respondApproval("H", { requestId: "9", outcome: "selected", optionId: "reject_always" });
    expect(h.sent[0]).toEqual({ id: 9, result: { decision: "decline" } });
  });

  it("CX-15b: unsupported server request → outbound JSON-RPC error(-32601) with same id", async () => {
    const { events, h } = await startReadySession();
    h.sent.length = 0;
    h.inject({ id: 42, method: "mcpServer/elicitation/request", params: { foo: 1 } });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ id: 42, error: { code: -32601 } });
    // no approval event
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
  });

  it.each([
    ["item/tool/call", { threadId: "th_1", turnId: "t1", callId: "call-1", namespace: null, tool: "write", arguments: { path: "/tmp/x" } }],
    ["applyPatchApproval", { callId: "patch-1", fileChanges: {} }],
    ["execCommandApproval", { command: "rm -rf build" }],
  ])(
    "SEC-CLIENT-TOOLS: unsupported side-effect server request %s returns method-not-found without approval UI",
    async (method, params) => {
      const { events, h } = await startReadySession();
      h.sent.length = 0;
      events.length = 0;

      h.inject({ id: 77, method, params });

      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatchObject({
        id: 77,
        error: { code: -32601, message: "method not found", data: { method } },
      });
      expect(events).toEqual([]);
    },
  );

  it("permissions request → auto-decline reply {permissions:{},scope:turn} (D12)", async () => {
    const { h } = await startReadySession();
    h.sent.length = 0;
    h.inject({ id: 11, method: "item/permissions/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "p1", startedAtMs: 1, cwd: "/work", reason: null, permissions: {} } });
    expect(h.sent[0]).toEqual({ id: 11, result: { permissions: {}, scope: "turn" } });
  });

  it("New-F1: wire send 실패 시 pending 유지(재시도 가능), 재시도 성공 시 닫힘 + approval_resolved(turnId 보존)", async () => {
    let failApprovalSend = false;
    const byEvent = new Map<string, Array<(e: { payload: AgentRuntimeEvent }) => void>>();
    const runtimeId = 1;
    let idCounter = 0;
    const fire = (name: string, payload: AgentRuntimeEvent) => {
      for (const l of byEvent.get(name) ?? []) l({ payload });
    };
    const inject = (message: JsonRpcMessage) => fire(AGENT_RUNTIME_EVENTS.message, { type: "message", runtimeId, message });
    const deps: CodexAdapterDeps = {
      start: async () => runtimeId,
      send: async (_rid, message) => {
        // approval 응답({id:7,result})만 실패 토글로 막는다. startup 요청/알림은 통과.
        if (failApprovalSend && "result" in (message as object) && (message as { id?: unknown }).id === 7) {
          throw new Error("send failed");
        }
        const auto = autoResponder(message);
        if (auto !== undefined && "id" in message && "method" in message) {
          queueMicrotask(() => inject({ id: (message as { id: number }).id, result: auto }));
        }
      },
      cancel: async () => {},
      shutdown: async () => {},
      listenRuntime: async (event, h) => {
        const arr = byEvent.get(event) ?? [];
        arr.push(h);
        byEvent.set(event, arr);
        return () => {};
      },
      appVersion: "test",
      nextRpcId: () => (idCounter += 1),
    };
    const adapter = createCodexAppServerAdapter(deps);
    const events: AgentEvent[] = [];
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });
    adapter.subscribeEvents("H", (e) => events.push(e));
    inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });

    // wire 실패 → reject + pending 유지(approval_resolved 미emit).
    failApprovalSend = true;
    await expect(
      adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" }),
    ).rejects.toThrow("send failed");
    expect(events.some((e) => e.type === "approval_resolved")).toBe(false);

    // 재시도 → 성공, pending 닫힘 + approval_resolved(turnId/itemId 보존, store seal 정합).
    failApprovalSend = false;
    await adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" });
    const resolved = events.find((e) => e.type === "approval_resolved") as Extract<AgentEvent, { type: "approval_resolved" }>;
    expect(resolved).toBeTruthy();
    expect(resolved.ref).toMatchObject({ threadId: "th_1", turnId: "t1", itemId: "c1" });
  });

  it("New-F1 race: respondApproval in-flight 중 serverRequest/resolved가 와도 이중 wire/emit 없음", async () => {
    let releaseSend: () => void = () => {};
    const sent: JsonRpcMessage[] = [];
    const byEvent = new Map<string, Array<(e: { payload: AgentRuntimeEvent }) => void>>();
    const runtimeId = 1;
    let idCounter = 0;
    const fire = (name: string, payload: AgentRuntimeEvent) => {
      for (const l of byEvent.get(name) ?? []) l({ payload });
    };
    const inject = (message: JsonRpcMessage) => fire(AGENT_RUNTIME_EVENTS.message, { type: "message", runtimeId, message });
    const isApprovalResponse = (m: JsonRpcMessage) =>
      "result" in (m as object) && (m as { id?: unknown }).id === 7;
    const deps: CodexAdapterDeps = {
      start: async () => runtimeId,
      send: async (_rid, message) => {
        sent.push(message);
        // approval 응답({id:7,result})은 releaseSend 호출 전까지 in-flight로 대기시킨다.
        if (isApprovalResponse(message)) {
          await new Promise<void>((r) => {
            releaseSend = r;
          });
          return;
        }
        const auto = autoResponder(message);
        if (auto !== undefined && "id" in message && "method" in message) {
          queueMicrotask(() => inject({ id: (message as { id: number }).id, result: auto }));
        }
      },
      cancel: async () => {},
      shutdown: async () => {},
      listenRuntime: async (event, h) => {
        const arr = byEvent.get(event) ?? [];
        arr.push(h);
        byEvent.set(event, arr);
        return () => {};
      },
      appVersion: "test",
      nextRpcId: () => (idCounter += 1),
    };
    const adapter = createCodexAppServerAdapter(deps);
    const events: AgentEvent[] = [];
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });
    adapter.subscribeEvents("H", (e) => events.push(e));
    inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });

    // respondApproval 시작(claimForResponse → send in-flight). microtask yield로 send 진입 보장.
    const p = adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" });
    await Promise.resolve();
    await Promise.resolve();

    // in-flight 중 serverRequest/resolved 도착 → "responding"이라 skip(닫지 않음, emit 없음).
    inject({ method: "serverRequest/resolved", params: { threadId: "th_1", requestId: 7 } });
    expect(events.filter((e) => e.type === "approval_resolved")).toHaveLength(0);

    // send 완료 → respondApproval가 단일 경로로 닫는다.
    releaseSend();
    await p;
    const resolved = events.filter((e) => e.type === "approval_resolved");
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as Extract<AgentEvent, { type: "approval_resolved" }>).decision.outcome).toBe("selected");
    // approval wire 응답은 selected(accept) 1건만 — cancel 중복 없음.
    const approvalWires = sent.filter(isApprovalResponse);
    expect(approvalWires).toHaveLength(1);
    expect(approvalWires[0]).toMatchObject({ id: 7, result: { decision: "accept" } });
  });

  it("New-F1 race: respondApproval in-flight 중 shutdown이 와도 approval wire는 accept 1건만(cancel 중복 없음)", async () => {
    let releaseSend: () => void = () => {};
    const sent: JsonRpcMessage[] = [];
    const byEvent = new Map<string, Array<(e: { payload: AgentRuntimeEvent }) => void>>();
    const runtimeId = 1;
    let idCounter = 0;
    const fire = (name: string, payload: AgentRuntimeEvent) => {
      for (const l of byEvent.get(name) ?? []) l({ payload });
    };
    const inject = (message: JsonRpcMessage) => fire(AGENT_RUNTIME_EVENTS.message, { type: "message", runtimeId, message });
    const isApprovalWire = (m: JsonRpcMessage) =>
      "result" in (m as object) && (m as { id?: unknown }).id === 7;
    const deps: CodexAdapterDeps = {
      start: async () => runtimeId,
      send: async (_rid, message) => {
        sent.push(message);
        if (isApprovalWire(message)) {
          await new Promise<void>((r) => {
            releaseSend = r;
          });
          return;
        }
        const auto = autoResponder(message);
        if (auto !== undefined && "id" in message && "method" in message) {
          queueMicrotask(() => inject({ id: (message as { id: number }).id, result: auto }));
        }
      },
      cancel: async () => {},
      shutdown: async () => {},
      listenRuntime: async (event, h) => {
        const arr = byEvent.get(event) ?? [];
        arr.push(h);
        byEvent.set(event, arr);
        return () => {};
      },
      appVersion: "test",
      nextRpcId: () => (idCounter += 1),
    };
    const adapter = createCodexAppServerAdapter(deps);
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });
    adapter.subscribeEvents("H", () => {});
    inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });

    // respondApproval 시작(claimForResponse → send in-flight).
    const p = adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" });
    await Promise.resolve();
    await Promise.resolve();

    // in-flight 중 shutdown → closePending이 responding(7)을 건너뛴다(cancel wire 미전송).
    const shutdownP = adapter.shutdown("H");
    releaseSend();
    await p;
    await shutdownP;

    const approvalWires = sent.filter(isApprovalWire);
    expect(approvalWires).toHaveLength(1);
    expect(approvalWires[0]).toMatchObject({ id: 7, result: { decision: "accept" } });
  });

  it("New-F1: teardown 중 respondApproval send 실패(stdin closed) 시 approval_resolved{failed} emit·throw 없음", async () => {
    let rejectSend: () => void = () => {};
    const byEvent = new Map<string, Array<(e: { payload: AgentRuntimeEvent }) => void>>();
    const runtimeId = 1;
    let idCounter = 0;
    const fire = (name: string, payload: AgentRuntimeEvent) => {
      for (const l of byEvent.get(name) ?? []) l({ payload });
    };
    const inject = (message: JsonRpcMessage) => fire(AGENT_RUNTIME_EVENTS.message, { type: "message", runtimeId, message });
    const isApprovalWire = (m: JsonRpcMessage) =>
      "result" in (m as object) && (m as { id?: unknown }).id === 7;
    const deps: CodexAdapterDeps = {
      start: async () => runtimeId,
      send: async (_rid, message) => {
        if (isApprovalWire(message)) {
          // approval 응답 send를 teardown까지 hang시켰다가 reject(stdin closed 모사).
          await new Promise<void>((_resolve, reject) => {
            rejectSend = () => reject(new Error("stdin closed"));
          });
          return;
        }
        const auto = autoResponder(message);
        if (auto !== undefined && "id" in message && "method" in message) {
          queueMicrotask(() => inject({ id: (message as { id: number }).id, result: auto }));
        }
      },
      cancel: async () => {},
      shutdown: async () => {},
      listenRuntime: async (event, h) => {
        const arr = byEvent.get(event) ?? [];
        arr.push(h);
        byEvent.set(event, arr);
        return () => {};
      },
      appVersion: "test",
      nextRpcId: () => (idCounter += 1),
    };
    const adapter = createCodexAppServerAdapter(deps);
    const events: AgentEvent[] = [];
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });
    adapter.subscribeEvents("H", (e) => events.push(e));
    inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });

    const p = adapter.respondApproval("H", { requestId: "7", outcome: "selected", optionId: "allow_once" });
    await Promise.resolve();
    await Promise.resolve();

    // teardown 시작(rt.closed=true, closePending이 responding 7을 건너뜀).
    const shutdownP = adapter.shutdown("H");
    // stdin closed → approval send reject.
    rejectSend();

    // respondApproval은 throw하지 않고 resolve(unhandled rejection 방지).
    await expect(p).resolves.toBeUndefined();
    await shutdownP;

    // 종료 이벤트 누락 없음: approval_resolved{failed} 1건 emit.
    const resolved = events.filter((e) => e.type === "approval_resolved");
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as Extract<AgentEvent, { type: "approval_resolved" }>).decision.outcome).toBe("failed");
  });

  it("New-F1: shutdown await 중 agent-runtime-exit가 와도 process_exited를 1회 emit(closed 과부하 회귀 방지)", async () => {
    let releaseShutdown: () => void = () => {};
    const byEvent = new Map<string, Array<(e: { payload: AgentRuntimeEvent }) => void>>();
    const runtimeId = 1;
    let idCounter = 0;
    const fire = (name: string, payload: AgentRuntimeEvent) => {
      for (const l of byEvent.get(name) ?? []) l({ payload });
    };
    const inject = (message: JsonRpcMessage) => fire(AGENT_RUNTIME_EVENTS.message, { type: "message", runtimeId, message });
    const deps: CodexAdapterDeps = {
      start: async () => runtimeId,
      send: async (_rid, message) => {
        const auto = autoResponder(message);
        if (auto !== undefined && "id" in message && "method" in message) {
          queueMicrotask(() => inject({ id: (message as { id: number }).id, result: auto }));
        }
      },
      cancel: async () => {},
      // shutdown await를 hang시켜 그 사이 backend exit를 주입한다.
      shutdown: async () => {
        await new Promise<void>((r) => {
          releaseShutdown = r;
        });
      },
      listenRuntime: async (event, h) => {
        const arr = byEvent.get(event) ?? [];
        arr.push(h);
        byEvent.set(event, arr);
        return () => {};
      },
      appVersion: "test",
      nextRpcId: () => (idCounter += 1),
    };
    const adapter = createCodexAppServerAdapter(deps);
    const events: AgentEvent[] = [];
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "Ubuntu", workDir: "/work" });
    adapter.subscribeEvents("H", (e) => events.push(e));

    // shutdown 시작(tearingDown=true, closed는 아직 false) → deps.shutdown await에서 hang.
    const shutdownP = adapter.shutdown("H");
    await Promise.resolve();
    // shutdown await 중 backend exit 도착 → handleExit가 process_exited를 emit해야 한다(억제 금지).
    fire(AGENT_RUNTIME_EVENTS.exit, { type: "exit", runtimeId, code: 0 });
    releaseShutdown();
    await shutdownP;

    expect(events.filter((e) => e.type === "process_exited")).toHaveLength(1);
  });
});

describe("cancel cleanup (CX approval cancel)", () => {
  it("cancelTurn closes pending approval with decision:cancel BEFORE turn/interrupt", async () => {
    const { adapter, events, h } = await startReadySession();
    // 활성 turn 만들기
    await adapter.sendPrompt("H", { content: [{ type: "text", text: "go" }] });
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });
    h.sent.length = 0;
    events.length = 0;
    await adapter.cancelTurn("H");
    // 순서: approval cancelled 응답 먼저 → turn/interrupt
    const cancelResp = h.sent.find((m) => "result" in m) as { id: number; result: { decision: string } };
    expect(cancelResp).toEqual({ id: 7, result: { decision: "cancel" } });
    const interruptIdx = h.sent.findIndex((m) => "method" in m && (m as { method: string }).method === "turn/interrupt");
    const respIdx = h.sent.findIndex((m) => "result" in m);
    expect(respIdx).toBeLessThan(interruptIdx); // approval 응답이 interrupt보다 먼저
    const resolved = events.find((e) => e.type === "approval_resolved" && e.decision.outcome === "cancelled");
    expect(resolved).toMatchObject({ decidedBy: "cleanup" });
  });
});

describe("process exit (CX-19)", () => {
  it("exit preserves the started thread/session ref on process_exited", async () => {
    const { events, h } = await startReadySession();
    events.length = 0;

    h.injectExit(1, undefined);

    const exited = events.find((e) => e.type === "process_exited") as
      | Extract<AgentEvent, { type: "process_exited" }>
      | undefined;
    expect(exited?.ref).toMatchObject({ provider: "codex", threadId: "th_1", sessionId: "s1" });
  });

  it("exit closes all pending approval(failed) + rejects pending RPC + process_exited", async () => {
    const { events, h } = await startReadySession();
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });
    events.length = 0;
    h.injectExit(0, undefined);
    const resolved = events.find((e) => e.type === "approval_resolved" && e.decision.outcome === "failed");
    expect(resolved).toMatchObject({ decidedBy: "cleanup" });
    expect(events.some((e) => e.type === "process_exited")).toBe(true);
    // 멱등: 다시 exit → 추가 emit 없음
    events.length = 0;
    h.injectExit(0, undefined);
    expect(events).toHaveLength(0);
  });

  it("runtime error event → error AgentEvent", async () => {
    const { events, h } = await startReadySession();
    events.length = 0;
    h.injectError("boom", false, "framing_broken");
    const error = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(error).toMatchObject({ message: "boom", recoverable: false, code: "framing_broken" });
    expect(error?.ref).toMatchObject({ provider: "codex", threadId: "th_1", sessionId: "s1" });
  });
});

describe("shutdown boundary (S3)", () => {
  it("shutdown closes pending approval/RPC BEFORE backend shutdown + unlisten; idempotent on late exit", async () => {
    const order: string[] = [];
    const h = makeHarness({
      autoRespond: (message) => {
        if ("method" in message && message.method === "turn/start") return undefined;
        return autoResponder(message);
      },
    });
    const realSend = h.deps.send;
    h.deps.send = async (rid, message) => {
      if ("result" in message && (message as { result: { decision?: string } }).result.decision === "cancel") {
        order.push("approval-cancelled");
      }
      await realSend(rid, message);
    };
    const realShutdown = h.deps.shutdown;
    let releaseShutdown: () => void = () => {};
    h.deps.shutdown = async (rid) => {
      order.push("backend-shutdown");
      await new Promise<void>((resolve) => {
        releaseShutdown = resolve;
      });
      await realShutdown(rid);
    };
    const adapter = createCodexAppServerAdapter(h.deps);
    const events: AgentEvent[] = [];
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "U", workDir: "/work" });
    adapter.subscribeEvents("H", (e) => events.push(e));
    const promptPromise = adapter.sendPrompt("H", { content: [{ type: "text", text: "pending RPC" }] });
    const promptSettled = expect(promptPromise).resolves.toBeUndefined();
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });
    h.sent.length = 0;
    events.length = 0;
    const shutdownPromise = adapter.shutdown("H");
    for (let i = 0; i < 10 && !order.includes("backend-shutdown"); i += 1) {
      await Promise.resolve();
    }

    // (a) pending approval cancelled wire response BEFORE backend-shutdown
    const cancelRespIdx = h.sent.findIndex((m) => "result" in m && (m as { result: { decision?: string } }).result.decision === "cancel");
    expect(cancelRespIdx).toBeGreaterThanOrEqual(0);
    const resolved = events.filter((e) => e.type === "approval_resolved" && e.decision.outcome === "cancelled");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ decidedBy: "cleanup" });
    expect(events.some((e) => e.type === "error" && e.message === "shutdown: runtime closing")).toBe(true);
    expect(order).toEqual(["approval-cancelled", "backend-shutdown"]);
    await promptSettled;

    // shutdown await 중 늦은 exit → process_exited는 1회만, pending은 재차 닫지 않음.
    h.injectExit(0);
    expect(events.filter((e) => e.type === "process_exited")).toHaveLength(1);
    expect(events.filter((e) => e.type === "approval_resolved")).toHaveLength(1);
    releaseShutdown();
    await shutdownPromise;

    // (c) late exit after shutdown → idempotent, no re-close
    events.length = 0;
    h.injectExit(0);
    expect(events).toHaveLength(0);
  });

  it("S3: shutdown awaits async pending approval cancel response before backend shutdown", async () => {
    const h = makeHarness({
      autoRespond: (message) => {
        if ("method" in message && message.method === "turn/start") return undefined;
        return autoResponder(message);
      },
    });
    const realSend = h.deps.send;
    let releaseCancelResponse: () => void = () => {};
    let cancelResponseStarted: () => void = () => {};
    const cancelResponseStartedPromise = new Promise<void>((resolve) => {
      cancelResponseStarted = resolve;
    });
    h.deps.send = vi.fn(async (rid, message) => {
      if ("result" in message && (message as { result: { decision?: string } }).result.decision === "cancel") {
        cancelResponseStarted();
        await new Promise<void>((resolve) => {
          releaseCancelResponse = resolve;
        });
      }
      await realSend(rid, message);
    });
    const shutdown = vi.fn(async () => {});
    h.deps.shutdown = shutdown;

    const adapter = createCodexAppServerAdapter(h.deps);
    await adapter.startSession({ sessionHandle: "H", provider: "codex", distro: "U", workDir: "/work" });
    adapter.subscribeEvents("H", () => undefined);
    const promptPromise = adapter.sendPrompt("H", { content: [{ type: "text", text: "pending RPC" }] });
    const promptSettled = expect(promptPromise).resolves.toBeUndefined();
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th_1", turnId: "t1", itemId: "c1", startedAtMs: 1, command: "ls" } });

    const shutdownPromise = adapter.shutdown("H");
    await cancelResponseStartedPromise;
    const shutdownCallsBeforeCancelResponse = shutdown.mock.calls.length;
    releaseCancelResponse();
    await shutdownPromise;
    await promptSettled;

    expect(shutdownCallsBeforeCancelResponse).toBe(0);
    expect(shutdown).toHaveBeenCalledWith(h.runtimeId);
  });
});
