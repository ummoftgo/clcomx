/**
 * Claude ACP 어댑터 — content block 매핑(06 §7).
 *
 * - toAcpPromptContent: CLCOMX AgentContent[](15 §4) → ACP ContentBlock[](composer → session/prompt).
 * - mapContentBlock: ACP ContentBlock(수신) → AgentContent(15 §4).
 * - mapToolCallContent: ACP ToolCallContent(content/diff/terminal) → AgentContent.
 * - mapToolKind: ACP ToolKind 10종 → CLCOMX 9종(switch_mode→other).
 * - buildUnifiedDiff: Diff{oldText,newText} → unified patch(어댑터가 생성).
 */

import type { AgentContent, ToolCallUpdate } from "../../contracts/normalized";
import type {
  AcpContentBlock,
  AcpToolCallContent,
  AcpToolKind,
} from "../../contracts/claude-acp";

/**
 * ACP ContentBlock → CLCOMX AgentContent(15 §4, ref-acp §13.2).
 * - image: base64 data → data URI(`data:<mime>;base64,...`, OQ-12).
 * - audio: 모델에 없음 → json raw 보존(v1 미지원, 13 OQ-04 해소).
 * - resource_link / resource(text|blob) → {type:"resource"}.
 */
export function mapContentBlock(block: AcpContentBlock): AgentContent {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image": {
      // base64 data → data URI(OQ-12). uri가 있으면 우선 사용.
      const uri = block.uri ?? `data:${block.mimeType};base64,${block.data}`;
      return { type: "image", uri, mimeType: block.mimeType };
    }
    case "audio":
      // CLCOMX 모델에 audio 없음 → raw 보존(json). text delta 경로로 새지 않게 별도 type으로 둔다.
      return { type: "json", value: block };
    case "resource_link":
      return {
        type: "resource",
        uri: block.uri,
        ...(block.mimeType ? { mimeType: block.mimeType } : {}),
      };
    case "resource": {
      const res = block.resource;
      const out: AgentContent = {
        type: "resource",
        uri: res.uri,
        ...(res.mimeType ? { mimeType: res.mimeType } : {}),
      };
      // embedded text는 text 필드로 보존. blob은 raw 보존(text 없음).
      if ("text" in res && typeof res.text === "string") {
        return { ...out, text: res.text };
      }
      return out;
    }
    default:
      // 미지의 content type — json으로 raw 보존(crash 방지).
      return { type: "json", value: block };
  }
}

/**
 * CLCOMX AgentContent → ACP ContentBlock(prompt 송신, ref-acp §4).
 * 게이트는 호출부에서 promptCapabilities로 확인(§7.1). 여기서는 형식 변환만 한다.
 */
export function toAcpPromptContent(content: AgentContent[]): AcpContentBlock[] {
  const out: AcpContentBlock[] = [];
  for (const c of content) {
    switch (c.type) {
      case "text":
        out.push({ type: "text", text: c.text });
        break;
      case "image": {
        // data URI면 base64 추출, 아니면 uri만(어댑터는 base64 data 필요).
        const parsed = parseDataUri(c.uri);
        if (parsed) {
          out.push({ type: "image", data: parsed.data, mimeType: c.mimeType ?? parsed.mimeType });
        } else {
          // base64를 추출 못 하면 uri를 resource_link로 보낸다(absolute 가정, §7.3).
          out.push({ type: "resource_link", name: c.uri, uri: c.uri });
        }
        break;
      }
      case "resource":
        if (typeof c.text === "string") {
          out.push({
            type: "resource",
            resource: { uri: c.uri, mimeType: c.mimeType ?? null, text: c.text },
          });
        } else {
          out.push({ type: "resource_link", name: c.uri, uri: c.uri, mimeType: c.mimeType ?? null });
        }
        break;
      case "diff":
        // diff/terminal/json은 prompt content로 거의 안 쓰이나 방어적으로 text로 직렬화.
        out.push({ type: "text", text: c.patch });
        break;
      case "terminal":
        out.push({ type: "text", text: c.output });
        break;
      case "json":
        out.push({ type: "text", text: JSON.stringify(c.value) });
        break;
    }
  }
  return out;
}

/** data URI(`data:<mime>;base64,<data>`)에서 mime/data 추출. 아니면 null. */
function parseDataUri(uri: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(uri);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

/**
 * ACP ToolCallContent → CLCOMX AgentContent(ref-acp §13.5).
 * - content: 내부 ContentBlock 재귀 매핑.
 * - diff{path,oldText,newText} → {type:"diff", path, patch}(어댑터가 unified patch 생성, oldText=null→신규).
 * - terminal: terminalId만 옴(client terminal 미광고, 1차) → output 비움(추후 조회).
 */
export function mapToolCallContent(tc: AcpToolCallContent): AgentContent {
  switch (tc.type) {
    case "content":
      return mapContentBlock(tc.content);
    case "diff":
      // oldText/newText로 unified patch 생성. oldText=null이면 신규 파일.
      return { type: "diff", path: tc.path, patch: buildUnifiedDiff(tc.path, tc.oldText ?? null, tc.newText) };
    case "terminal":
      // 1차는 client terminal 미광고 → output 미조회. terminalId는 raw로만(추후 capability 켤 때 조회).
      return { type: "terminal", output: "" };
    default:
      return { type: "json", value: tc };
  }
}

/** ACP ToolKind 10종 → CLCOMX 9종(15 §5). switch_mode→other(ref-acp §13.3). */
export function mapToolKind(kind: AcpToolKind | undefined): ToolCallUpdate["kind"] {
  switch (kind) {
    case "read":
    case "edit":
    case "delete":
    case "move":
    case "search":
    case "execute":
    case "think":
    case "fetch":
    case "other":
      return kind;
    case "switch_mode":
      // CLCOMX 모델에 switch_mode 없음 → other(ref-acp §13.3).
      return "other";
    default:
      return "other";
  }
}

/**
 * Diff{oldText,newText} → unified diff patch 생성(어댑터 책임, 15 §4).
 * 간단한 LCS 미사용 라인 단위 diff — 전체 old 블록 삭제 + 전체 new 블록 추가 형태로 생성한다.
 * oldText=null이면 신규 파일(--- /dev/null).
 */
export function buildUnifiedDiff(path: string, oldText: string | null, newText: string): string {
  const oldLines = oldText === null ? [] : splitLines(oldText);
  const newLines = splitLines(newText);
  const fromHeader = oldText === null ? "--- /dev/null" : `--- a/${path}`;
  const toHeader = `+++ b/${path}`;
  // hunk 헤더: old 시작 1, old 개수, new 시작 1, new 개수.
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const oldStart = oldCount === 0 ? 0 : 1;
  const newStart = newCount === 0 ? 0 : 1;
  const hunk = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  const body = [
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ];
  return [fromHeader, toHeader, hunk, ...body].join("\n");
}

/** 라인 분리(끝 개행 보존하지 않고 라인 배열만). 빈 문자열은 빈 배열. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  // 마지막 개행은 trailing 빈 라인을 만들지 않도록 처리.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
