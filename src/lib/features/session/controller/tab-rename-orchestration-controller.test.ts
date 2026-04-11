import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../../types";
import { createTabRenameOrchestrationController } from "./tab-rename-orchestration-controller";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    agentId: "claude",
    resumeToken: "resume-1",
    title: "Demo",
    pinned: false,
    locked: false,
    distro: "Ubuntu",
    workDir: "/workspace/demo",
    ptyId: 42,
    auxPtyId: -1,
    auxVisible: false,
    auxHeightPercent: null,
    viewMode: "terminal",
    editorRootDir: "/workspace/demo",
    openEditorTabs: [],
    activeEditorPath: null,
    dirtyPaths: [],
    ...overrides,
  };
}

function createRuntime(sessionMap = new Map<string, Session>([["session-1", createSession()]])) {
  const state = {
    renameDialogKind: null as "tab" | "window" | null,
    renameDialogValue: "",
    renameTargetSessionId: null as string | null,
  };

  const setSessionTitle = vi.fn();
  const recordTabHistory = vi.fn(async () => {});
  const controller = createTabRenameOrchestrationController({
    getSession: (sessionId) => sessionMap.get(sessionId) ?? null,
    getRenameDialogKind: () => state.renameDialogKind,
    getRenameDialogValue: () => state.renameDialogValue,
    getRenameTargetSessionId: () => state.renameTargetSessionId,
    setRenameDialogKind: (kind) => {
      state.renameDialogKind = kind;
    },
    setRenameDialogValue: (value) => {
      state.renameDialogValue = value;
    },
    setRenameTargetSessionId: (sessionId) => {
      state.renameTargetSessionId = sessionId;
    },
    setSessionTitle,
    recordTabHistory,
  });

  return {
    state,
    setSessionTitle,
    recordTabHistory,
    controller,
  };
}

describe("tab-rename-orchestration-controller", () => {
  it("opens the rename dialog for an existing tab session", () => {
    const { state, controller } = createRuntime();

    expect(controller.requestRenameTab("session-1")).toBe(true);
    expect(state).toMatchObject({
      renameDialogKind: "tab",
      renameDialogValue: "Demo",
      renameTargetSessionId: "session-1",
    });
  });

  it("ignores rename requests for missing sessions", () => {
    const { state, controller } = createRuntime();

    expect(controller.requestRenameTab("missing")).toBe(false);
    expect(state).toMatchObject({
      renameDialogKind: null,
      renameDialogValue: "",
      renameTargetSessionId: null,
    });
  });

  it("confirms tab rename, trims the title, records history, and dismisses the dialog", () => {
    const { state, setSessionTitle, recordTabHistory, controller } = createRuntime();
    state.renameDialogKind = "tab";
    state.renameDialogValue = "  renamed  ";
    state.renameTargetSessionId = "session-1";

    expect(controller.confirmRename()).toBe(true);
    expect(setSessionTitle).toHaveBeenCalledWith("session-1", "renamed");
    expect(recordTabHistory).toHaveBeenCalledWith(
      "claude",
      "Ubuntu",
      "/workspace/demo",
      "renamed",
      "resume-1",
    );
    expect(state).toMatchObject({
      renameDialogKind: null,
      renameDialogValue: "",
      renameTargetSessionId: null,
    });
  });

  it("falls back to the workdir basename when confirming a blank tab title", () => {
    const { state, setSessionTitle, controller } = createRuntime(new Map([
      ["session-1", createSession({ title: "Old", workDir: "/workspace/project" })],
    ]));
    state.renameDialogKind = "tab";
    state.renameDialogValue = "   ";
    state.renameTargetSessionId = "session-1";

    expect(controller.confirmRename()).toBe(true);
    expect(setSessionTitle).toHaveBeenCalledWith("session-1", "project");
  });

  it("only handles the tab rename branch and clears stale tab targets", () => {
    const sessionMap = new Map<string, Session>([["session-1", createSession()]]);
    const { state, setSessionTitle, recordTabHistory, controller } = createRuntime(sessionMap);

    state.renameDialogKind = "window";
    state.renameDialogValue = "Window 2";
    expect(controller.confirmRename()).toBe(false);
    expect(setSessionTitle).not.toHaveBeenCalled();
    expect(recordTabHistory).not.toHaveBeenCalled();

    state.renameDialogKind = "tab";
    state.renameDialogValue = "Demo";
    state.renameTargetSessionId = "session-1";
    sessionMap.delete("session-1");
    expect(controller.reconcilePendingRenameDialog()).toBe(true);
    expect(state).toMatchObject({
      renameDialogKind: null,
      renameDialogValue: "",
      renameTargetSessionId: null,
    });
  });
});
