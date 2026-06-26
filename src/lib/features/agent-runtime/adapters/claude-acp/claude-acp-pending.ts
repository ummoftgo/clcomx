/**
 * Claude ACP 어댑터 — pending request/approval 테이블 관리(06 §4, §6.3).
 *
 * - pendingRequests: client→agent 요청 응답 매칭(§3.1a rpcRequest). 키 = 원본 JSON-RPC id 타입(R3).
 * - pendingApprovals: agent→client request_permission(§6.1). 키 = String(rpcId), 값.rpcId가 원본 타입 보존.
 */

import type { JsonRpcMessage } from "../../service/transport";
import type { PendingApproval, PendingRequest } from "../../contracts/claude-acp";

/** pending 테이블 묶음(세션 런타임 단위). */
export interface PendingTables {
  pendingRequests: Map<string | number, PendingRequest>;
  pendingApprovals: Map<string, PendingApproval>;
}

/** 새 pending 테이블 생성. */
export function createPendingTables(): PendingTables {
  return {
    pendingRequests: new Map(),
    pendingApprovals: new Map(),
  };
}

/** 어댑터 내부 에러(JSON-RPC error response를 표현). 호출부가 분류·fallback에 쓴다(§9). */
export class AdapterError extends Error {
  constructor(
    message: string,
    /** JSON-RPC error code(ref-acp §11). 미상이면 undefined. */
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

/**
 * inbound response({id, result|error})를 pendingRequests로 settle(§3.1a resolveRpc).
 * - id는 **원본 타입(string|number)** 으로 조회(R3).
 * - 늦은/중복 응답(미존재 id)은 멱등 무시(§4.4 (c)).
 * - error면 AdapterError로 reject(H3 분기, §9).
 * @returns settle 성공 여부(미존재면 false).
 */
export function resolveRpc(tables: PendingTables, msg: JsonRpcMessage): boolean {
  const m = msg as { id: string | number; result?: unknown; error?: { code: number; message: string; data?: unknown } };
  const pending = tables.pendingRequests.get(m.id);
  if (!pending) return false; // 늦은/중복 응답 → 멱등 무시.
  tables.pendingRequests.delete(m.id);
  if ("error" in msg && m.error) {
    pending.reject(new AdapterError(m.error.message, m.error.code, m.error.data));
  } else {
    pending.resolve(m.result);
  }
  return true;
}
