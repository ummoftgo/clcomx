/**
 * Claude ACP fixture replay 테스트(11 §1, FR-CL-0..4).
 *
 * NDJSON {direction,message}를 JSON-RPC 왕복 순서대로 재생해 AgentEvent[]를 검증한다.
 * ACP fixture는 client→agent request(out)의 id/method를 기억해야 response(in)를 lifecycle로 복원할 수 있다.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../contracts/normalized";
import type { AcpSessionUpdate } from "../../contracts/claude-acp";
import type { JsonRpcId, JsonRpcMessage } from "../../service/transport";
import { parseFixture } from "../replay-harness";
import { mapRequestPermission } from "./claude-acp-permission";
import { mapSessionUpdate, type SessionUpdateRuntime } from "./claude-acp-session-update";
import { mapClaudeStopReason } from "./claude-acp-stop-reason";

// fixture 본문(.jsonl)과 기대(.expected.json)를 빌드타임에 로드한다.
const jsonlFiles = import.meta.glob("../__fixtures__/claude-acp/*.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const expectedFiles = import.meta.glob("../__fixtures__/claude-acp/*.expected.json", {
  import: "default",
  eager: true,
}) as Record<string, AgentEvent[]>;

/** JSON-RPC request id 중 pending map key로 쓸 수 있는 값. */
type PendingId = Exclude<JsonRpcId, null>;

/** client→agent request 응답을 해석하기 위한 pending request 스냅샷. */
interface PendingClientRequest {
  /** 원본 JSON-RPC method. */
  method: string;
  /** 원본 request params. */
  params?: unknown;
}

/** fixture replay가 유지하는 최소 ACP 런타임 상태. */
interface FixtureRuntime extends SessionUpdateRuntime {
  /** out request id → method/params. */
  pendingRequests: Map<PendingId, PendingClientRequest>;
}

/** glob 키에서 fixture 이름(확장자 제외)을 추출한다. */
function baseName(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.(jsonl|expected\.json)$/, "");
}

/** replay용 최소 런타임 상태를 만든다. */
function makeRuntime(): FixtureRuntime {
  return {
    unknownCounter: 0,
    pendingRequests: new Map(),
  };
}

/** id가 pending request key로 보존 가능한 string|number인지 확인한다. */
function isPendingId(id: JsonRpcId | undefined): id is PendingId {
  return typeof id === "string" || typeof id === "number";
}

/** message가 client→agent request인지 확인한다. */
function isClientRequest(message: JsonRpcMessage): message is JsonRpcMessage & { id: PendingId; method: string } {
  return "method" in message && "id" in message && isPendingId(message.id);
}

/** message가 agent→client response인지 확인한다. */
function isResponse(message: JsonRpcMessage): message is JsonRpcMessage & { id: PendingId; result: unknown } {
  return "result" in message && "id" in message && isPendingId(message.id);
}

/** message가 server notification/request인지 확인한다. */
function hasMethod(message: JsonRpcMessage): message is JsonRpcMessage & { method: string; params?: unknown } {
  return "method" in message;
}

/** session/update params에서 sessionId/update를 방어적으로 추출한다. */
function readSessionUpdateParams(params: unknown): { sessionId?: string; update?: unknown } {
  if (!params || typeof params !== "object") return {};
  const rec = params as Record<string, unknown>;
  return {
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : undefined,
    update: rec.update,
  };
}

/** session/new request params에서 cwd를 추출한다. */
function readCwd(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const cwd = (params as Record<string, unknown>).cwd;
  return typeof cwd === "string" ? cwd : "";
}

