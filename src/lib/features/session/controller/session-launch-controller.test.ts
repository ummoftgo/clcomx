import { describe, expect, it, vi } from "vitest";
import {
  launchSession,
  launchSessionFromHistoryEntry,
} from "./session-launch-controller";

describe("session-launch-controller", () => {
  it("launches a session in the same order as App.svelte", () => {
    const steps: string[] = [];

    launchSession(
      {
        addSession: (session) => {
          steps.push(`add:${session.agentId}:${session.workDir}:${session.title}`);
        },
        hideSessionLauncher: () => {
          steps.push("hide");
        },
        persistWorkspace: () => {
          steps.push("persist");
        },
        ensureTerminalComponent: () => {
          steps.push("ensure");
        },
      },
      {
        agentId: "claude",
        distro: "Ubuntu-20.04",
        workDir: "/tmp/project",
      },
    );

    expect(steps).toEqual([
      "add:claude:/tmp/project:project",
      "hide",
      "persist",
      "ensure",
    ]);
  });

  it("reuses history-entry normalization when relaunching a tab", () => {
    const addSession = vi.fn();
    const hideSessionLauncher = vi.fn();
    const persistWorkspace = vi.fn();
    const ensureTerminalComponent = vi.fn();

    launchSessionFromHistoryEntry(
      {
        addSession,
        hideSessionLauncher,
        persistWorkspace,
        ensureTerminalComponent,
      },
      {
        agentId: "codex",
        distro: "Ubuntu-20.04",
        workDir: "/tmp/reopened",
        title: "Saved title",
        lastOpenedAt: "2026-04-06T12:00:00.000Z",
        resumeToken: "resume-token",
      },
    );

    expect(addSession).toHaveBeenCalledTimes(1);
    expect(addSession.mock.calls[0]?.[0]).toMatchObject({
      agentId: "codex",
      distro: "Ubuntu-20.04",
      workDir: "/tmp/reopened",
      title: "Saved title",
      resumeToken: "resume-token",
    });
    expect(hideSessionLauncher).toHaveBeenCalledTimes(1);
    expect(persistWorkspace).toHaveBeenCalledTimes(1);
    expect(ensureTerminalComponent).toHaveBeenCalledTimes(1);
  });
});
