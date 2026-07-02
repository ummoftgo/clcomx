/**
 * CommandOutputCard 렌더 테스트(T5.3) — stdout embed·stderr 기본 접힘·포커스 비가로채기(08 §4·§7.3).
 */

import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { initializeI18n } from "../../../../i18n";
import { TEST_IDS } from "../../../../testids";
import CommandOutputCard from "./CommandOutputCard.svelte";

describe("CommandOutputCard", () => {
  beforeEach(() => {
    initializeI18n("en", "en-US");
  });

  it("embeds stdout output", () => {
    const { getByTestId } = render(CommandOutputCard, {
      props: { command: "ls", cwd: "/tmp", stdout: "file-a\nfile-b\n" },
    });
    const output = getByTestId(TEST_IDS.agentCommandOutput);
    expect(output.textContent).toContain("file-a");
    expect(output.textContent).toContain("file-b");
  });

  it("does not register a focusable element for the output (no app shortcut interception)", () => {
    const { getByTestId } = render(CommandOutputCard, {
      props: { command: "ls", stdout: "x" },
    });
    const output = getByTestId(TEST_IDS.agentCommandOutput);
    expect(output.getAttribute("tabindex")).toBeNull();
    expect(output.tagName.toLowerCase()).not.toBe("textarea");
    expect(output.tagName.toLowerCase()).not.toBe("input");
  });

  it("keeps stderr collapsed by default and reveals it on toggle", async () => {
    const { getByText, queryByText } = render(CommandOutputCard, {
      props: { command: "build", stdout: "ok", stderr: "warning: deprecated" },
    });
    // stderr content hidden until toggled.
    expect(queryByText("warning: deprecated")).toBeNull();
    await fireEvent.click(getByText("stderr"));
    expect(getByText("warning: deprecated")).toBeTruthy();
  });

  it("redacts credential-like values in stdout and expanded stderr", async () => {
    const { getByTestId, getByText, queryByText } = render(CommandOutputCard, {
      props: {
        command: "build",
        stdout: "using sk-live-secret\n",
        stderr: "Authorization: Bearer account-token-123\n",
      },
    });

    const stdout = getByTestId(TEST_IDS.agentCommandOutput);
    expect(stdout.textContent).toContain("[REDACTED]");
    expect(stdout.textContent).not.toContain("sk-live-secret");
    expect(queryByText(/account-token-123/)).toBeNull();

    await fireEvent.click(getByText("stderr"));
    const card = getByTestId(TEST_IDS.agentCommandOutputCard);
    expect(card.textContent).toContain("[REDACTED]");
    expect(card.textContent).not.toContain("account-token-123");
  });
});
