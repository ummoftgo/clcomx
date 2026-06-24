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
});
