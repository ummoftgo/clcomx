import { render } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { initializeSettings } from "../../../stores/settings.svelte";
import { DEFAULT_SETTINGS } from "../../../types";
import SessionLauncher from "./SessionLauncher.svelte";

type SessionLauncherProps = ComponentProps<typeof SessionLauncher>;

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
});
