import { fireEvent, render, waitFor } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { initializeSettings } from "../../../stores/settings.svelte";
import { TEST_IDS } from "../../../testids";
import { DEFAULT_SETTINGS } from "../../../types";
import SessionLauncher from "./SessionLauncher.svelte";

type SessionLauncherProps = ComponentProps<typeof SessionLauncher>;

vi.mock("../../../wsl", () => ({
  listWslDistros: vi.fn(async () => ["Ubuntu"]),
  listWslDirectories: vi.fn(async () => []),
}));

function createProps(): SessionLauncherProps {
  return {
    visible: true,
    historyEntries: [
      {
        agentId: "claude",
        distro: "Ubuntu",
        workDir: "/workspace/project",
        title: "Project",
        resumeToken: "secret-resume-token-value-1234567890",
        lastOpenedAt: "2026-06-24T00:00:00.000Z",
      },
    ],
    onOpenHistory: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };
}

describe("SessionLauncher", () => {
  beforeEach(() => {
    initializeSettings(DEFAULT_SETTINGS);
    initializeI18n("ko", "ko-KR");
  });

  it("does not expose full resume tokens in title attributes", () => {
    const { container } = render(SessionLauncher, createProps());

    const token = container.querySelector(".recent-token");

    expect(token).toBeInTheDocument();
    expect(token).not.toHaveAttribute("title");
    expect(token).not.toHaveTextContent("secret-resume-token-value-1234567890");
  });

  it("shows a direct runtime badge for direct history entries", () => {
    const props = createProps();
    props.historyEntries[0].runtimeKind = "direct-claude";

    const { container } = render(SessionLauncher, props);

    expect(container.querySelector(".recent-runtime-badge")).toHaveTextContent("다이렉트");
  });

  it("does not display stale resume tokens on direct history entries", () => {
    const props = createProps();
    props.historyEntries[0].runtimeKind = "direct-claude";

    const { container } = render(SessionLauncher, props);

    expect(container.querySelector(".recent-token")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("secret-resume-token-value-1234567890");
  });

  it("uses provider wording instead of official app wording for direct history entries", () => {
    const props = createProps();
    props.historyEntries[0].runtimeKind = "direct-claude";

    const { container } = render(SessionLauncher, props);

    const meta = container.querySelector(".recent-meta");
    expect(meta).toHaveTextContent("제공자: Claude · Ubuntu");
    expect(meta).not.toHaveTextContent("Claude Code");
  });

  it("uses provider wording on the selected agent trigger when direct runtime is enabled", async () => {
    const { getByTestId } = render(SessionLauncher, createProps());

    await fireEvent.click(getByTestId(TEST_IDS.launcherNewSession));
    await waitFor(() =>
      expect(getByTestId(TEST_IDS.launcherAgentTrigger)).toHaveTextContent("Claude Code"),
    );

    const directRuntimeInput = getByTestId(TEST_IDS.launcherDirectRuntimeToggle).querySelector(
      "input",
    );
    expect(directRuntimeInput).toBeInstanceOf(HTMLInputElement);
    await fireEvent.click(directRuntimeInput as HTMLInputElement);

    await waitFor(() => {
      expect(getByTestId(TEST_IDS.launcherAgentTrigger)).toHaveTextContent("제공자: Claude");
      expect(getByTestId(TEST_IDS.launcherAgentTrigger)).not.toHaveTextContent("Claude Code");
    });
  });
});
