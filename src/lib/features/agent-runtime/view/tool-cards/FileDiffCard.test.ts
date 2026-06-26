/**
 * FileDiffCard 렌더 테스트(T5.3) — diff content·diffstat·operation 라벨·rename(08 §4.2).
 */

import { render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { initializeI18n } from "../../../../i18n";
import { TEST_IDS } from "../../../../testids";
import FileDiffCard from "./FileDiffCard.svelte";

describe("FileDiffCard", () => {
  beforeEach(() => {
    initializeI18n("en", "en-US");
  });

  it("renders path and patch lines with diffstat", () => {
    const { getByTestId } = render(FileDiffCard, {
      props: {
        path: "src/main.ts",
        operation: "update",
        patch: "--- a\n+++ b\n+line one\n+line two\n-old line\n",
      },
    });
    const card = getByTestId(TEST_IDS.agentFileDiffCard);
    expect(card.textContent).toContain("src/main.ts");
    expect(card.textContent).toContain("line one");
    // diffstat: 2 additions / 1 removal (헤더 +++/--- 제외).
    expect(card.textContent).toContain("+2");
    expect(card.textContent).toContain("-1");
  });

  it("shows a rename note for move operations", () => {
    const { getByTestId } = render(FileDiffCard, {
      props: {
        path: "src/new.ts",
        operation: "move",
        oldPath: "src/old.ts",
        patch: "",
      },
    });
    expect(getByTestId(TEST_IDS.agentFileDiffCard).textContent).toContain("src/old.ts");
  });

  it("renders an empty notice when there is no patch", () => {
    const { getByTestId } = render(FileDiffCard, {
      props: { path: "src/x.ts", operation: "delete" },
    });
    expect(getByTestId(TEST_IDS.agentFileDiffCard).textContent).toContain("no diff content");
  });
});
