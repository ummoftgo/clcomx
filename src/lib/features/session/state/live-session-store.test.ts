import { beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../../types";
import {
  addSession,
  getActiveSession,
  getActiveSessionId,
  getSessions,
  moveSession,
  removeSession,
  replaceLiveSessions,
  setSessionPinned,
} from "./live-session-store.svelte";

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

describe("live-session-store", () => {
  beforeEach(() => {
    replaceLiveSessions([], null);
  });

  it("stores live sessions and tracks the active session locally", () => {
    addSession(createSession("a"));
    addSession(createSession("b"));

    expect(getSessions().map((session) => session.id)).toEqual(["a", "b"]);
    expect(getActiveSessionId()).toBe("b");
    expect(getActiveSession()?.id).toBe("b");
  });

  it("resolves the next active session when removing the current one", () => {
    replaceLiveSessions([createSession("a"), createSession("b"), createSession("c")], "b");

    removeSession("b");

    expect(getSessions().map((session) => session.id)).toEqual(["a", "c"]);
    expect(getActiveSessionId()).toBe("c");
  });

  it("keeps pin ordering and move behavior within the live session store", () => {
    replaceLiveSessions([createSession("a"), createSession("b", true), createSession("c")], "a");

    setSessionPinned("c", true);
    moveSession("c", 0);

    expect(getSessions().map((session) => [session.id, session.pinned])).toEqual([
      ["c", true],
      ["a", false],
      ["b", true],
    ]);
  });
});
