type JsonObject = Record<string, unknown>;

/** OQ-53 raw debug log에서 종료 신호 뒤 도착한 same-turn 후보 한 건을 표현한다. */
export interface SameTurnLateEventProbe {
  /** provider 계열. */
  provider: "codex" | "claude-acp";
  /** provider별 turn/session 식별자. */
  turnKey: string;
  /** 종료 신호의 inbound seq. */
  terminalSeq: number;
  /** 종료 신호 method 또는 response 분류. */
  terminalMethod: string;
  /** 종료 뒤 도착한 inbound seq. */
  lateSeq: number;
  /** 종료 뒤 도착한 notification method. */
  lateMethod: string;
}

/** OQ-53 판정에서 실제로 관측한 종료 신호 한 건을 표현한다. */
export interface SameTurnTerminalMarkerProbe {
  /** provider 계열. */
  provider: "codex" | "claude-acp";
  /** provider별 turn/session 식별자. */
  turnKey: string;
  /** 종료 신호의 inbound seq. */
  terminalSeq: number;
  /** 종료 신호 method 또는 response 분류. */
  terminalMethod: string;
}

/** raw protocol debug log 분석 결과. */
export interface RawProtocolDebugLogAnalysis {
  /** no-late 판정의 전제가 되는 종료 신호 목록. */
  terminalMarkers: SameTurnTerminalMarkerProbe[];
  /** 종료 신호 뒤 같은 turn/session에 도착한 notification 후보. */
  lateEvents: SameTurnLateEventProbe[];
}

interface ParsedDebugEntry {
  order: number;
  seq?: number;
  direction: "in" | "out";
  message: JsonObject;
}

interface TerminalMarker {
  order: number;
  seq: number;
  method: string;
}

interface AcpPromptRequest {
  requestId: string;
  sessionId: string;
}

/**
 * opt-in raw protocol debug JSONL을 분석해 OQ-53 same-turn late notification 후보를 찾는다.
 *
 * @param jsonl `agent-runtime-debug.log` 내용.
 * @returns provider별 종료 신호 이후 같은 routing key로 도착한 inbound notification 목록.
 */
export function analyzeRawProtocolDebugLog(jsonl: string): RawProtocolDebugLogAnalysis {
  const terminalMarkers: SameTurnTerminalMarkerProbe[] = [];
  const lateEvents: SameTurnLateEventProbe[] = [];
  const codexTerminalByTurn = new Map<string, TerminalMarker>();
  const acpPromptById = new Map<string, AcpPromptRequest>();
  const acpTerminalBySession = new Map<string, TerminalMarker & { requestId: string }>();

  for (const entry of parseDebugEntries(jsonl)) {
    if (entry.direction === "out") {
      const method = stringField(entry.message, "method");
      const params = objectField(entry.message, "params");
      const id = idField(entry.message);
      const sessionId = params ? stringField(params, "sessionId") : undefined;
      if (method === "session/prompt" && id !== undefined && sessionId) {
        const requestId = String(id);
        acpPromptById.set(idKey(id), { requestId, sessionId });
        // 새 prompt가 시작되면 이전 prompt의 종료 후 late 판정 범위는 닫는다.
        acpTerminalBySession.delete(sessionId);
      }
      continue;
    }

    if (entry.seq === undefined) {
      continue;
    }

    const method = stringField(entry.message, "method");
    const params = objectField(entry.message, "params");
    if (method && params) {
      const codexKey = codexTurnKey(params);
      if (codexKey && method === "turn/completed") {
        codexTerminalByTurn.set(codexKey, {
          order: entry.order,
          seq: entry.seq,
          method,
        });
        terminalMarkers.push({
          provider: "codex",
          turnKey: codexKey,
          terminalSeq: entry.seq,
          terminalMethod: method,
        });
      } else if (codexKey) {
        const terminal = codexTerminalByTurn.get(codexKey);
        if (terminal && entry.order > terminal.order) {
          lateEvents.push({
            provider: "codex",
            turnKey: codexKey,
            terminalSeq: terminal.seq,
            terminalMethod: terminal.method,
            lateSeq: entry.seq,
            lateMethod: method,
          });
        }
      }

      if (method === "session/update") {
        const sessionId = stringField(params, "sessionId");
        const terminal = sessionId ? acpTerminalBySession.get(sessionId) : undefined;
        if (sessionId && terminal && entry.order > terminal.order) {
          lateEvents.push({
            provider: "claude-acp",
            turnKey: `claude-acp:${sessionId}:request:${terminal.requestId}`,
            terminalSeq: terminal.seq,
            terminalMethod: terminal.method,
            lateSeq: entry.seq,
            lateMethod: acpUpdateMethod(params),
          });
        }
      }
    }

    const id = idField(entry.message);
    const result = objectField(entry.message, "result");
    const prompt = id === undefined ? undefined : acpPromptById.get(idKey(id));
    if (prompt && result && stringField(result, "stopReason")) {
      const turnKey = `claude-acp:${prompt.sessionId}:request:${prompt.requestId}`;
      acpTerminalBySession.set(prompt.sessionId, {
        requestId: prompt.requestId,
        order: entry.order,
        seq: entry.seq,
        method: "session/prompt:response",
      });
      terminalMarkers.push({
        provider: "claude-acp",
        turnKey,
        terminalSeq: entry.seq,
        terminalMethod: "session/prompt:response",
      });
    }
  }

  return { terminalMarkers, lateEvents };
}

