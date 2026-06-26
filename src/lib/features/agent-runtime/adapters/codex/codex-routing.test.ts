/**
 * CodexRouting 단위 테스트(05 §6). 삼중 키, 멱등 가드, pending table closing/closed.
 */
import { describe, expect, it } from "vitest";
import { CodexRouting } from "./codex-routing";

describe("thread / handle binding", () => {
  it("ensureThread + sessionIdOf, bindHandle + threadIdOf", () => {
    const r = new CodexRouting();
    r.ensureThread("th_1", "s1");
    expect(r.sessionIdOf("th_1")).toBe("s1");
    r.bindHandle("H", "th_1");
    expect(r.threadIdOf("H")).toBe("th_1");
    expect(r.threadIdOf("missing")).toBeUndefined();
  });

  it("alreadyStarted / markStarted idempotency guard", () => {
    const r = new CodexRouting();
    expect(r.alreadyStarted("t")).toBe(false);
    r.markStarted("t");
    expect(r.alreadyStarted("t")).toBe(true);
  });
});

describe("turn lifecycle", () => {
  it("setActiveTurn / activeTurnOf / clearActiveTurn / isTurnClosed", () => {
    const r = new CodexRouting();
    r.setActiveTurn("th", "t1");
    expect(r.activeTurnOf("th")).toBe("t1");
    expect(r.isTurnClosed("th", "t1")).toBe(false);
    r.clearActiveTurn("th", "t1");
    expect(r.activeTurnOf("th")).toBeUndefined();
    expect(r.isTurnClosed("th", "t1")).toBe(true);
  });

  it("token usage record/take is per (threadId,turnId)", () => {
    const r = new CodexRouting();
    r.recordTokenUsage("th", "t1", { inputTokens: 5 });
    expect(r.takeTokenUsage("th", "t1")).toEqual({ inputTokens: 5 });
    // taken once → gone
    expect(r.takeTokenUsage("th", "t1")).toBeUndefined();
    expect(r.takeTokenUsage("th", "t2")).toBeUndefined();
  });
});

describe("approval pending table (D12: rpcId type preserved)", () => {
  it("addPendingApproval keeps original numeric rpcId; resolve returns it", () => {
    const r = new CodexRouting();
    r.addPendingApproval("7", 7, "item/commandExecution/requestApproval", { threadId: "th", turnId: "t1", itemId: "c1" });
    expect(r.hasPendingApproval("7")).toBe(true);
    const p = r.resolveApproval("7");
    expect(p?.rpcId).toBe(7);
    expect(typeof p?.rpcId).toBe("number");
    expect(r.hasPendingApproval("7")).toBe(false);
  });

  it("string rpcId preserved as string", () => {
    const r = new CodexRouting();
    r.addPendingApproval("rq", "rq", "item/fileChange/requestApproval", { threadId: "th", turnId: "t1" });
    expect(r.resolveApproval("rq")?.rpcId).toBe("rq");
  });

  it("markTurnApprovalsClosing only closes pending once (idempotent)", () => {
    const r = new CodexRouting();
    r.addPendingApproval("1", 1, "m", { threadId: "th", turnId: "t1" });
    r.addPendingApproval("2", 2, "m", { threadId: "th", turnId: "t1" });
    r.addPendingApproval("3", 3, "m", { threadId: "th", turnId: "t2" }); // 다른 turn
    const first = r.markTurnApprovalsClosing("th", "t1");
    expect(first.sort()).toEqual(["1", "2"]);
    // 다시 호출하면 이미 closing → 빈 배열(멱등)
    expect(r.markTurnApprovalsClosing("th", "t1")).toEqual([]);
    // hasPendingApproval은 closing이면 false(멱등 가드)
    expect(r.hasPendingApproval("1")).toBe(false);
  });

  it("allPendingApprovalIds / pendingApprovalsForTurn", () => {
    const r = new CodexRouting();
    r.addPendingApproval("1", 1, "m", { threadId: "th", turnId: "t1" });
    r.addPendingApproval("2", 2, "m", { threadId: "th", turnId: "t2" });
    expect(r.allPendingApprovalIds().sort()).toEqual(["1", "2"]);
    expect(r.pendingApprovalsForTurn("th", "t1")).toEqual(["1"]);
  });
});
