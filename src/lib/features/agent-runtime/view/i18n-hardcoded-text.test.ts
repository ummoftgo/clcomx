/**
 * Agent runtime view i18n guard(FE-13).
 *
 * Svelte markup에 새 사용자 노출 문자열을 직접 쓰지 않고 locale key를 쓰는지 확인한다.
 */

import { describe, expect, it } from "vitest";

const svelteSources = import.meta.glob("./**/*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** script/style/comment를 제거해 markup text 검출 노이즈를 줄인다. */
function extractMarkup(source: string): string {
  return source
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** raw text node 후보를 수집한다. */
function findRawTextNodes(markup: string): string[] {
  return [...markup.matchAll(/>([^<>{]+)</g)]
    .map((match) => match[1].replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0 && /\p{L}/u.test(text));
}

/** 사용자에게 읽히는 literal attribute 후보를 수집한다. */
function findRawUserTextAttributes(markup: string): string[] {
  return [...markup.matchAll(/\s(aria-label|title|placeholder)="([^"]*\p{L}[^"]*)"/gu)].map(
    (match) => `${match[1]}="${match[2]}"`,
  );
}

describe("agent runtime view i18n guard", () => {
  it("does not hardcode user-facing text in Svelte markup", () => {
    const violations = Object.entries(svelteSources).flatMap(([file, source]) => {
      const markup = extractMarkup(source);
      return [...findRawTextNodes(markup), ...findRawUserTextAttributes(markup)].map(
        (text) => `${file}: ${text}`,
      );
    });

    expect(violations).toEqual([]);
  });
});