/** debug JSONL을 parse 가능한 항목만 보존한다. inbound seq는 로그에 있을 때만 신뢰한다. */
function parseDebugEntries(jsonl: string): ParsedDebugEntry[] {
  const entries: ParsedDebugEntry[] = [];
  const lines = jsonl.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const envelope = parseJsonObject(raw);
    if (!envelope) continue;
    const direction = stringField(envelope, "direction");
    if (direction !== "in" && direction !== "out") continue;
    const message = parseMessageLine(envelope.line);
    if (!message) continue;
    entries.push({
      order: i,
      seq: positiveIntegerField(envelope, "seq"),
      direction,
      message,
    });
  }
  return entries;
}

/** Codex thread/turn params를 분석 key로 정규화한다. */
function codexTurnKey(params: JsonObject): string | undefined {
  const threadId = stringField(params, "threadId");
  const turn = objectField(params, "turn");
  const turnId = stringField(params, "turnId") ?? (turn ? stringField(turn, "id") : undefined);
  if (!threadId || !turnId) return undefined;
  return `codex:${threadId}:${turnId}`;
}

/** ACP session/update 종류를 사람이 읽을 수 있는 method로 정규화한다. */
function acpUpdateMethod(params: JsonObject): string {
  const update = objectField(params, "update");
  const kind = update ? stringField(update, "sessionUpdate") : undefined;
  return kind ? `session/update:${kind}` : "session/update";
}

/** JSON-RPC id를 Map key로 안정화한다. */
function idKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

/** JSON-RPC id를 문자열 또는 숫자로 읽는다. */
function idField(value: JsonObject): string | number | undefined {
  const id = value.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/** object field를 안전하게 읽는다. */
function objectField(value: JsonObject, key: string): JsonObject | undefined {
  const field = value[key];
  return isObject(field) ? field : undefined;
}

/** string field를 안전하게 읽는다. */
function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

/** number field를 안전하게 읽는다. */
function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

/** 1-based 정수 seq field를 읽는다. */
function positiveIntegerField(value: JsonObject, key: string): number | undefined {
  const field = numberField(value, key);
  return field !== undefined && Number.isInteger(field) && field > 0 ? field : undefined;
}

/** envelope.line을 JSON-RPC object로 parse한다. */
function parseMessageLine(value: unknown): JsonObject | undefined {
  if (typeof value === "string") return parseJsonObject(value);
  return isObject(value) ? value : undefined;
}

/** JSON 문자열을 object로 parse한다. */
function parseJsonObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** null/array가 아닌 object인지 확인한다. */
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
