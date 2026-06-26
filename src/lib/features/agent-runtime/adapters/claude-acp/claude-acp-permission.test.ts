/**
 * Claude ACP — permission 매핑 단위 테스트(11 §4.5, CL-19..CL-24).
 * option kind 1:1, rpcId 타입 보존(R3, CL-21b/21c), severity 분류(OQ-47), selected/cancelled wire shape.
 */
import { describe, expect, it } from "vitest";
import { buildPermissionResponse, classifySeverity, mapRequestPermission } from "./claude-acp-permission";
import type { AcpRequestPermissionParams } from "../../contracts/claude-acp";
import type { JsonRpcMessage } from "../../service/transport";

const baseParams = (over: Partial<AcpRequestPermissionParams> = {}): AcpRequestPermissionParams => ({
  sessionId: "s1",
  toolCall: { toolCallId: "tc1", title: "Edit file" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
  ...over,
});

describe("mapRequestPermission (CL-19/CL-20)", () => {
  it("CL-19: request_permission{id:42} → approval_requested{id:'42', toolCallId}, options 매핑", () => {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id: 42, method: "session/request_permission", params: baseParams() };
    const { event, pending } = mapRequestPermission({ providerSessionId: "s1", activeTurnId: "s1:t1" }, msg);
    expect(event.type).toBe("approval_requested");
    const req = (event as { request: { id: string; toolCallId?: string; options: unknown[] } }).request;
    expect(req.id).toBe("42"); // 문자열 키
    expect(req.toolCallId).toBe("tc1");
    expect(req.options).toEqual([
      { id: "allow", label: "Allow", kind: "allow_once" },
      { id: "always", label: "Always allow", kind: "allow_always" },
      { id: "reject", label: "Reject", kind: "reject_once" },
    ]);
    expect(event.ref.requestId).toBe("42");
    expect(event.ref.turnId).toBe("s1:t1");
    // R3: pending.rpcId는 원본 number 보존.
    expect(pending.rpcId).toBe(42);
    expect(typeof pending.rpcId).toBe("number");
  });

  it("CL-20: PermissionOptionKind 4종 1:1 매핑", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/request_permission",
      params: baseParams({
        options: [
          { optionId: "a", name: "a", kind: "allow_once" },
          { optionId: "b", name: "b", kind: "allow_always" },
          { optionId: "c", name: "c", kind: "reject_once" },
          { optionId: "d", name: "d", kind: "reject_always" },
        ],
      }),
    };
    const { event } = mapRequestPermission({ providerSessionId: "s1" }, msg);
    const kinds = (event as { request: { options: Array<{ kind: string }> } }).request.options.map((o) => o.kind);
    expect(kinds).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"]);
  });
});

describe("buildPermissionResponse (CL-21/CL-21b/CL-21c/CL-22)", () => {
  it("CL-21: selected → {jsonrpc, id:42, result:{outcome:{outcome:selected, optionId}}}", () => {
    const wire = buildPermissionResponse(42, { outcome: "selected", optionId: "allow" });
    expect(wire).toEqual({ jsonrpc: "2.0", id: 42, result: { outcome: { outcome: "selected", optionId: "allow" } } });
  });

  it("CL-21b: numeric id 보존 — wire 응답 id가 number 42 (string '42' 금지, R3)", () => {
    const wire = buildPermissionResponse(42, { outcome: "selected", optionId: "x" }) as { id: unknown };
    expect(wire.id).toBe(42);
    expect(typeof wire.id).toBe("number");
  });

  it("CL-21c: string id 보존 — wire 응답 id가 'req-1' 그대로(R3)", () => {
    const wire = buildPermissionResponse("req-1", { outcome: "selected", optionId: "x" }) as { id: unknown };
    expect(wire.id).toBe("req-1");
    expect(typeof wire.id).toBe("string");
  });

  it("CL-22: cancelled → {result:{outcome:{outcome:cancelled}}}, id 원본 타입", () => {
    const wire = buildPermissionResponse(7, { outcome: "cancelled" });
    expect(wire).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } });
  });
});

describe("classifySeverity (OQ-47)", () => {
  it("기본값은 normal(inline)", () => {
    expect(classifySeverity(baseParams(), {})).toBe("normal");
  });

  it("CL-23: ExitPlanMode에 bypassPermissions 옵션 노출 → escalation(modal)", () => {
    const params = baseParams({
      options: [
        { optionId: "default", name: "Default", kind: "allow_once" },
        { optionId: "acceptEdits", name: "Accept edits", kind: "allow_always" },
        { optionId: "bypassPermissions", name: "Bypass", kind: "allow_always" },
      ],
    });
    expect(classifySeverity(params, {})).toBe("escalation");
  });

  it("현재 mode가 bypassPermissions이면 escalation", () => {
    expect(classifySeverity(baseParams(), { currentModeId: "bypassPermissions" })).toBe("escalation");
  });
});
