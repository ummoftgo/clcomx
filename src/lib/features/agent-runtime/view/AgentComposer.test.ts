/**
 * AgentComposer 테스트(T5.4) — send/stop flow·Enter 전송·Shift+Enter 비전송·focus/shortcut 회귀(08 §6, FE §11).
 */

import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { TEST_IDS } from "../../../testids";
import AgentComposer from "./AgentComposer.svelte";

describe("AgentComposer", () => {
  beforeEach(() => {
    initializeI18n("en", "en-US");
  });

  it("sends text content via onSend on Enter", async () => {
    const onSend = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: { status: "ready", providerLabel: "codex", onSend, onStop: vi.fn() },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "hello" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith([{ type: "text", text: "hello" }]);
  });

  it("does not send on Shift+Enter (newline, no shortcut interception)", async () => {
    const onSend = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: { status: "ready", providerLabel: "codex", onSend, onStop: vi.fn() },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "line" } });
    await fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows a stop button while running and calls onStop", async () => {
    const onStop = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: { status: "running", providerLabel: "codex", onSend: vi.fn(), onStop },
    });
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerSend));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("disables input while waiting for approval (requires_action)", () => {
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "requires_action",
        providerLabel: "codex",
        onSend: vi.fn(),
        onStop: vi.fn(),
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
  });
});
