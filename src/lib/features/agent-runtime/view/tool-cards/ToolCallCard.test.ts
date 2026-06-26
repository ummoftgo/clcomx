/**
 * ToolCallCard 렌더 테스트(T5.3) — kind별 분기·collapsed/expanded 토글·command/diff embed(08 §4, 11 §6).
 */

import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { initializeI18n } from "../../../../i18n";
import { TEST_IDS } from "../../../../testids";
import type { ToolCallUpdate } from "../../contracts/normalized";
import ToolCallCard from "./ToolCallCard.svelte";

function executeUpdate(extra: Partial<ToolCallUpdate> = {}): ToolCallUpdate {
  return {
    id: "tc-1",
    kind: "execute",
    status: "completed",
    title: "run build",
    content: [{ type: "terminal", command: "npm run build", output: "build ok\n" }],
    ...extra,
  };
}

describe("ToolCallCard", () => {
  beforeEach(() => {
    initializeI18n("en", "en-US");
  });

  it("renders the kind label and summary in collapsed state", () => {
    const { getByTestId, queryByTestId } = render(ToolCallCard, {
      props: { id: "tc-1", update: executeUpdate(), expanded: false },
    });
    expect(getByTestId(TEST_IDS.agentToolCallCard)).toBeTruthy();
    // collapsed: command output embed not yet mounted.
    expect(queryByTestId(TEST_IDS.agentCommandOutputCard)).toBeNull();
  });

  it("expands to show command output embed on header click", async () => {
    const { getByTestId, findByTestId } = render(ToolCallCard, {
      props: { id: "tc-1", update: executeUpdate(), expanded: false },
    });
    await fireEvent.click(getByTestId(TEST_IDS.agentToolCallToggle));
    const embed = await findByTestId(TEST_IDS.agentCommandOutputCard);
    expect(embed.textContent).toContain("build ok");
  });

  it("renders command output embed without a focusable/interactive element (no shortcut interception)", async () => {
    const { getByTestId, findByTestId } = render(ToolCallCard, {
      props: { id: "tc-1", update: executeUpdate(), expanded: true },
    });
    const output = await findByTestId(TEST_IDS.agentCommandOutput);
    // read-only 렌더: tabindex/contenteditable 없음 → 포커스·키 입력 비가로채기.
    expect(output.getAttribute("tabindex")).toBeNull();
    expect(output.getAttribute("contenteditable")).toBeNull();
    expect(getByTestId(TEST_IDS.agentCommandOutputCard)).toBeTruthy();
  });

  it("merges a file change into a single FileDiffCard for edit kind", async () => {
    const update = executeUpdate({
      id: "tc-2",
      kind: "edit",
      content: undefined,
      title: "edit file",
    });
    const { getByTestId, findByTestId } = render(ToolCallCard, {
      props: {
        id: "tc-2",
        update,
        expanded: true,
        fileChange: {
          path: "src/a.ts",
          operation: "update",
          diff: "--- a\n+++ b\n+added line\n-removed line\n",
        },
      },
    });
    const diff = await findByTestId(TEST_IDS.agentFileDiffCard);
    expect(diff.textContent).toContain("src/a.ts");
    // diffstat: +1 / -1.
    expect(diff.textContent).toContain("+1");
    expect(diff.textContent).toContain("-1");
    expect(getByTestId(TEST_IDS.agentToolCallCard)).toBeTruthy();
  });

  it("hides expand affordance when there is nothing more to show", () => {
    const update = executeUpdate({
      id: "tc-3",
      kind: "other",
      content: undefined,
      locations: undefined,
      rawOutput: undefined,
      title: "noop",
    });
    const { getByTestId } = render(ToolCallCard, {
      props: { id: "tc-3", update, expanded: false },
    });
    const toggle = getByTestId(TEST_IDS.agentToolCallToggle) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });
});
