import { describe, expect, it } from "vitest";
import {
  buildSession,
  createSessionLaunchRequest,
  createSessionLaunchRequestFromHistoryEntry,
} from "./session-factory";

describe("session-factory", () => {
  it("derives a default title from the working directory", () => {
    const request = createSessionLaunchRequest({
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/home/user/work/project",
    });

    expect(request).toMatchObject({
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/home/user/work/project",
      title: "project",
      resumeToken: null,
    });
  });

  it("builds a fresh terminal-first session from a launch request", () => {
    const session = buildSession(
      createSessionLaunchRequest({
        agentId: "codex",
        distro: "Ubuntu",
        workDir: "/repo",
        title: "Repo",
        resumeToken: "resume-1",
      }),
    );

    expect(session.id.startsWith("session-")).toBe(true);
    expect(session).toMatchObject({
      ptyId: -1,
      auxPtyId: -1,
      auxVisible: false,
      auxHeightPercent: null,
      agentId: "codex",
      resumeToken: "resume-1",
      title: "Repo",
      distro: "Ubuntu",
      workDir: "/repo",
      viewMode: "terminal",
      editorRootDir: "/repo",
      openEditorTabs: [],
      activeEditorPath: null,
      dirtyPaths: [],
    });
  });

  it("preserves explicit blank titles without normalizing them", () => {
    const request = createSessionLaunchRequest({
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/workspace/demo",
      title: "   ",
    });

    expect(request.title).toBe("   ");
  });

  it("normalizes history entries into launch requests", () => {
    const request = createSessionLaunchRequestFromHistoryEntry({
      agentId: "claude",
      distro: "Ubuntu-22.04",
      workDir: "/tmp/demo",
      title: "Demo",
      resumeToken: "resume-2",
      lastOpenedAt: "123",
    });

    expect(request).toEqual({
      agentId: "claude",
      distro: "Ubuntu-22.04",
      workDir: "/tmp/demo",
      title: "Demo",
      resumeToken: "resume-2",
    });
  });
});
