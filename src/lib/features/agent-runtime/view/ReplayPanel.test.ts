/**
 * ReplayPanel 테스트(T5.6) — 격리 read-only replay 진입/폐기·canLoad 게이팅·live 미병합(10 §4.7).
 */

import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { TEST_IDS } from "../../../testids";
import type { AgentEvent } from "../contracts/normalized";
import { DEFAULT_REPLAY_EVENT_LIMIT, type ReplayLoader } from "../service/runtime-replay";
import ReplayPanel from "./ReplayPanel.svelte";

/** read-only 격리 조회를 모사하는 fake loader. */
function fakeLoader(opts: {
  canLoad: boolean;
  events?: AgentEvent[];
  reject?: Error;
  dispose?: () => void;
}): ReplayLoader {
  return {
    canLoad: () => opts.canLoad,
    loadHistory: async () => {
      if (opts.reject) throw opts.reject;
      return opts.events ?? [];
    },
    dispose: async () => opts.dispose?.(),
  };
}

describe("ReplayPanel", () => {
  beforeEach(() => {
    initializeI18n("en", "en-US");
  });

  it("renders an unavailable notice when canLoad is false", async () => {
    const { getByTestId } = render(ReplayPanel, {
      props: { loader: fakeLoader({ canLoad: false }), onClose: vi.fn() },
    });
    await waitFor(() => {
      expect(getByTestId(TEST_IDS.agentReplayPanel).textContent).toContain(
        "unavailable",
      );
    });
  });

  it("renders isolated read-only history when canLoad is true", async () => {
    const events: AgentEvent[] = [
      {
        type: "user_message",
        ref: { provider: "codex", threadId: "t", turnId: "u", itemId: "m1" },
        content: [{ type: "text", text: "archived message" }],
        mode: "replace",
      },
    ];
    const { getByTestId } = render(ReplayPanel, {
      props: { loader: fakeLoader({ canLoad: true, events }), onClose: vi.fn() },
    });
    await waitFor(() => {
      expect(getByTestId(TEST_IDS.agentReplayPanel).textContent).toContain(
        "archived message",
      );
    });
    // read-only: composer/approval 표면이 없다.
    expect(document.querySelector(`[data-testid="${TEST_IDS.agentComposer}"]`)).toBeNull();
  });

  it("shows a partial snapshot notice when provider replay exceeds the event cap", async () => {
    const events: AgentEvent[] = Array.from({ length: DEFAULT_REPLAY_EVENT_LIMIT + 1 }, (_, index) => ({
      type: "user_message",
      ref: { provider: "codex", threadId: "t", turnId: `u${index}`, itemId: `m${index}` },
      content: [{ type: "text", text: `archived message ${index}` }],
      mode: "replace",
    }));
    const { getByTestId } = render(ReplayPanel, {
      props: { loader: fakeLoader({ canLoad: true, events }), onClose: vi.fn() },
    });

    await waitFor(() => {
      expect(getByTestId(TEST_IDS.agentReplayPanel).textContent).toContain(
        "Some earlier history was omitted",
      );
    });
  });

  it("disposes the scratch session after loading history", async () => {
    const dispose = vi.fn();
    const events: AgentEvent[] = [
      {
        type: "user_message",
        ref: { provider: "codex", threadId: "t", turnId: "u", itemId: "m1" },
        content: [{ type: "text", text: "archived message" }],
        mode: "replace",
      },
    ];
    const onClose = vi.fn();
    const { getByTestId } = render(ReplayPanel, {
      props: { loader: fakeLoader({ canLoad: true, events, dispose }), onClose },
    });

    await waitFor(() => {
      expect(getByTestId(TEST_IDS.agentReplayPanel).textContent).toContain(
        "archived message",
      );
    });
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));

    await fireEvent.click(getByTestId(TEST_IDS.agentReplayClose));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("shows an unavailable notice when provider replay loading fails", async () => {
    const dispose = vi.fn();
    const { getByTestId } = render(ReplayPanel, {
      props: {
        loader: fakeLoader({ canLoad: true, reject: new Error("thread/read failed"), dispose }),
        onClose: vi.fn(),
      },
    });

    await waitFor(() => {
      expect(getByTestId(TEST_IDS.agentReplayPanel).textContent).toContain(
        "unavailable",
      );
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the scratch session and calls onClose when closed", async () => {
    const dispose = vi.fn();
    const onClose = vi.fn();
    const { getByTestId } = render(ReplayPanel, {
      props: { loader: fakeLoader({ canLoad: true, dispose }), onClose },
    });
    await waitFor(() => getByTestId(TEST_IDS.agentReplayClose));
    await fireEvent.click(getByTestId(TEST_IDS.agentReplayClose));
    expect(dispose).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disposes the scratch session only once when close triggers unmount", async () => {
    const dispose = vi.fn();
    const onClose = vi.fn();
    const { getByTestId, unmount } = render(ReplayPanel, {
      props: { loader: fakeLoader({ canLoad: true, dispose }), onClose },
    });

    await waitFor(() => getByTestId(TEST_IDS.agentReplayClose));
    await fireEvent.click(getByTestId(TEST_IDS.agentReplayClose));
    unmount();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
