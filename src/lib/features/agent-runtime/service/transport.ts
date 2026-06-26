/**
 * Direct Agent Runtime — frontend transport 래퍼(15 §8.2/§8.3).
 *
 * 정본: `docs/plans/agent-direct-runtime/15-data-contracts.md` §8.
 * `agent_runtime_*` Tauri command invoke 래퍼 + `agent-runtime-*` event listen 구독 + wire 타입 export.
 *
 * 규약: transport는 반드시 `../../../tauri/core`의 `invoke`, `../../../tauri/event`의 `listen`만 경유한다
 * (`@tauri-apps/api` 직접 import 금지). pty.ts의 transport 대응이며 controller는 이 모듈만 본다.
 */

import { invoke } from "../../../tauri/core";
import { listen, type UnlistenFn } from "../../../tauri/event";

// ───────────────────────── wire 타입(15 §8.1) ─────────────────────────

/** runtime 식별자. backend RuntimeId(u32)와 1:1. */
export type RuntimeId = number;
/** JSON-RPC id. string | number | null. */
export type JsonRpcId = string | number | null;

/** JSON-RPC error 객체(15 §8.1). */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 메시지 4종(15 §8.1). Codex는 `jsonrpc` 생략, ACP는 `"2.0"`. adapter가 envelope를 맞춘다.
 */
export type JsonRpcMessage =
  | { jsonrpc?: "2.0"; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc?: "2.0"; method: string; params?: unknown }
  | { jsonrpc?: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc?: "2.0"; id: JsonRpcId; error: JsonRpcError };

/**
 * process/transport 기동 파라미터(15 §8.1). S1 정본: renderer는 executable command를 넘기지 않고
 * backend가 provider로 신뢰 절대경로를 resolve한다. adapter는 provider/distro/workDir/args/env만 채운다.
 * - codex `args`: backend가 정확히 `["app-server","--stdio"]`로 검증.
 * - claude `args`: `[adapterEntryPath]`(절대경로, backend resolve).
 * - `env`: non-secret 전용.
 */
export type AgentRuntimeStartParams =
  | {
      transportKind: "jsonrpc-stdio";
      provider: "codex";
      distro: string;
      workDir: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      transportKind: "jsonrpc-stdio";
      provider: "claude";
      distro: string;
      workDir: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      // future-sketch — v1 미사용. backend handler가 로깅/스냅샷 노출 전 reject(D-WSAUTH).
      transportKind: "websocket";
      provider: "codex";
      distro: string;
      workDir: string;
      url: string;
      authToken?: string;
    };

/** cancel 대상(15 §8.1). request=approval 요청, turn=진행 turn, process=전체. */
export type AgentRuntimeCancelTarget =
  | { type: "request"; requestId: string }
  | { type: "turn"; turnId: string }
  | { type: "process" };

/** runtime 상태 스냅샷(15 §8.1, late-attach/진단용). */
export interface AgentRuntimeSnapshot {
  runtimeId: RuntimeId;
  provider: "codex" | "claude";
  status: "starting" | "running" | "exited" | "failed";
  startedAt: number;
  exitedAt?: number;
  pendingRequestIds: string[];
}

// ───────────────────────── event payload(15 §8.3) ─────────────────────────

/**
 * backend emit → frontend listen payload(15 §8.3).
 * M-4: message는 backend가 `serde_json::Value`로 무손실 통과시키고, TS는 `JsonRpcMessage`로 받는다.
 */
export type AgentRuntimeEvent =
  | { type: "message"; runtimeId: RuntimeId; message: JsonRpcMessage }
  | { type: "stderr"; runtimeId: RuntimeId; line: string }
  | { type: "exit"; runtimeId: RuntimeId; code?: number; signal?: string }
  | { type: "error"; runtimeId: RuntimeId; message: string; recoverable: boolean }
  | { type: "backpressure"; runtimeId: RuntimeId; droppedMessages: number };

/** event 이름 리터럴(kebab-case, 15 §8.3). */
export const AGENT_RUNTIME_EVENTS = {
  message: "agent-runtime-message",
  stderr: "agent-runtime-stderr",
  exit: "agent-runtime-exit",
  error: "agent-runtime-error",
  backpressure: "agent-runtime-backpressure",
} as const;

// ───────────────────────── invoke 래퍼(15 §8.2) ─────────────────────────

/** 새 direct runtime 시작. backend가 process를 띄우고 RuntimeId를 돌려준다. */
export async function agentRuntimeStart(params: AgentRuntimeStartParams): Promise<RuntimeId> {
  return await invoke<RuntimeId>("agent_runtime_start", { params });
}

