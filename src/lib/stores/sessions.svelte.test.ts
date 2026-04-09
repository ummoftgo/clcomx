import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "../types";
import {
  addSession,
  getActiveSessionId,
  getSessions,
  getWorkspaceSnapshot,
  initializeSessionsFromWorkspace,
  setActiveSession,
} from "./sessions.svelte";
import { createRuntimeSession } from "../features/workspace/session-store-snapshot";

const BASE_WORKSPACE: WorkspaceSnapshot = {
  windows: [
    {
      label: "main",
      name: "main",
      role: "main",
      activeSessionId: "session-a",
      tabs: [
        {
          sessionId: "session-a",
          agentId: "claude",
          distro: "Ubuntu",
          workDir: "/workspace/a",
          title: "Alpha",
          pinned: false,
          locked: false,
          ptyId: 11,
        },
        {
          sessionId: "session-b",
          agentId: "codex",
          distro: "Ubuntu",
          workDir: "/workspace/b",
          title: "Beta",
          pinned: true,
          locked: false,
          ptyId: 22,
        },
      ],
    },
  ],
};

describe("sessions store facade", () => {
  beforeEach(() => {
    initializeSessionsFromWorkspace(null, "main");
  });

  it("hydrates live session state from a workspace snapshot", () => {
    initializeSessionsFromWorkspace(BASE_WORKSPACE, "main");

    expect(getSessions().map((session) => session.id)).toEqual(["session-a", "session-b"]);
    expect(getActiveSessionId()).toBe("session-a");
    expect(getSessions()[1]?.pinned).toBe(true);
  });

  it("builds a workspace snapshot from the current live session state", () => {
    const alpha = createRuntimeSession({
      sessionId: "session-a",
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/workspace/a",
      title: "Alpha",
      pinned: false,
      locked: false,
      ptyId: 11,
    });
    const beta = createRuntimeSession({
      sessionId: "session-b",
      agentId: "codex",
      distro: "Ubuntu",
      workDir: "/workspace/b",
      title: "Beta",
      pinned: false,
      locked: false,
      ptyId: 22,
    });

    addSession(alpha);
    addSession(beta);
    setActiveSession("session-a");

    expect(getWorkspaceSnapshot()).toEqual({
      windows: [
        expect.objectContaining({
          label: "main",
          activeSessionId: "session-a",
          tabs: [
            expect.objectContaining({ sessionId: "session-a", title: "Alpha" }),
            expect.objectContaining({ sessionId: "session-b", title: "Beta" }),
          ],
        }),
      ],
    });
  });
});
