import { describe, expect, it } from "vitest";
import { sanitizeWorkspaceSnapshotForSave } from "./workspace";

describe("workspace persistence helpers", () => {
  it("strips runtime and resume handles before saving workspace snapshots", () => {
    const snapshot = sanitizeWorkspaceSnapshotForSave({
      windows: [
        {
          label: "main",
          name: "main",
          role: "main",
          activeSessionId: "session-1",
          tabs: [
            {
              sessionId: "session-1",
              agentId: "claude",
              distro: "Ubuntu",
              workDir: "/workspace",
              title: "Workspace",
              pinned: false,
              locked: false,
              resumeToken: "resume-secret",
              ptyId: 7,
            },
          ],
        },
      ],
    });

    expect(snapshot.windows[0].tabs[0]).toMatchObject({
      resumeToken: null,
      ptyId: null,
    });
  });

  it("masks direct runtime secret fields but keeps non-secret metadata", () => {
    const snapshot = sanitizeWorkspaceSnapshotForSave({
      windows: [
        {
          label: "main",
          name: "main",
          role: "main",
          activeSessionId: "session-direct",
          tabs: [
            {
              sessionId: "session-direct",
              agentId: "codex",
              distro: "Ubuntu",
              workDir: "/workspace",
              title: "Direct",
              pinned: false,
              locked: false,
              runtimeKind: "direct-codex",
              agentRuntime: {
                sessionRuntimeKind: "direct-codex",
                provider: "codex",
                providerSessionId: "sess-secret",
                providerThreadId: "thread-secret",
                providerResumeToken: "resume-token-secret",
                lastTurnId: "turn-9",
                canLoad: true,
              },
            },
          ],
        },
      ],
    });

    const tab = snapshot.windows[0].tabs[0];
    expect(tab.agentRuntime?.providerSessionId).toBeUndefined();
    expect(tab.agentRuntime?.providerThreadId).toBeUndefined();
    expect(tab.agentRuntime?.providerResumeToken).toBeUndefined();
    // 비-비밀 필드는 보존.
    expect(tab.agentRuntime).toMatchObject({
      sessionRuntimeKind: "direct-codex",
      provider: "codex",
      lastTurnId: "turn-9",
      canLoad: true,
    });
    expect(tab.runtimeKind).toBe("direct-codex");

    // 직렬화 결과에 비밀 문자열이 남지 않아야 한다(보조 방어선).
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("sess-secret");
    expect(json).not.toContain("thread-secret");
    expect(json).not.toContain("resume-token-secret");
  });

  it("leaves snapshots without direct runtime metadata untouched", () => {
    const snapshot = sanitizeWorkspaceSnapshotForSave({
      windows: [
        {
          label: "main",
          name: "main",
          role: "main",
          activeSessionId: "session-1",
          tabs: [
            {
              sessionId: "session-1",
              agentId: "claude",
              distro: "Ubuntu",
              workDir: "/workspace",
              title: "Workspace",
              pinned: false,
              locked: false,
            },
          ],
        },
      ],
    });

    expect(snapshot.windows[0].tabs[0].agentRuntime).toBeUndefined();
  });
});