/** stdin으로 JSON-RPC 메시지 전송. */
export async function agentRuntimeSend(
  runtimeId: RuntimeId,
  message: JsonRpcMessage,
): Promise<void> {
  await invoke("agent_runtime_send", { runtimeId, message });
}

/** cancel. backend는 process target만 처리(turn/request는 adapter가 wire 전송). */
export async function agentRuntimeCancel(
  runtimeId: RuntimeId,
  target: AgentRuntimeCancelTarget,
): Promise<void> {
  await invoke("agent_runtime_cancel", { runtimeId, target });
}

/** graceful shutdown(stdin EOF → grace → kill → child reap). */
export async function agentRuntimeShutdown(runtimeId: RuntimeId): Promise<void> {
  await invoke("agent_runtime_shutdown", { runtimeId });
}

/** runtime 상태 스냅샷(late-attach 진단용). */
export async function agentRuntimeGetSnapshot(
  runtimeId: RuntimeId,
): Promise<AgentRuntimeSnapshot> {
  return await invoke<AgentRuntimeSnapshot>("agent_runtime_get_snapshot", { runtimeId });
}

// ───────────────────────── event 구독 ─────────────────────────

/** runtime별 event 핸들러 묶음. 미지정 핸들러는 무시된다. */
export interface AgentTransportHandlers {
  onMessage?: (runtimeId: RuntimeId, message: JsonRpcMessage) => void;
  onStderr?: (runtimeId: RuntimeId, line: string) => void;
  onExit?: (runtimeId: RuntimeId, code?: number, signal?: string) => void;
  onError?: (runtimeId: RuntimeId, message: string, recoverable: boolean) => void;
  onBackpressure?: (runtimeId: RuntimeId, droppedMessages: number) => void;
}

/**
 * 한 runtime의 5개 event 채널을 구독하고, runtimeId로 필터링해 핸들러로 디스패치한다.
 * 반환된 dispose는 모든 구독을 해제한다(pty.ts 대응 패턴).
 */
export interface AgentTransportController {
  /** 구독 시작(아직 미구독이면 listen 등록). */
  start(): Promise<void>;
  /** 모든 event 구독 해제. */
  dispose(): Promise<void>;
}

/**
 * runtimeId에 바인딩된 transport controller를 만든다. 5개 event를 listen하고 payload.runtimeId가
 * 일치하는 것만 핸들러로 전달한다(다른 runtime의 event는 무시).
 */
export function createAgentTransportController(
  runtimeId: RuntimeId,
  handlers: AgentTransportHandlers,
): AgentTransportController {
  let unlisteners: UnlistenFn[] = [];
  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    // 각 event를 listen하고 runtimeId로 필터링. 핵심 분기: payload.runtimeId 미일치는 drop.
    const subs = await Promise.all([
      listen<AgentRuntimeEvent>(AGENT_RUNTIME_EVENTS.message, (e) => {
        const p = e.payload;
        if (p.type === "message" && p.runtimeId === runtimeId) {
          handlers.onMessage?.(p.runtimeId, p.message);
        }
      }),
      listen<AgentRuntimeEvent>(AGENT_RUNTIME_EVENTS.stderr, (e) => {
        const p = e.payload;
        if (p.type === "stderr" && p.runtimeId === runtimeId) {
          handlers.onStderr?.(p.runtimeId, p.line);
        }
      }),
      listen<AgentRuntimeEvent>(AGENT_RUNTIME_EVENTS.exit, (e) => {
        const p = e.payload;
        if (p.type === "exit" && p.runtimeId === runtimeId) {
          handlers.onExit?.(p.runtimeId, p.code, p.signal);
        }
      }),
      listen<AgentRuntimeEvent>(AGENT_RUNTIME_EVENTS.error, (e) => {
        const p = e.payload;
        if (p.type === "error" && p.runtimeId === runtimeId) {
          handlers.onError?.(p.runtimeId, p.message, p.recoverable);
        }
      }),
      listen<AgentRuntimeEvent>(AGENT_RUNTIME_EVENTS.backpressure, (e) => {
        const p = e.payload;
        if (p.type === "backpressure" && p.runtimeId === runtimeId) {
          handlers.onBackpressure?.(p.runtimeId, p.droppedMessages);
        }
      }),
    ]);
    unlisteners = subs;
  }

  async function dispose(): Promise<void> {
    const current = unlisteners;
    unlisteners = [];
    started = false;
    for (const un of current) {
      try {
        un();
      } catch {
        // 해제 실패는 무시(이미 해제됨 가능).
      }
    }
  }

  return { start, dispose };
}
