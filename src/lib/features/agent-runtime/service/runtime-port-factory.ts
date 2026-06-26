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
import type { AgentRuntimeEvent, RuntimeId } from "./transport";
import {
  agentRuntimeSend,
  agentRuntimeCancel,
  agentRuntimeShutdown,
  AGENT_RUNTIME_EVENTS,
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
} from "./transport";

/** 단조 증가 JSON-RPC id 발급기(세션 간 공유 카운터). */
function makeIdGen(): () => number {
  let n = 0;
  return () => (n += 1);
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
    for (const name of Object.values(AGENT_RUNTIME_EVENTS)) {
      void listen<AgentRuntimeEvent>(name, (e) => {
        const p = e.payload;
        if (p.runtimeId === runtimeId) handler(p);
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
    event: string,
    h: (e: { payload: AgentRuntimeEvent }) => void,
  ): Promise<UnlistenFn> => listen<AgentRuntimeEvent>(event, h);
}

/**
 * Claude resolveLaunch 기본 구현. backend가 node 절대경로·adapterEntryPath를 resolve하는 command가
 * 아직 연결되지 않았으므로(후속 backend phase), 연결 전에는 명시적으로 실패시켜 잘못된 launch를 막는다.
 */
function defaultClaudeResolveLaunch(
  _p: StartSessionParams | ResumeSessionParams,
): Promise<ResolvedLaunch> {
  return Promise.reject(
    new Error(
      "claude-acp resolveLaunch is not wired yet (backend entry resolve pending)",
    ),
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
