import { describe, expect, it, vi } from "vitest";
vi.mock("../../../tauri/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
import { invoke } from "../../../tauri/core";
import {
  serializeTranscript,
  deserializeTranscript,
  saveTranscriptCache,
  loadTranscriptCache,
  clearTranscriptCache,
  type TranscriptCacheSnapshot,
} from "./transcript-cache";
import { createEmptyTranscriptModel, applyEvent } from "../controller/agent-event-reducer";
import type { TranscriptItem, TranscriptModel, TranscriptTurnState } from "../contracts/transcript";

describe("transcript-cache 직렬화", () => {
  it("Map↔array 왕복 + visibleItemIds 보존", () => {
    let m = createEmptyTranscriptModel();
    m = applyEvent(m, {
      type: "session_started",
      ref: { provider: "codex", threadId: "A", turnId: "t1" },
      cwd: "/w",
    });
    m = applyEvent(m, {
      type: "agent_message_delta",
      ref: { provider: "codex", threadId: "A", turnId: "t1", itemId: "i1" },
      delta: "hello",
    });
    const snap = serializeTranscript(m);
    expect(snap.schemaVersion).toBe(1);
    const back = deserializeTranscript(snap);
    expect(back).not.toBeNull();
    expect([...back!.itemsById.keys()]).toContain("i1");
    expect(back!.visibleItemIds).toEqual(m.visibleItemIds);
  });

  it("schemaVersion 불일치는 null(무시)", () => {
    expect(deserializeTranscript({ schemaVersion: 99 as 1, visibleItemIds: [], items: [], turns: [] })).toBeNull();
  });

  it("tombstone 강등 turn 본문은 직렬화에서 제외", () => {
    // residency==='evicted-tombstone' turn의 item은 snap.items/turns/visibleItemIds에서 모두 제외되어야 한다.
    const ghostItem: TranscriptItem = {
      type: "message",
      id: "ghost",
      role: "agent",
      content: [{ type: "text", text: "gone" }],
      streaming: false,
      ref: { provider: "codex", threadId: "A", turnId: "t0" },
    };
    const keepItem: TranscriptItem = {
      type: "message",
      id: "keep",
      role: "agent",
      content: [{ type: "text", text: "still here" }],
      streaming: false,
      ref: { provider: "codex", threadId: "A", turnId: "t1" },
    };
    const tombstoneTurn: TranscriptTurnState = {
      residency: "evicted-tombstone",
      itemIds: ["ghost"],
      terminated: true,
      openItemCount: 0,
      pendingRequestCount: 0,
      resealCount: 0,
    };
    const sealedTurn: TranscriptTurnState = {
      residency: "sealed-retained",
      itemIds: ["keep"],
      terminated: true,
      openItemCount: 0,
      pendingRequestCount: 0,
      resealCount: 0,
    };
    const model: TranscriptModel = {
      visibleItemIds: ["ghost", "keep"],
      itemVersions: { ghost: 1, keep: 1 },
      itemsById: new Map([
        ["ghost", ghostItem],
        ["keep", keepItem],
      ]),
      turnsById: new Map([
        ["t0", tombstoneTurn],
        ["t1", sealedTurn],
      ]),
      tombstones: { lru: ["t0"], droppedLateEventCount: 0 },
    };

    const snap = serializeTranscript(model);

    const itemKeys = snap.items.map(([id]) => id);
    expect(itemKeys).toContain("keep");
    expect(itemKeys).not.toContain("ghost");

    const turnKeys = snap.turns.map(([id]) => id);
    expect(turnKeys).toContain("t1");
    expect(turnKeys).not.toContain("t0");

    expect(snap.visibleItemIds).toContain("keep");
    expect(snap.visibleItemIds).not.toContain("ghost");
  });

  it("credential 문자열이 포함된 item은 직렬화 시 실제로 redact됨", () => {
    // sk-ant-* 패턴과 Authorization 헤더를 포함한 message item을 직렬화하면
    // 스냅샷에 실제 secret이 없고 [REDACTED] 마커가 나타남을 검증한다.
    const secretToken = "sk-ant-v7xHxE7h2j9Ks5mP2qZx8uW4rN3yJqT6vB1lF8wX";
    const secretHeader = "Authorization: Bearer sk-ant-xxxxxxxxxxxxxxxx";
    const secretApiKey = "api_key=sk-abc123defghij789";

    const credentialItem: TranscriptItem = {
      type: "message",
      id: "secret",
      role: "agent",
      content: [
        {
          type: "text",
          text: `Config: ${secretToken} and Header: ${secretHeader} and ${secretApiKey}`,
        },
      ],
      streaming: false,
      ref: { provider: "codex", threadId: "A", turnId: "t1" },
    };

    const model: TranscriptModel = {
      visibleItemIds: ["secret"],
      itemVersions: { secret: 1 },
      itemsById: new Map([["secret", credentialItem]]),
      turnsById: new Map([
        [
          "t1",
          {
            residency: "sealed-retained",
            itemIds: ["secret"],
            terminated: true,
            openItemCount: 0,
            pendingRequestCount: 0,
            resealCount: 0,
          },
        ],
      ]),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };

    const snap = serializeTranscript(model);

    // 스냅샷에서 직렬화된 item 조회
    const secretSnapshot = snap.items.find(([id]) => id === "secret");
    expect(secretSnapshot).toBeDefined();

    const snapshotItem = secretSnapshot![1];
    expect(snapshotItem.type).toBe("message");
    if (snapshotItem.type !== "message") throw new Error("expected message item");
    const messageContent = snapshotItem.content[0] as any;
    const redactedText = messageContent.text;

    // 원본 secret이 없음을 검증(실제 치환 증명)
    expect(redactedText).not.toContain(secretToken);
    expect(redactedText).not.toContain("sk-ant-xxxxxxxxxxxxxxxx");
    expect(redactedText).not.toContain("sk-abc123defghij789");

    // [REDACTED] 마커가 있음을 검증(redaction이 일어남)
    expect(redactedText).toContain("[REDACTED]");
  });

  it("credential 모양이 아닌 env 값도 직렬화 시 실제로 마스킹됨(렌더 경로와 동일 강도)", () => {
    // MY_TOKEN=plainsecret12345는 sk-/Bearer/api_key= 같은 credential 패턴에 걸리지 않는다.
    // redactDisplayText만 쓰면 이 값이 캐시에 평문으로 남는다 — scrubEnvValuesForDisplay가
    // env map 값을 전부 [REDACTED]로 치환해야 실제로 가려진다(렌더 경로 stringifyRedactedRaw와 동치).
    const plainEnvSecret = "plainsecret12345";

    const toolCallItem: TranscriptItem = {
      type: "tool_call",
      id: "tc1",
      expanded: false,
      update: {
        id: "call-1",
        kind: "execute",
        status: "completed",
        rawInput: {
          command: "run",
          env: { MY_TOKEN: plainEnvSecret, PATH: "/usr/bin" },
        },
        rawOutput: {
          env: { OTHER_SECRET: plainEnvSecret },
        },
      },
    };

    const model: TranscriptModel = {
      visibleItemIds: ["tc1"],
      itemVersions: { tc1: 1 },
      itemsById: new Map([["tc1", toolCallItem]]),
      turnsById: new Map([
        [
          "t1",
          {
            residency: "sealed-retained",
            itemIds: ["tc1"],
            terminated: true,
            openItemCount: 0,
            pendingRequestCount: 0,
            resealCount: 0,
          },
        ],
      ]),
      tombstones: { lru: [], droppedLateEventCount: 0 },
    };

    const snap = serializeTranscript(model);

    const toolCallSnapshot = snap.items.find(([id]) => id === "tc1");
    expect(toolCallSnapshot).toBeDefined();

    const snapshotItem = toolCallSnapshot![1];
    expect(snapshotItem.type).toBe("tool_call");
    if (snapshotItem.type !== "tool_call") throw new Error("expected tool_call item");

    const rawInput = snapshotItem.update.rawInput as { command: string; env: Record<string, string> };
    const rawOutput = snapshotItem.update.rawOutput as { env: Record<string, string> };

    // env map 값은 마스킹, 키는 보존, 다른 필드(command)는 영향 없음
    expect(rawInput.env.MY_TOKEN).toBe("[REDACTED]");
    expect(rawInput.env.PATH).toBe("[REDACTED]");
    expect(rawInput.command).toBe("run");
    expect(rawOutput.env.OTHER_SECRET).toBe("[REDACTED]");

    // 원본 secret이 스냅샷 전체 어디에도 평문으로 남지 않았음을 증명
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(plainEnvSecret);
  });
});

describe("transcript-cache invoke 래퍼", () => {
  it("커맨드 이름/인자를 그대로 넘긴다", async () => {
    const snap: TranscriptCacheSnapshot = {
      schemaVersion: 1,
      visibleItemIds: [],
      items: [],
      turns: [],
    };
    await saveTranscriptCache("H", snap);
    expect(invoke).toHaveBeenCalledWith("agent_runtime_save_transcript_cache", {
      sessionHandle: "H",
      json: JSON.stringify(snap),
    });

    await loadTranscriptCache("H");
    expect(invoke).toHaveBeenCalledWith("agent_runtime_load_transcript_cache", { sessionHandle: "H" });

    await clearTranscriptCache("H");
    expect(invoke).toHaveBeenCalledWith("agent_runtime_clear_transcript_cache", { sessionHandle: "H" });
  });

  it("로드 결과가 유효한 JSON이면 파싱해 반환한다", async () => {
    const snap: TranscriptCacheSnapshot = {
      schemaVersion: 1,
      visibleItemIds: ["a"],
      items: [],
      turns: [],
    };
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(snap));
    const result = await loadTranscriptCache("H");
    expect(result).toEqual(snap);
  });

  it("로드 결과가 null/파싱 불가면 null을 반환한다", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    expect(await loadTranscriptCache("H")).toBeNull();

    vi.mocked(invoke).mockResolvedValueOnce("not-json");
    expect(await loadTranscriptCache("H")).toBeNull();
  });
});
