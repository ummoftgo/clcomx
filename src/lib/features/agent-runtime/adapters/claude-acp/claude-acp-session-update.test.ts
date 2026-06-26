/**
 * Claude ACP — session/update variant 매핑 단위 테스트(11 §4.3/§4.4, CL-12..CL-18).
 * messageId 그룹핑, tool_call content replace, plan 전체 교체, thought 채널, usage 축 분리, audio 방어.
 */
import { describe, expect, it } from "vitest";
import { mapSessionUpdate, type SessionUpdateRuntime } from "./claude-acp-session-update";
import type { AcpSessionUpdate } from "../../contracts/claude-acp";

function newRt(over: Partial<SessionUpdateRuntime> = {}): SessionUpdateRuntime {
  return {
    providerSessionId: "s1",
    activeTurnId: "s1:t1",
    unknownCounter: 0,
    ...over,
  };
}

describe("mapSessionUpdate — message chunks (CL-12/CL-13)", () => {
  it("CL-12: agent_message_chunk×N → agent_message_delta×N, messageId 그룹핑", () => {
    const rt = newRt();
    const u1: AcpSessionUpdate = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" }, messageId: "m1" };
    const u2: AcpSessionUpdate = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" }, messageId: "m1" };
    const e1 = mapSessionUpdate(rt, u1);
    const e2 = mapSessionUpdate(rt, u2);
    expect(e1).toEqual([{ type: "agent_message_delta", ref: expect.objectContaining({ messageId: "m1", turnId: "s1:t1" }), delta: "Hel" }]);
    expect(e2[0]).toMatchObject({ type: "agent_message_delta", delta: "lo" });
    expect(rt.currentMessageId).toBe("m1");
  });

  it("CL-13: messageId m1→m2로 바뀌면 새 메시지 시작", () => {
    const rt = newRt();
    mapSessionUpdate(rt, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" }, messageId: "m1" });
    expect(rt.currentMessageId).toBe("m1");
    mapSessionUpdate(rt, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" }, messageId: "m2" });
    expect(rt.currentMessageId).toBe("m2");
  });

  it("user_message_chunk → user_message{append}", () => {
    const rt = newRt();
    const ev = mapSessionUpdate(rt, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" }, messageId: "u1" });
    expect(ev[0]).toMatchObject({ type: "user_message", mode: "append" });
  });

  it("비텍스트 agent chunk(image) → agent_message{append}", () => {
    const rt = newRt();
    const ev = mapSessionUpdate(rt, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "QUJD", mimeType: "image/png" },
      messageId: "m1",
    });
    expect(ev[0]).toMatchObject({ type: "agent_message", mode: "append" });
    expect((ev[0] as { content: unknown[] }).content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });
});

describe("mapSessionUpdate — thought channel (CL-17)", () => {
  it("agent_thought_chunk → agent_message_delta{channel:thought}, response와 별도 스트림", () => {
    const rt = newRt();
    const ev = mapSessionUpdate(rt, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" }, messageId: "t1" });
    expect(ev[0]).toEqual({
      type: "agent_message_delta",
      ref: expect.objectContaining({ messageId: "t1" }),
      delta: "thinking",
      channel: "thought",
    });
  });
});

describe("mapSessionUpdate — tool_call (CL-14/CL-15)", () => {
  it("CL-14: tool_call 후 tool_call_update{content} → content 전체 교체", () => {
    const rt = newRt();
    const created = mapSessionUpdate(rt, {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read file",
      kind: "read",
      status: "pending",
    });
    expect(created[0]).toMatchObject({ type: "tool_call_updated", update: { id: "tc1", title: "Read file", kind: "read", status: "pending" } });

    const updated = mapSessionUpdate(rt, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "file body" } }],
    });
    const up = (updated[0] as { update: { content?: unknown[]; status: string } }).update;
    expect(up.status).toBe("completed");
    expect(up.content).toEqual([{ type: "text", text: "file body" }]); // 전체 교체
  });

  it("CL-15: tool_call_update{status only} → 바뀐 필드만, content/title undefined(store 유지)", () => {
    const rt = newRt();
    const ev = mapSessionUpdate(rt, { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" });
    const up = (ev[0] as { update: { content?: unknown; title?: unknown; status: string } }).update;
    expect(up.status).toBe("completed");
    expect(up.content).toBeUndefined();
    expect(up.title).toBeUndefined();
  });

  it("switch_mode kind → other", () => {
    const rt = newRt();
    const ev = mapSessionUpdate(rt, { sessionUpdate: "tool_call", toolCallId: "tc2", title: "x", kind: "switch_mode" });
    expect((ev[0] as { update: { kind: string } }).update.kind).toBe("other");
  });
});

describe("mapSessionUpdate — plan (CL-16)", () => {
  it("plan → plan_updated{entries} 전체 교체", () => {
    const rt = newRt();
    const ev = mapSessionUpdate(rt, {
      sessionUpdate: "plan",
      entries: [
        { content: "step1", status: "in_progress", priority: "high" },
        { content: "step2", status: "pending", priority: "low" },
      ],
    });
    expect(ev[0]).toMatchObject({
      type: "plan_updated",
      entries: [
        { content: "step1", status: "in_progress", priority: "high" },
        { content: "step2", status: "pending", priority: "low" },
      ],
    });
  });
});

describe("mapSessionUpdate — usage axis (OQ-02)", () => {
  it("usage_update {used,size} → contextUsed/contextSize, inputTokens 미오염", () => {
    const rt = newRt();
    const ev = mapSessionUpdate(rt, { sessionUpdate: "usage_update", used: 1200, size: 200000 });
    expect(ev).toEqual([]); // event 없음
    expect(rt.lastUsage).toEqual({ contextUsed: 1200, contextSize: 200000 });
    expect(rt.lastUsage?.inputTokens).toBeUndefined();
  });
});

describe("mapSessionUpdate — defensive (CL-18/CL-27)", () => {
  it("CL-18: audio content block → raw 보존, crash 없음 (TODO(13): audio policy)", () => {
    const rt = newRt();
    const ev = mapSessionUpdate(rt, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "audio", data: "AAA", mimeType: "audio/wav" },
      messageId: "a1",
    });
    expect(ev[0]).toMatchObject({ type: "agent_message", mode: "append" });
    // audio는 json raw로 보존(모델 gap) — text delta 경로로 새지 않음.
    expect((ev[0] as { content: Array<{ type: string }> }).content[0].type).toBe("json");
  });

  it("CL-27: plan_update/plan_removed → 무시 + unknownCounter 증가, outbound 없음", () => {
    const rt = newRt();
    expect(mapSessionUpdate(rt, { sessionUpdate: "plan_update", plan: {} } as AcpSessionUpdate)).toEqual([]);
    expect(mapSessionUpdate(rt, { sessionUpdate: "plan_removed", id: "p1" } as AcpSessionUpdate)).toEqual([]);
    expect(rt.unknownCounter).toBe(2);
  });

  it("CL-27: 알 수 없는 variant → counter 증가, crash 없음", () => {
    const rt = newRt();
    const ev = mapSessionUpdate(rt, { sessionUpdate: "totally_unknown" } as unknown as AcpSessionUpdate);
    expect(ev).toEqual([]);
    expect(rt.unknownCounter).toBe(1);
  });

  it("current_mode_update → currentModeId 갱신(전용 event 없음)", () => {
    const rt = newRt();
    const ev = mapSessionUpdate(rt, { sessionUpdate: "current_mode_update", currentModeId: "bypassPermissions" });
    expect(ev).toEqual([]);
    expect(rt.currentModeId).toBe("bypassPermissions");
  });
});
