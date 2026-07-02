import { describe, expect, it } from "vitest";
import type { Session } from "../../types";
import {
  moveSessionInList,
  removeSessionAndResolveActive,
  setSessionAgentRuntimeInList,
  setSessionAgentRuntimeStatusInList,
  setSessionEditorStateInList,
  setSessionPinnedInList,
} from "./session-store-mutations";

function createSession(id: string, pinned = false): Session {
  return {
    id,
    ptyId: -1,
    auxPtyId: -1,
    auxVisible: false,
    auxHeightPercent: null,
    agentId: "claude",
    resumeToken: null,
    title: id,
    pinned,
    locked: false,
    distro: "Ubuntu",
    workDir: `/tmp/${id}`,
    viewMode: "terminal",
    editorRootDir: `/tmp/${id}`,
    openEditorTabs: [],
    activeEditorPath: null,
    dirtyPaths: [],
  };
}

describe("session-store-mutations", () => {
  it("removes an active session and resolves the next active id", () => {
    const sessions = [createSession("a"), createSession("b"), createSession("c")];

    const nextActive = removeSessionAndResolveActive(sessions, "b", "b");

    expect(sessions.map((session) => session.id)).toEqual(["a", "c"]);
    expect(nextActive).toBe("c");
  });

  it("keeps pinned sessions grouped at the front when toggled on", () => {
    const sessions = [createSession("a", false), createSession("b", true), createSession("c", false)];

    setSessionPinnedInList(sessions, "c", true);

    expect(sessions.map((session) => [session.id, session.pinned])).toEqual([
      ["c", true],
      ["a", false],
      ["b", true],
    ]);
  });

  it("moves a session within bounds", () => {
    const sessions = [createSession("a"), createSession("b"), createSession("c")];

    moveSessionInList(sessions, "c", 0);

    expect(sessions.map((session) => session.id)).toEqual(["c", "a", "b"]);
  });

  it("applies editor snapshot state through a single mutation", () => {
    const sessions = [createSession("a")];

    setSessionEditorStateInList(sessions, "a", {
      viewMode: "editor",
      editorRootDir: "/tmp/a/src",
      openEditorTabs: [{ wslPath: "/tmp/a/src/main.ts", line: 3, column: 7 }],
      activeEditorPath: "/tmp/a/src/main.ts",
      dirtyPaths: ["/tmp/a/src/main.ts"],
    });

    expect(sessions[0]).toMatchObject({
      viewMode: "editor",
      editorRootDir: "/tmp/a/src",
      openEditorTabs: [{ wslPath: "/tmp/a/src/main.ts", line: 3, column: 7 }],
      activeEditorPath: "/tmp/a/src/main.ts",
      dirtyPaths: ["/tmp/a/src/main.ts"],
    });
  });

  it("updates direct runtime metadata without touching PTY resume state", () => {
    const sessions = [createSession("a")];

    setSessionAgentRuntimeInList(sessions, "a", {
      sessionRuntimeKind: "direct-codex",
      provider: "codex",
      providerThreadId: "thread-1",
      providerSessionId: "session-tree-1",
      canResume: true,
      canLoad: true,
    });

    expect(sessions[0].resumeToken).toBeNull();
    expect(sessions[0].agentRuntime).toMatchObject({
      sessionRuntimeKind: "direct-codex",
      provider: "codex",
      providerThreadId: "thread-1",
      providerSessionId: "session-tree-1",
    });
  });

  it("OQ-06: updates the live-only direct runtime tab status", () => {
    const sessions = [createSession("a")];

    setSessionAgentRuntimeStatusInList(sessions, "a", "requires_action");

    expect(sessions[0].agentRuntimeStatus).toBe("requires_action");
  });
});