/** result에서 sessionId를 추출한다. */
function readSessionId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const sessionId = (result as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

/** result에서 stopReason을 추출한다. */
function readStopReason(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  return (result as Record<string, unknown>).stopReason;
}

/** client→agent response를 pending request method 기준으로 AgentEvent[]로 변환한다. */
function mapClientResponse(rt: FixtureRuntime, req: PendingClientRequest, result: unknown): AgentEvent[] {
  switch (req.method) {
    case "initialize":
      return [];
    case "session/new": {
      rt.providerSessionId = readSessionId(result);
      const ref = { provider: "claude" as const, sessionId: rt.providerSessionId };
      return [
        { type: "session_started", ref, cwd: readCwd(req.params) },
        { type: "session_status_changed", ref, status: "ready" },
      ];
    }
    case "session/load":
    case "session/resume":
      return [{ type: "session_loaded", ref: { provider: "claude", sessionId: rt.providerSessionId } }];
    case "session/prompt":
      return mapClaudeStopReason(rt, readStopReason(result));
    default:
      return [];
  }
}

/** server notification/request를 AgentEvent[]로 변환한다. */
function mapServerMessage(rt: FixtureRuntime, message: JsonRpcMessage & { method: string; params?: unknown }): AgentEvent[] {
  if (message.method === "session/update") {
    const params = readSessionUpdateParams(message.params);
    if (params.sessionId) rt.providerSessionId = params.sessionId;
    if (!params.update) return [];
    return mapSessionUpdate(rt, params.update as AcpSessionUpdate);
  }
  if (message.method === "session/request_permission" && "id" in message && isPendingId(message.id)) {
    const { event } = mapRequestPermission(rt, message);
    return [
      { type: "session_status_changed", ref: event.ref, status: "requires_action" },
      event,
    ];
  }
  return [];
}

/** Claude ACP fixture 본문을 AgentEvent[]로 재생한다. */
function replayClaudeFixture(jsonlText: string): AgentEvent[] {
  const rt = makeRuntime();
  const events: AgentEvent[] = [];
  for (const { direction, message } of parseFixture(jsonlText)) {
    if (direction === "out") {
      if (isClientRequest(message)) {
        rt.pendingRequests.set(message.id, {
          method: message.method,
          params: "params" in message ? message.params : undefined,
        });
      }
      continue;
    }

    if (isResponse(message)) {
      const req = rt.pendingRequests.get(message.id);
      if (!req) continue;
      rt.pendingRequests.delete(message.id);
      events.push(...mapClientResponse(rt, req, message.result));
      continue;
    }

    if (hasMethod(message)) {
      events.push(...mapServerMessage(rt, message));
    }
  }
  return events;
}

/** 이름 → {jsonl 본문, expected} 매핑을 만든다. */
const fixtures = new Map<string, { jsonl: string; expected?: AgentEvent[] }>();
for (const [path, text] of Object.entries(jsonlFiles)) {
  fixtures.set(baseName(path), { jsonl: text });
}
for (const [path, expected] of Object.entries(expectedFiles)) {
  const name = baseName(path);
  const cur = fixtures.get(name);
  if (cur) cur.expected = expected;
}

describe("claude ACP fixture replay (FR-CL-0..4)", () => {
  for (const [name, { jsonl, expected }] of fixtures) {
    it(`${name} → expected AgentEvent[]`, () => {
      const events = replayClaudeFixture(jsonl);
      expect(expected, `missing ${name}.expected.json`).toBeDefined();
      expect(events).toEqual(expected);
    });
  }

  it("FR-CL-4: permission request keeps numeric rpc id as string request key", () => {
    const events = replayClaudeFixture(fixtures.get("claude-tool-call-permission")!.jsonl);
    const approval = events.find((e) => e.type === "approval_requested") as Extract<AgentEvent, { type: "approval_requested" }>;
    expect(approval.ref.requestId).toBe("42");
    expect(approval.request.id).toBe("42");
  });
});

describe("adapter fixture corpus hygiene (FR-CX/FR-CL redaction)", () => {
  const fixtureCorpus = import.meta.glob("../__fixtures__/**/*.{jsonl,json}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  it("all JSONL/JSON fixtures are parseable and do not contain secret-shaped values", () => {
    const secretPatterns = [
      /AKIA[0-9A-Z]{16}/,
      /ghp_[A-Za-z0-9_]{20,}/,
      /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
      /"Authorization"\s*:/i,
      /"Cookie"\s*:/i,
      /(?:password|passwd|api[_-]?key|auth[_-]?token|resume[_-]?token)["']?\s*[:=]\s*["'][^"']{6,}/i,
      /provider(?:Session|Thread|Resume)Token/i,
    ];

    for (const [path, text] of Object.entries(fixtureCorpus)) {
      if (path.endsWith(".jsonl")) {
        expect(() => parseFixture(text), `${path} is valid JSONL`).not.toThrow();
      } else {
        expect(() => JSON.parse(text), `${path} is valid JSON`).not.toThrow();
      }
      for (const pattern of secretPatterns) {
        expect(text, `${path} contains secret-shaped fixture data: ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
