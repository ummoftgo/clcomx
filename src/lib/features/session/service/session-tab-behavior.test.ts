import { describe, expect, it } from "vitest";
import {
  hasDirtyEditorState,
  resolveAdjacentSessionMoveIndex,
  resolveCloseTabRequest,
  resolveRenamedSessionTitle,
} from "./session-tab-behavior";

describe("session-tab-behavior", () => {
  it("detects dirty editor state", () => {
    expect(hasDirtyEditorState(undefined)).toBe(false);
    expect(hasDirtyEditorState({ locked: false, ptyId: -1, dirtyPaths: [] })).toBe(false);
    expect(hasDirtyEditorState({ locked: false, ptyId: -1, dirtyPaths: ["/tmp/file.ts"] })).toBe(
      true,
    );
  });

  it("resolves close-tab requests without moving the dialog state machine", () => {
    expect(resolveCloseTabRequest(undefined)).toBe("blocked");
    expect(resolveCloseTabRequest({ locked: true, ptyId: -1, dirtyPaths: [] })).toBe("blocked");
    expect(resolveCloseTabRequest({ locked: false, ptyId: -1, dirtyPaths: ["dirty"] })).toBe(
      "dirty-warning",
    );
    expect(resolveCloseTabRequest({ locked: false, ptyId: 42, dirtyPaths: [] })).toBe(
      "close-confirm",
    );
    expect(resolveCloseTabRequest({ locked: false, ptyId: -1, dirtyPaths: [] })).toBe(
      "close-now",
    );
  });

  it("resolves adjacent move targets within the pinned group only", () => {
    const sessions = [
      { id: "a", pinned: false },
      { id: "b", pinned: false },
      { id: "c", pinned: true },
      { id: "d", pinned: true },
      { id: "e", pinned: false },
    ];

    expect(resolveAdjacentSessionMoveIndex(sessions, "a", "left")).toBeNull();
    expect(resolveAdjacentSessionMoveIndex(sessions, "a", "right")).toBe(1);
    expect(resolveAdjacentSessionMoveIndex(sessions, "d", "left")).toBe(2);
    expect(resolveAdjacentSessionMoveIndex(sessions, "d", "right")).toBeNull();
    expect(resolveAdjacentSessionMoveIndex(sessions, "missing", "right")).toBeNull();
  });

  it("uses the trimmed rename value or falls back to the workdir basename", () => {
    expect(resolveRenamedSessionTitle({ workDir: "/tmp/project" }, "  renamed  ")).toBe("renamed");
    expect(resolveRenamedSessionTitle({ workDir: "/tmp/project" }, "   ")).toBe("project");
    expect(resolveRenamedSessionTitle({ workDir: "/" }, "")).toBe("/");
  });
});
