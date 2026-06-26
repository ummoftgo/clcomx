/**
 * agent-event-reducer 단위 테스트 — 04 §3 규칙 정본 기준(11 §2.1~§2.3, §2.9).
 * 입력은 AgentEvent, 출력은 TranscriptModel. 룬 미사용 순수 함수.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent, ProviderRef } from "../contracts/normalized";
import type { TranscriptItem, TranscriptModel } from "../contracts/transcript";
import {
  applyEvent,
  createEmptyTranscriptModel,
  evictOverflow,
  resealAfterPatch,
  sealEligibleTurns,
  turnKeyOf,
} from "./agent-event-reducer";

function reduce(events: AgentEvent[], start?: TranscriptModel): TranscriptModel {
  let model = start ?? createEmptyTranscriptModel();
  for (const ev of events) model = applyEvent(model, ev);
  return model;
}

function msgText(item: TranscriptItem | undefined): string {
  if (!item || item.type !== "message") return "";
  return item.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

const codexRef = (over: Partial<ProviderRef> = {}): ProviderRef => ({
  provider: "codex",
  threadId: "A",
  turnId: "t1",
  ...over,
});

describe("agent-event-reducer — message upsert/append/replace (NM-1..NM-5)", () => {
  it("NM-1: replace empty then delta append accumulates text", () => {
    const ref = codexRef({ itemId: "i1" });
    const model = reduce([
      { type: "agent_message", ref, content: [], mode: "replace" },
      { type: "agent_message_delta", ref, delta: "Hi" },
      { type: "agent_message_delta", ref, delta: " there" },
    ]);
    expect(model.visibleItemIds).toEqual(["i1"]);
    expect(msgText(model.itemsById.get("i1"))).toBe("Hi there");
  });

  it("NM-2: replace replaces accumulated content wholesale", () => {
    const ref = codexRef({ itemId: "i1" });
    const model = reduce([
      { type: "agent_message_delta", ref, delta: "Look" },
      { type: "agent_message_delta", ref, delta: "s good" },
      { type: "agent_message", ref, content: [{ type: "text", text: "final" }], mode: "replace" },
    ]);
    expect(msgText(model.itemsById.get("i1"))).toBe("final");
  });

  it("NM-3: different messageId starts a new item", () => {
    const model = reduce([
      { type: "agent_message_delta", ref: { provider: "claude", sessionId: "s", messageId: "m1" }, delta: "a" },
      { type: "agent_message_delta", ref: { provider: "claude", sessionId: "s", messageId: "m2" }, delta: "b" },
    ]);
    expect(model.visibleItemIds).toEqual(["m1", "m2"]);
  });

  it("NM-4: same messageId chunks preserve append order", () => {
    const ref: ProviderRef = { provider: "claude", sessionId: "s", messageId: "m1" };
    const model = reduce([
      { type: "agent_message_delta", ref, delta: "1" },
      { type: "agent_message_delta", ref, delta: "2" },
      { type: "agent_message_delta", ref, delta: "3" },
    ]);
    expect(msgText(model.itemsById.get("m1"))).toBe("123");
  });

  it("NM-5: new itemId creates item; existing updates", () => {
    const model = reduce([
      { type: "agent_message", ref: codexRef({ itemId: "i1" }), content: [{ type: "text", text: "x" }], mode: "replace" },
      { type: "agent_message", ref: codexRef({ itemId: "i1" }), content: [{ type: "text", text: "y" }], mode: "replace" },
    ]);
    expect(model.visibleItemIds).toEqual(["i1"]);
    expect(msgText(model.itemsById.get("i1"))).toBe("y");
  });
});

describe("agent-event-reducer — tool call upsert (NM-6..NM-8)", () => {
  it("NM-6: partial update merges only changed fields", () => {
    const ref = codexRef({ toolCallId: "c1" });
    const model = reduce([
      { type: "tool_call_updated", ref, update: { id: "c1", kind: "edit", status: "pending", title: "Edit" } },
      { type: "tool_call_updated", ref, update: { id: "c1", kind: "edit", status: "in_progress" } },
    ]);
    const item = model.itemsById.get("c1");
    expect(item?.type).toBe("tool_call");
    if (item?.type === "tool_call") {
      expect(item.update.status).toBe("in_progress");
      expect(item.update.title).toBe("Edit"); // 유지
    }
  });

  it("NM-7: content is replaced wholesale (ACP replace semantics)", () => {
    const ref = codexRef({ toolCallId: "c1" });
    const model = reduce([
      { type: "tool_call_updated", ref, update: { id: "c1", kind: "read", status: "in_progress", content: [{ type: "text", text: "a" }] } },
      { type: "tool_call_updated", ref, update: { id: "c1", kind: "read", status: "completed", content: [{ type: "text", text: "b" }, { type: "text", text: "c" }] } },
    ]);
    const item = model.itemsById.get("c1");
    if (item?.type === "tool_call") {
      expect(item.update.content).toEqual([{ type: "text", text: "b" }, { type: "text", text: "c" }]);
    }
  });

  it("NM-8: tool_call_content_delta appends content", () => {
    const ref = codexRef({ toolCallId: "c1" });
    const model = reduce([
      { type: "tool_call_updated", ref, update: { id: "c1", kind: "search", status: "in_progress", content: [{ type: "text", text: "x" }] } },
      { type: "tool_call_content_delta", ref, content: { type: "text", text: "y" } },
    ]);
    const item = model.itemsById.get("c1");
    if (item?.type === "tool_call") {
      expect(item.update.content).toEqual([{ type: "text", text: "x" }, { type: "text", text: "y" }]);
    }
  });
});

describe("agent-event-reducer — Codex reconcile / thought channel (NM-9..NM-11)", () => {
  it("NM-9: completed text is authoritative over delta accumulation", () => {
    const ref = codexRef({ itemId: "i1" });
    const model = reduce([
      { type: "agent_message_delta", ref, delta: "Look" },
      { type: "agent_message_delta", ref, delta: "s good" },
      { type: "agent_message", ref, content: [{ type: "text", text: "Looks good" }], mode: "replace" },
    ]);
    expect(msgText(model.itemsById.get("i1"))).toBe("Looks good");
    const item = model.itemsById.get("i1");
    if (item?.type === "message") expect(item.streaming).toBe(false);
  });

  it("NM-10: thought channel accumulates separately and reconciles", () => {
    const ref = codexRef({ itemId: "i1" });
    const model = reduce([
      { type: "agent_message_delta", ref, delta: "resp", channel: "response" },
      { type: "agent_message_delta", ref, delta: "think", channel: "thought" },
      { type: "agent_message", ref, content: [{ type: "text", text: "THOUGHT" }], mode: "replace", channel: "thought" },
    ]);
    // response 스트림(i1)과 thought 스트림(thought:i1)이 분리
    expect(msgText(model.itemsById.get("i1"))).toBe("resp");
    expect(msgText(model.itemsById.get("thought:i1"))).toBe("THOUGHT");
    const thought = model.itemsById.get("thought:i1");
    if (thought?.type === "message") {
      expect(thought.role).toBe("reasoning");
      expect(thought.collapsed).toBe(true);
    }
  });

  it("NM-11: reasoning indices accumulate within same item, thought channel only", () => {
    const r0 = codexRef({ itemId: "i1", messageId: undefined });
    const model = reduce([
      { type: "agent_message_delta", ref: r0, delta: "idx0a", channel: "thought" },
      { type: "agent_message_delta", ref: r0, delta: "idx0b", channel: "thought" },
    ]);
    expect(msgText(model.itemsById.get("thought:i1"))).toBe("idx0aidx0b");
    // response 스트림은 비어 있음
    expect(model.itemsById.has("i1")).toBe(false);
  });
});

describe("agent-event-reducer — notice generation/dedup (04 §3.6)", () => {
  it("turn_completed failed creates one warning notice (dedup idempotent)", () => {
    const ref = codexRef();
    const model = reduce([
      { type: "turn_completed", ref, status: "failed" },
      { type: "turn_completed", ref, status: "failed" }, // 재emit → 멱등 무시
    ]);
    const notices = [...model.itemsById.values()].filter((i) => i.type === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].type === "notice" && notices[0].level).toBe("warning");
  });

  it("turn_completed completed with refusal stopReason creates warning notice", () => {
    const ref = codexRef({ raw: { stopReason: "refusal" } });
    const model = reduce([{ type: "turn_completed", ref, status: "completed" }]);
    const notices = [...model.itemsById.values()].filter((i) => i.type === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].type === "notice" && notices[0].messageKey).toBe("agentRuntime.errors.refusal");
  });

  it("process_exited abnormal creates one error notice; normal exit none", () => {
    const abn = reduce([{ type: "process_exited", ref: { provider: "codex", sessionId: "s" }, code: 1 }]);
    expect([...abn.itemsById.values()].filter((i) => i.type === "notice")).toHaveLength(1);
    const ok = reduce([{ type: "process_exited", ref: { provider: "codex", sessionId: "s" }, code: 0 }]);
    expect([...ok.itemsById.values()].filter((i) => i.type === "notice")).toHaveLength(0);
  });
});

describe("agent-event-reducer — legacy PTY not lifted to transcript (NM-30)", () => {
  it("terminal_output_delta leaves transcript model unchanged", () => {
    const before = createEmptyTranscriptModel();
    const after = applyEvent(before, {
      type: "terminal_output_delta",
      ref: { provider: "legacy-pty", sessionId: "s" },
      ptyId: 1,
      seq: 0,
      delta: "hello",
    });
    expect(after).toBe(before); // 동일 참조(불변)
    expect(after.visibleItemIds).toHaveLength(0);
  });
});

describe("agent-event-reducer — seal / eviction / late-event (NM-31..NM-35)", () => {
  // 한 turn을 만들고 seal 조건(종료신호+open0+pending0)을 충족시키는 헬퍼
  function buildSealedTurn(model: TranscriptModel, turnId: string): TranscriptModel {
    const ref = codexRef({ turnId, itemId: `${turnId}-i` });
    let m = applyEvent(model, { type: "agent_message", ref, content: [{ type: "text", text: turnId }], mode: "replace" });
    m = applyEvent(m, { type: "turn_completed", ref, status: "completed" });
    return sealEligibleTurns(m);
  }

  it("NM-32: seal transitions unsealed -> sealed-retained when conditions met", () => {
    let m = createEmptyTranscriptModel();
    m = buildSealedTurn(m, "t1");
    expect(m.turnsById.get(turnKeyOf(codexRef({ turnId: "t1" })))?.residency).toBe("sealed-retained");
  });

  it("NM-32b: pending request blocks seal until cleared", () => {
    const ref = codexRef({ turnId: "t1", itemId: "t1-i" });
    let m = createEmptyTranscriptModel();
    m = applyEvent(m, { type: "agent_message", ref, content: [{ type: "text", text: "x" }], mode: "replace" });
    // pending 1건을 turn 메타에 직접 반영(store가 하는 일을 모사)
    const turnKey = turnKeyOf(ref);
    m.turnsById.get(turnKey)!.pendingRequestCount = 1;
    m = applyEvent(m, { type: "turn_completed", ref, status: "completed" });
    m = sealEligibleTurns(m);
    expect(m.turnsById.get(turnKey)?.residency).toBe("unsealed");
  });

  it("NM-31: overflow evicts oldest sealed turn, heap bounded", () => {
    const config = { HOT_WINDOW_SEALED_TURNS: 2, TOMBSTONE_LRU: 10, SEAL_QUIESCENCE_GRACE_MS: 0 };
    let m = createEmptyTranscriptModel();
    for (let i = 0; i < 5; i++) {
      m = buildSealedTurn(m, `t${i}`);
      m = evictOverflow(m, config);
    }
    // 최근 2 sealed turn만 body 유지 → itemsById 크기 bounded(2)
    expect(m.itemsById.size).toBeLessThanOrEqual(2);
    const oldest = turnKeyOf(codexRef({ turnId: "t0" }));
    expect(m.turnsById.get(oldest)?.residency).toBe("evicted-tombstone");
  });

  it("NM-31c: eviction prunes meta indexes (itemVersions/turnsById bounded)", () => {
    const config = { HOT_WINDOW_SEALED_TURNS: 1, TOMBSTONE_LRU: 2, SEAL_QUIESCENCE_GRACE_MS: 0 };
    let m = createEmptyTranscriptModel();
    for (let i = 0; i < 6; i++) {
      m = buildSealedTurn(m, `t${i}`);
      m = evictOverflow(m, config);
    }
    // itemVersions는 살아있는 body item만 + tombstone LRU(2) 메타만 turnsById에 유지
    expect(Object.keys(m.itemVersions).length).toBeLessThanOrEqual(1);
    const tombstones = [...m.turnsById.values()].filter((t) => t.residency === "evicted-tombstone");
    expect(tombstones.length).toBeLessThanOrEqual(2); // TOMBSTONE_LRU cap
  });

  it("NM-33: late same-turn event on sealed-retained -> unseal/patch/reseal + telemetry", () => {
    let m = createEmptyTranscriptModel();
    m = buildSealedTurn(m, "t1");
    const turnKey = turnKeyOf(codexRef({ turnId: "t1" }));
    expect(m.turnsById.get(turnKey)?.residency).toBe("sealed-retained");
    // 늦은 same-turn delta 도착
    m = applyEvent(m, { type: "agent_message_delta", ref: codexRef({ turnId: "t1", itemId: "t1-i" }), delta: "+late" });
    expect(m.turnsById.get(turnKey)?.residency).toBe("unsealed"); // unseal
    expect(m.turnsById.get(turnKey)?.resealCount).toBe(1); // telemetry
    expect(msgText(m.itemsById.get("t1-i"))).toContain("+late"); // patch 반영
    // reseal(외부 트리거)
    m = applyEvent(m, { type: "turn_completed", ref: codexRef({ turnId: "t1", itemId: "t1-i" }), status: "completed" });
    m = resealAfterPatch(m);
    expect(m.turnsById.get(turnKey)?.residency).toBe("sealed-retained");
  });

  it("NM-34: late event on evicted-tombstone is dropped + droppedLateEventCount++", () => {
    const config = { HOT_WINDOW_SEALED_TURNS: 1, TOMBSTONE_LRU: 10, SEAL_QUIESCENCE_GRACE_MS: 0 };
    let m = createEmptyTranscriptModel();
    m = buildSealedTurn(m, "t0");
    m = evictOverflow(m, config);
    m = buildSealedTurn(m, "t1");
    m = evictOverflow(m, config); // t0 evicted
    const t0Key = turnKeyOf(codexRef({ turnId: "t0" }));
    expect(m.turnsById.get(t0Key)?.residency).toBe("evicted-tombstone");
    const before = m.tombstones.droppedLateEventCount;
    m = applyEvent(m, { type: "agent_message_delta", ref: codexRef({ turnId: "t0", itemId: "t0-i" }), delta: "late" });
    expect(m.tombstones.droppedLateEventCount).toBe(before + 1);
    expect(m.itemsById.has("t0-i")).toBe(false); // body 미복원
    expect(m.turnsById.get(t0Key)?.residency).toBe("evicted-tombstone");
  });

  it("NM-35: AgentEvent itself is unchanged by seal/eviction (policy is reducer-internal)", () => {
    const ev: AgentEvent = { type: "agent_message", ref: codexRef({ itemId: "i1" }), content: [{ type: "text", text: "x" }], mode: "replace" };
    const snapshot = JSON.parse(JSON.stringify(ev));
    let m = applyEvent(createEmptyTranscriptModel(), ev);
    m = sealEligibleTurns(m);
    m = evictOverflow(m);
    expect(ev).toEqual(snapshot); // event 불변
  });
});
