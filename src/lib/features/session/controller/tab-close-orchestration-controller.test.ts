import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../../types";
import {
  createTabCloseOrchestrationController,
} from "./tab-close-orchestration-controller";

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

function createRuntime(
  sessionMap = new Map<string, Session>([["session-1", createSession()]]),
) {
  const state = {
    pendingCloseSessionId: null as string | null,
    showCloseTabDialog: false,
    showDirtyTabDialog: false,
  };

  const closeTab = vi.fn(async (_sessionId: string) => {});
  const controller = createTabCloseOrchestrationController({
    getSession: (sessionId) => sessionMap.get(sessionId) ?? null,
    getPendingCloseSessionId: () => state.pendingCloseSessionId,
    setPendingCloseSessionId: (sessionId) => {
      state.pendingCloseSessionId = sessionId;
    },
    getShowCloseTabDialog: () => state.showCloseTabDialog,
    getShowDirtyTabDialog: () => state.showDirtyTabDialog,
    setShowCloseTabDialog: (open) => {
      state.showCloseTabDialog = open;
    },
    setShowDirtyTabDialog: (open) => {
      state.showDirtyTabDialog = open;
    },
    closeTab,
  });

  return { state, closeTab, controller };
}

describe("tab-close-orchestration-controller", () => {
  it("blocks close requests for missing or locked sessions", () => {
    const missing = createRuntime();
    expect(missing.controller.requestCloseTab("missing")).toBe("blocked");
    expect(missing.state).toMatchObject({
      pendingCloseSessionId: null,
      showCloseTabDialog: false,
      showDirtyTabDialog: false,
    });
    expect(missing.closeTab).not.toHaveBeenCalled();

    const locked = createRuntime(new Map([
      ["session-1", createSession({ locked: true })],
    ]));
    expect(locked.controller.requestCloseTab("session-1")).toBe("blocked");
    expect(locked.state).toMatchObject({
      pendingCloseSessionId: null,
      showCloseTabDialog: false,
      showDirtyTabDialog: false,
    });
    expect(locked.closeTab).not.toHaveBeenCalled();
  });

  it("opens the dirty-warning dialog for dirty sessions", () => {
    const { state, closeTab, controller } = createRuntime(new Map([
      ["session-1", createSession({ dirtyPaths: ["dirty.txt"] })],
    ]));

    expect(controller.requestCloseTab("session-1")).toBe("dirty-warning");
    expect(state).toMatchObject({
      pendingCloseSessionId: "session-1",
      showCloseTabDialog: false,
      showDirtyTabDialog: true,
    });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("opens the close-confirm dialog for live sessions", () => {
    const { state, closeTab, controller } = createRuntime();

    expect(controller.requestCloseTab("session-1")).toBe("close-confirm");
    expect(state).toMatchObject({
      pendingCloseSessionId: "session-1",
      showCloseTabDialog: true,
      showDirtyTabDialog: false,
    });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("closes immediately when the session has no running PTY", async () => {
    const { state, closeTab, controller } = createRuntime(new Map([
      ["session-1", createSession({ ptyId: -1 })],
    ]));

    expect(controller.requestCloseTab("session-1")).toBe("close-now");
    await Promise.resolve();

    expect(closeTab).toHaveBeenCalledWith("session-1");
    expect(state).toMatchObject({
      pendingCloseSessionId: null,
      showCloseTabDialog: false,
      showDirtyTabDialog: false,
    });
  });

  it("confirms tab close by dismissing the dialog before closing", async () => {
    const { state, closeTab, controller } = createRuntime();
    controller.openCloseTabDialog("session-1");

    await expect(controller.confirmCloseTab()).resolves.toBe(true);

    expect(state).toMatchObject({
      pendingCloseSessionId: null,
      showCloseTabDialog: false,
      showDirtyTabDialog: false,
    });
    expect(closeTab).toHaveBeenCalledWith("session-1");
  });

  it("dismisses both close and dirty dialogs by clearing the pending session", () => {
    const { state, controller } = createRuntime();

    controller.openCloseTabDialog("session-1");
    controller.dismissCloseTabDialog();
    expect(state).toMatchObject({
      pendingCloseSessionId: null,
      showCloseTabDialog: false,
      showDirtyTabDialog: false,
    });

    state.pendingCloseSessionId = "session-1";
    state.showDirtyTabDialog = true;
    controller.dismissDirtyTabDialog();
    expect(state).toMatchObject({
      pendingCloseSessionId: null,
      showCloseTabDialog: false,
      showDirtyTabDialog: false,
    });
  });

  it("advances a dirty live session into the close-confirm dialog", () => {
    const { state, closeTab, controller } = createRuntime();
    state.pendingCloseSessionId = "session-1";
    state.showDirtyTabDialog = true;

    expect(controller.continueCloseTabAfterDirtyWarning()).toBe("close-confirm");
    expect(state).toMatchObject({
      pendingCloseSessionId: "session-1",
      showCloseTabDialog: true,
      showDirtyTabDialog: false,
    });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("continues dirty close immediately when the PTY is already gone", async () => {
    const { state, closeTab, controller } = createRuntime(new Map([
      ["session-1", createSession({ ptyId: -1, dirtyPaths: ["dirty.txt"] })],
    ]));
    state.pendingCloseSessionId = "session-1";
    state.showDirtyTabDialog = true;

    expect(controller.continueCloseTabAfterDirtyWarning()).toBe("close-now");
    await Promise.resolve();

    expect(state).toMatchObject({
      pendingCloseSessionId: null,
      showCloseTabDialog: false,
      showDirtyTabDialog: false,
    });
    expect(closeTab).toHaveBeenCalledWith("session-1");
  });

  it("clears a dirty-warning flow when the pending session disappears", () => {
    const sessionMap = new Map<string, Session>([["session-1", createSession()]]);
    const { state, closeTab, controller } = createRuntime(sessionMap);
    state.pendingCloseSessionId = "session-1";
    state.showDirtyTabDialog = true;
    sessionMap.delete("session-1");

    expect(controller.continueCloseTabAfterDirtyWarning()).toBe("blocked");
    expect(state).toMatchObject({
      pendingCloseSessionId: null,
      showCloseTabDialog: false,
      showDirtyTabDialog: false,
    });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("dismisses a stale pending close target when the session disappears", () => {
    const sessionMap = new Map<string, Session>([["session-1", createSession()]]);
    const { state, controller } = createRuntime(sessionMap);
    controller.openCloseTabDialog("session-1");

    sessionMap.delete("session-1");

    expect(controller.reconcilePendingCloseTab()).toBe(true);
    expect(state).toMatchObject({
      pendingCloseSessionId: null,
      showCloseTabDialog: false,
      showDirtyTabDialog: false,
    });
  });

  it("dismisses a stale dirty-warning target when the session disappears", () => {
    const sessionMap = new Map<string, Session>([["session-1", createSession()]]);
    const { state, controller } = createRuntime(sessionMap);
    state.pendingCloseSessionId = "session-1";
    state.showDirtyTabDialog = true;

    sessionMap.delete("session-1");

    expect(controller.reconcilePendingCloseTab()).toBe(true);
    expect(state).toMatchObject({
      pendingCloseSessionId: null,
      showCloseTabDialog: false,
      showDirtyTabDialog: false,
    });
  });
});
