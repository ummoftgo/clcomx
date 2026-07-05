/**
 * Direct Agent Runtime — runtimeKind → AgentRuntimePort 기본 팩토리(03 §3.1).
 *
 * 조립 controller가 주입받는 createPort의 프로덕션 구현이다. runtimeKind로 Codex/Claude adapter를
 * 선택하고 transport(15 §8) 기반 deps를 채워 `AgentRuntimePort`를 만든다.
 *
 * 규약: transport는 service/transport.ts·tauri listen만 경유한다(직접 invoke/@tauri-apps import 금지).
 * 테스트는 이 팩토리 대신 fake port를 controller에 주입한다.
 */

import { listen, type UnlistenFn } from "../../../tauri/event";
import type { AgentRuntimePort } from "../contracts/runtime-port";
import type { SessionRuntimeKind } from "../contracts/metadata";
import type { AgentRuntimeEvent, AgentRuntimeEventName, RuntimeId } from "./transport";
import {
  agentRuntimeSend,
  agentRuntimeCancel,
  agentRuntimeShutdown,
  AGENT_RUNTIME_EVENTS,
  AGENT_RUNTIME_EVENT_NAMES,
} from "./transport";
import {
  createCodexAppServerAdapter,
  defaultCodexAdapterDeps,
} from "../adapters/codex/codex-app-server-adapter";
import { createClaudeAcpAdapter } from "../adapters/claude-acp/claude-acp-adapter";
import type {
  ClaudeAcpAdapterDeps,
  ResolvedLaunch,
} from "../contracts/claude-acp";
import type {
  ResumeSessionParams,
  StartSessionParams,
} from "../contracts/runtime-port";
import {
  agentRuntimeStart,
  agentRuntimeResolveAdapterEntry,
} from "./transport";
import { getSettings } from "../../../stores/settings.svelte";

/** 단조 증가 JSON-RPC id 발급기(세션 간 공유 카운터). */
function makeIdGen(): () => number {
  let n = 0;
  return () => (n += 1);
}

/**
 * Tauri event 채널과 payload type이 일치하는지 확인한다.
 * @param name listen 중인 `agent-runtime-*` event 이름.
 * @param payload backend emit payload.
 */
function eventMatchesChannel(name: AgentRuntimeEventName, payload: AgentRuntimeEvent): boolean {
  switch (name) {
    case AGENT_RUNTIME_EVENTS.message:
      return payload.type === "message";
    case AGENT_RUNTIME_EVENTS.stderr:
      return payload.type === "stderr";
    case AGENT_RUNTIME_EVENTS.exit:
      return payload.type === "exit";
    case AGENT_RUNTIME_EVENTS.error:
      return payload.type === "error";
    case AGENT_RUNTIME_EVENTS.backpressure:
      return payload.type === "backpressure";
  }
}

/**
 * 모든 agent-runtime-* event 채널을 listen하고, payload.runtimeId로 필터해 핸들러로 넘기는
 * subscribeRuntime(Claude deps 형태)을 만든다. 동기 반환 UnlistenFn은 listen 등록 완료를 기다리지 않고
 * 모아둔 뒤 일괄 해제한다.
 */
function makeSubscribeRuntime() {
  return (
    runtimeId: RuntimeId,
    handler: (e: AgentRuntimeEvent) => void,
  ): UnlistenFn => {
    const unlistens: UnlistenFn[] = [];
    let disposed = false;
    for (const name of AGENT_RUNTIME_EVENT_NAMES) {
      void listen<AgentRuntimeEvent>(name, (e) => {
        const p = e.payload;
        if (p.runtimeId === runtimeId && eventMatchesChannel(name, p)) handler(p);
      }).then((un) => {
        if (disposed) un();
        else unlistens.push(un);
      });
    }
    return () => {
      disposed = true;
      for (const un of unlistens) {
        try {
          un();
        } catch {
          // 이미 해제됨 가능 — 무시.
        }
      }
    };
  };
}

/** Codex deps의 listenRuntime(단일 event 채널 listen, 어댑터가 runtimeId 필터). */
function makeListenRuntime() {
  return (
    event: AgentRuntimeEventName,
    h: (e: { payload: AgentRuntimeEvent }) => void,
  ): Promise<UnlistenFn> =>
    listen<AgentRuntimeEvent>(event, (e) => {
      if (eventMatchesChannel(event, e.payload)) h(e);
    });
}

/**
 * Claude resolveLaunch 기본 구현(통합 갭 G1 해소). backend `agent_runtime_resolve_adapter_entry`
 * command로 신뢰 절대경로(`claude-agent-acp` `dist/index.js`)를 resolve해 ResolvedLaunch.adapterEntryPath에
 * 채운다. S1 경계 유지: 절대경로 resolve는 backend가 하고, 실제 start 시 allowlist가 args[0]를 재검증한다.
 * node command(executable)는 backend가 provider로 resolve하므로 여기서 돌려주지 않는다(non-secret env만 전달).
 */
function defaultClaudeResolveLaunch(
  p: StartSessionParams | ResumeSessionParams,
): Promise<ResolvedLaunch> {
  return agentRuntimeResolveAdapterEntry("claude", p.distro).then(
    (adapterEntryPath) => ({
      adapterEntryPath,
      // 구독 인증 opt-in(agentRuntime 설정)은 launch 시점에 읽는다 — 설정 변경은
      // 새로 시작/재개하는 세션부터 적용되고, 떠 있는 세션은 재시작이 필요하다.
      allowSubscriptionAuth: getSettings().agentRuntime.claudeAllowSubscriptionAuth,
    }),
  );
}

/** Claude ACP deps를 transport 기반으로 채운다. */
function defaultClaudeDeps(appVersion: string): ClaudeAcpAdapterDeps {
  const nextRequestId = makeIdGen();
  return {
    startRuntime: agentRuntimeStart,
    sendMessage: agentRuntimeSend,
    cancelRuntime: agentRuntimeCancel,
    shutdownRuntime: agentRuntimeShutdown,
    subscribeRuntime: makeSubscribeRuntime(),
    resolveLaunch: defaultClaudeResolveLaunch,
    nextRequestId,
    appVersion,
    now: () => Date.now(),
  };
}

/** 팩토리 옵션. */
export interface RuntimePortFactoryOptions {
  /** initialize clientInfo.version. */
  appVersion: string;
}

/**
 * runtimeKind로 프로덕션 `AgentRuntimePort`를 만드는 팩토리를 돌려준다.
 * controller의 createPort deps에 그대로 넘긴다.
 */
export function createDefaultPortFactory(
  options: RuntimePortFactoryOptions,
): (kind: SessionRuntimeKind) => AgentRuntimePort {
  return (kind: SessionRuntimeKind): AgentRuntimePort => {
    if (kind === "direct-codex") {
      return createCodexAppServerAdapter(
        defaultCodexAdapterDeps(options.appVersion, makeListenRuntime()),
      );
    }
    if (kind === "direct-claude") {
      return createClaudeAcpAdapter(defaultClaudeDeps(options.appVersion));
    }
    throw new Error(`createDefaultPortFactory: unsupported runtimeKind "${kind}"`);
  };
}
