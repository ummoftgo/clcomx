/**
 * ToolCallCard 렌더 테스트(T5.3) — kind별 분기·collapsed/expanded 토글·command/diff embed(08 §4, 11 §6).
 */

import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../../i18n";
import { TEST_IDS, agentToolLocationTestId } from "../../../../testids";
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

  it("redacts credential-like values from the collapsed summary and title", () => {
    const update = executeUpdate({
      id: "tc-secret-summary",
      content: undefined,
      title: undefined,
      locations: [{ path: "Authorization: Bearer account-token-123" }],
    });
    const { getByTestId } = render(ToolCallCard, {
      props: { id: "tc-secret-summary", update, expanded: false },
    });

    const toggle = getByTestId(TEST_IDS.agentToolCallToggle);
    const summary = toggle.querySelector(".tool-summary") as HTMLElement;
    const cardText = getByTestId(TEST_IDS.agentToolCallCard).textContent ?? "";
    expect(cardText).toContain("[REDACTED]");
    expect(cardText).not.toContain("account-token-123");
    expect(summary.getAttribute("title")).toContain("[REDACTED]");
    expect(summary.getAttribute("title")).not.toContain("account-token-123");
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

  it("passes terminal stderr to the collapsed diagnostic output", async () => {
    const update = executeUpdate({
      content: [
        {
          type: "terminal",
          command: "npm run build",
          output: "build ok\n",
          stderr: "Authorization: Bearer account-token-123\n",
        } as any,
      ],
    });
    const { getByText, queryByText, getByTestId } = render(ToolCallCard, {
      props: { id: "tc-1", update, expanded: true },
    });

    expect(queryByText(/account-token-123/)).toBeNull();
    await fireEvent.click(getByText("stderr"));
    const card = getByTestId(TEST_IDS.agentToolCallCard);
    expect(card.textContent).toContain("[REDACTED]");
    expect(card.textContent).not.toContain("account-token-123");
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

  it("renders tool locations in the expanded details", () => {
    const update = executeUpdate({
      id: "tc-locations",
      kind: "read",
      content: undefined,
      title: "read matches",
      locations: [
        { path: "src/lib/example.ts", line: 12, column: 4 },
        { path: "src/lib/other.ts" },
      ],
    });
    const { getByTestId } = render(ToolCallCard, {
      props: { id: "tc-locations", update, expanded: true },
    });

    const cardText = getByTestId(TEST_IDS.agentToolCallCard).textContent ?? "";
    expect(cardText).toContain("src/lib/example.ts:12:4");
    expect(cardText).toContain("src/lib/other.ts");
  });

  it("emits the raw file location when a location row is clicked", async () => {
    const onOpenLocation = vi.fn();
    const location = { path: "src/lib/example.ts", line: 12, column: 4 };
    const update = executeUpdate({
      id: "tc-open-location",
      kind: "read",
      content: undefined,
      title: "read matches",
      locations: [location],
    });
    const { getByTestId } = render(ToolCallCard, {
      props: { id: "tc-open-location", update, expanded: true, onOpenLocation },
    });

    const button = getByTestId(agentToolLocationTestId("tc-open-location", 0));
    expect(button.textContent).toBe("src/lib/example.ts:12:4");
    await fireEvent.click(button);

    expect(onOpenLocation).toHaveBeenCalledWith(location);
  });

  it("renders raw tool details only after redacting credential-like values", () => {
    const update = executeUpdate({
      id: "tc-4",
      kind: "fetch",
      content: undefined,
      title: "fetch data",
      rawInput: {
        url: "https://api.example.test",
        headers: { Authorization: "Bearer account-token-123" },
      },
      rawOutput: {
        ok: true,
        accessKey: "AKIAIOSFODNN7EXAMPLE",
        env: { ANTHROPIC_AUTH_TOKEN: "anth-secret" },
      },
    });
    const { getByTestId } = render(ToolCallCard, {
      props: { id: "tc-4", update, expanded: true },
    });

    const cardText = getByTestId(TEST_IDS.agentToolCallCard).textContent ?? "";
    expect(cardText).toContain("https://api.example.test");
    expect(cardText).toContain("[REDACTED]");
    expect(cardText).not.toContain("account-token-123");
    expect(cardText).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(cardText).not.toContain("anth-secret");
  });
});
