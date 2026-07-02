/**
 * i18n key 누락 방지(en/ko 키 트리 1:1) — Stage 2 T5.5.
 *
 * en/ko locale의 키 트리가 완전히 동일한지(추가/누락 0) 검증한다. agentRuntime.* 네임스페이스를
 * 포함한 전체 트리를 평탄화해 키 집합을 비교한다(08 §8 i18n namespace, 하드코딩 금지 보강).
 */

import { describe, expect, it } from "vitest";
import en from "./locales/en";
import ko from "./locales/ko";

/** 중첩 객체를 dot-path 키 집합으로 평탄화한다(leaf만 수집). */
function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(...flattenKeys(v, path));
  }
  return out;
}

describe("i18n key parity (en/ko 1:1)", () => {
  const enKeys = new Set(flattenKeys(en));
  const koKeys = new Set(flattenKeys(ko));

  it("has no keys present in en but missing in ko", () => {
    const missingInKo = [...enKeys].filter((k) => !koKeys.has(k));
    expect(missingInKo).toEqual([]);
  });

  it("has no keys present in ko but missing in en", () => {
    const missingInEn = [...koKeys].filter((k) => !enKeys.has(k));
    expect(missingInEn).toEqual([]);
  });

  it("covers all Stage 2 agentRuntime namespaces", () => {
    // 핵심 신규 네임스페이스가 양쪽에 존재하는지 명시 검증(approval/toolKind/fallback/replay).
    const required = [
      "agentRuntime.approval.title",
      "agentRuntime.approval.command",
      "agentRuntime.approval.fileChange",
      "agentRuntime.approval.allowOnce",
      "agentRuntime.toolKind.execute",
      "agentRuntime.fallback.legacyNotice",
      "agentRuntime.replay.affordance",
      "agentRuntime.replay.truncated",
      "agentRuntime.transcript.historyReadOnly",
      "agentRuntime.command.stdoutLabel",
      "agentRuntime.diff.updated",
    ];
    for (const key of required) {
      expect(enKeys.has(key), `en missing ${key}`).toBe(true);
      expect(koKeys.has(key), `ko missing ${key}`).toBe(true);
    }
  });
});
