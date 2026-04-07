import { describe, expect, it } from "vitest";
import type { Session } from "../../types";
import {
  moveSessionInList,
  removeSessionAndResolveActive,
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
});
