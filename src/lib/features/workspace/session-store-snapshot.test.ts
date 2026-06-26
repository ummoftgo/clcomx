import { describe, expect, it } from "vitest";
import {
  applyWorkspaceWindowSnapshot,
  createRuntimeSession,
  createWorkspaceSnapshotForWindow,
  createWorkspaceWindowSnapshot,
} from "./session-store-snapshot";

describe("session-store-snapshot", () => {
  it("creates a runtime session from a tab snapshot", () => {
    const session = createRuntimeSession({
      sessionId: "session-1",
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/home/user/project",
      title: "",
      pinned: true,
      locked: false,
      viewMode: "editor",
      openEditorTabs: [
        {
          wslPath: "/home/user/project/src/App.ts",
          line: 12,
          column: 4,
        },
      ],
      activeEditorPath: "/home/user/project/src/App.ts",
    });

    expect(session).toMatchObject({
      id: "session-1",
      title: "project",
      viewMode: "editor",
      editorRootDir: "/home/user/project",
      openEditorTabs: [{ wslPath: "/home/user/project/src/App.ts", line: 12, column: 4 }],
      activeEditorPath: "/home/user/project/src/App.ts",
      dirtyPaths: [],
    });
  });

  it("creates a workspace snapshot from sessions", () => {
    const session = createRuntimeSession({
      sessionId: "session-1",
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/home/user/project",
      title: "Project",
      pinned: false,
      locked: false,
    });

    const windowSnapshot = createWorkspaceWindowSnapshot({
      sessions: [session],
      activeSessionId: "session-1",
      currentWindowLabel: "main",
      currentWindowName: "main",
    });

    expect(windowSnapshot).toMatchObject({
      label: "main",
      role: "main",
      activeSessionId: "session-1",
      tabs: [
        {
          sessionId: "session-1",
          title: "Project",
          workDir: "/home/user/project",
        },
      ],
    });

    expect(
      createWorkspaceSnapshotForWindow({
        sessions: [session],
        activeSessionId: "session-1",
        currentWindowLabel: "main",
        currentWindowName: "main",
      }),
    ).toEqual({ windows: [windowSnapshot] });
  });

  it("applies a workspace snapshot to existing sessions without losing session identity", () => {
    const existing = createRuntimeSession({
      sessionId: "session-1",
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/home/user/project",
      title: "Old",
      pinned: false,
      locked: false,
    });
    existing.dirtyPaths = ["/home/user/project/src/App.ts"];

    const result = applyWorkspaceWindowSnapshot({
      sessions: [existing],
      currentWindowLabel: "main",
      windowSnapshot: {
        label: "main",
        name: "main",
        role: "main",
        activeSessionId: "session-1",
        tabs: [
          {
            sessionId: "session-1",
            agentId: "claude",
            distro: "Ubuntu",
            workDir: "/home/user/project",
            title: "New",
            pinned: true,
            locked: true,
            viewMode: "terminal",
            openEditorTabs: [
              {
                wslPath: "/home/user/project/src/App.ts",
              },
            ],
            activeEditorPath: "/home/user/project/src/App.ts",
          },
        ],
      },
    });

    expect(result.currentWindowName).toBe("main");
    expect(result.activeSessionId).toBe("session-1");
    expect(result.sessions[0]).toBe(existing);
    expect(existing).toMatchObject({
      title: "New",
      pinned: true,
      locked: true,
      viewMode: "terminal",
      openEditorTabs: [{ wslPath: "/home/user/project/src/App.ts", line: null, column: null }],
      activeEditorPath: "/home/user/project/src/App.ts",
      dirtyPaths: ["/home/user/project/src/App.ts"],
    });
  });

  it("normalizes a session without runtimeKind to pty on restore", () => {
    const session = createRuntimeSession({
      sessionId: "session-1",
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/home/user/project",
      title: "Project",
      pinned: false,
      locked: false,
    });

    expect(session.runtimeKind).toBe("pty");
    expect(session.agentRuntime).toBeUndefined();
  });

  it("round-trips direct runtime metadata through snapshot and restore", () => {
    const session = createRuntimeSession({
      sessionId: "session-direct",
      agentId: "codex",
      distro: "Ubuntu",
      workDir: "/home/user/project",
      title: "Direct",
      pinned: false,
      locked: false,
      runtimeKind: "direct-codex",
      agentRuntime: {
        sessionRuntimeKind: "direct-codex",
        provider: "codex",
        lastTurnId: "turn-3",
        canLoad: true,
        canResume: true,
      },
    });

    expect(session.runtimeKind).toBe("direct-codex");

    const windowSnapshot = createWorkspaceWindowSnapshot({
      sessions: [session],
      activeSessionId: "session-direct",
      currentWindowLabel: "main",
      currentWindowName: "main",
    });

    const tab = windowSnapshot.tabs[0];
    expect(tab.runtimeKind).toBe("direct-codex");
    expect(tab.agentRuntime).toMatchObject({
      sessionRuntimeKind: "direct-codex",
      provider: "codex",
      lastTurnId: "turn-3",
      canLoad: true,
      canResume: true,
    });

    const restored = createRuntimeSession(tab);
    expect(restored.runtimeKind).toBe("direct-codex");
    expect(restored.agentRuntime).toMatchObject({
      sessionRuntimeKind: "direct-codex",
      provider: "codex",
    });
  });
});
