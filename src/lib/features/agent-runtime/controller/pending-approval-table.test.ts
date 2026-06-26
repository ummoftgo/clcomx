/**
 * pending-approval-table 단위 테스트 — 04 §4·§5.0 (11 §2.4·§2.5).
 * 정확히 1회 멱등 종료, (sessionHandle, requestId) 복합 키 충돌 회귀(NM-15b).
 */
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../contracts/normalized";
import { PendingApprovalTable, pendingKey } from "./pending-approval-table";

function req(id: string, severity?: "normal" | "escalation"): ApprovalRequest {
  return {
    id,
    title: "Run command",
    options: [
      { id: "ok", label: "Allow", kind: "allow_once" },
      { id: "no", label: "Reject", kind: "reject_once" },
    ],
    severity,
  };
}

describe("pending-approval-table — register/resolve (NM-12..NM-15)", () => {
  it("NM-12/13: register then resolve removes from pending", () => {
    const t = new PendingApprovalTable();
    t.register("A", "codex", req("7"), "A:t1");
    expect(t.listForSession("A")).toHaveLength(1);
    const r = t.resolve("A", "7", "selected", "ok", "user");
    expect(r.closed).toBe(true);
    expect(t.listForSession("A").filter((e) => e.state === "pending")).toHaveLength(0);
  });

  it("NM-14: two approvals with different requestId are distinct pendings", () => {
    const t = new PendingApprovalTable();
    t.register("A", "codex", req("7"), "A:t1");
    t.register("A", "codex", req("8"), "A:t1");
    expect(t.listForSession("A")).toHaveLength(2);
  });

  it("NM-15: requestId preserved on entry", () => {
    const t = new PendingApprovalTable();
    const e = t.register("A", "codex", req("7"), "A:t1");
    expect(e.requestId).toBe("7");
    expect(e.request.id).toBe("7");
  });
});

describe("pending-approval-table — (sessionHandle, requestId) collision (NM-15b)", () => {
  it("two runtimes sharing JSON-RPC id 7 stay independent; resolving A leaves B", () => {
    const t = new PendingApprovalTable();
    t.register("A", "codex", req("7"), "A:t1");
    t.register("B", "claude", req("7"), "B:t1");
    // 키가 (sessionHandle, requestId)라 별개 엔트리
    expect(pendingKey("A", "7")).not.toBe(pendingKey("B", "7"));
    const r = t.resolve("A", "7", "selected", "ok", "user");
    expect(r.closed).toBe(true);
    // B의 "7"은 그대로 pending — 오응답 없음
    const b = t.get("B", "7");
    expect(b?.state).toBe("pending");
  });
});

describe("pending-approval-table — cancel cleanup (NM-16, 04 §4.2)", () => {
  it("NM-16: turn cancel closes pending as cancelled", () => {
    const t = new PendingApprovalTable();
    t.register("A", "codex", req("7"), "A:t1");
    const results = t.cancelTurn("A", "A:t1");
    expect(results).toHaveLength(1);
    expect(results[0].decision?.outcome).toBe("cancelled");
    expect(t.get("A", "7")?.state).toBe("closed");
  });
});

describe("pending-approval-table — exit/shutdown idempotency (NM-18..NM-18d)", () => {
  it("NM-18: process exit closes all pending as failed", () => {
    const t = new PendingApprovalTable();
    t.register("A", "codex", req("7"), "A:t1");
    t.register("A", "codex", req("8"), "A:t1");
    const results = t.closeAllOnExit("A");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.decision?.outcome === "failed")).toBe(true);
  });

  it("NM-18c: shutdown-cancel then late exit is idempotent (exactly once)", () => {
    const t = new PendingApprovalTable();
    t.register("A", "codex", req("7"), "A:t1");
    const first = t.closeAllOnShutdown("A");
    expect(first).toHaveLength(1);
    expect(first[0].decision?.outcome).toBe("cancelled");
    // 늦은 exit 도착 → 이미 closed → 재차 닫히지 않음(정확히 1회)
    const late = t.closeAllOnExit("A");
    expect(late).toHaveLength(0);
  });

  it("NM-18d: shutdown with no pending then late exit is a no-op", () => {
    const t = new PendingApprovalTable();
    expect(t.closeAllOnShutdown("A")).toHaveLength(0);
    expect(t.closeAllOnExit("A")).toHaveLength(0);
  });
});

describe("pending-approval-table — serverRequest/resolved + failed-not-on-wire (NM-19, NM-20)", () => {
  it("NM-19: resolve closes only the matching requestId", () => {
    const t = new PendingApprovalTable();
    t.register("A", "codex", req("7"), "A:t1");
    t.register("A", "codex", req("9"), "A:t1");
    t.resolve("A", "7", "selected", "ok", "user");
    expect(t.get("A", "7")?.state).toBe("closed");
    expect(t.get("A", "9")?.state).toBe("pending");
  });

  it("late resolve after close is idempotently ignored", () => {
    const t = new PendingApprovalTable();
    t.register("A", "codex", req("7"), "A:t1");
    expect(t.resolve("A", "7", "selected", "ok", "user").closed).toBe(true);
    expect(t.resolve("A", "7", "selected", "ok", "user").closed).toBe(false);
  });
});
