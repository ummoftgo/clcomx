import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../../types";
import {
  createSessionLifecycleController,
  type SessionLifecycleControllerDependencies,
} from "./session-lifecycle-controller";

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

function createDeps(
  sessionMap = new Map<string, Session>([["session-1", createSession()]]),
  overrides: Partial<SessionLifecycleControllerDependencies> = {},
): SessionLifecycleControllerDependencies {
  return {
    addSession: vi.fn(),
    hideSessionLauncher: vi.fn(),
    ensureSessionShellComponent: vi.fn(),
    persistWorkspace: vi.fn(async () => {}),
    getSession: vi.fn((sessionId: string) => sessionMap.get(sessionId) ?? null),
    getSessions: vi.fn(() => [...sessionMap.values()]),
    setSessionPtyId: vi.fn(),
    persistSessionPty: vi.fn(async () => {}),
    recordTabHistory: vi.fn(async () => {}),
    setSessionAuxState: vi.fn(),
    persistSessionAuxState: vi.fn(async () => {}),
    setSessionResumeToken: vi.fn(),
    persistSessionResumeToken: vi.fn(async () => {}),
    reportError: vi.fn(),
    clearSessionPty: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    closeSessionByPtyId: vi.fn(async () => {}),
    closePtyAndCaptureResume: vi.fn(async () => ({ resumeToken: "resume-2" })),
    killPty: vi.fn(async () => {}),
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("session-lifecycle-controller", () => {
  it("captures resume token and persists cleared PTY state", async () => {
    const deps = createDeps();
    const controller = createSessionLifecycleController(deps);

    await expect(controller.captureSessionResumeToken("session-1")).resolves.toBe("resume-2");

    expect(deps.closePtyAndCaptureResume).toHaveBeenCalledWith(42, "claude");
    expect(deps.setSessionPtyId).toHaveBeenCalledWith("session-1", -1);
    expect(deps.setSessionResumeToken).toHaveBeenCalledWith("session-1", "resume-2");
    expect(deps.clearSessionPty).toHaveBeenCalledWith("session-1");
    expect(deps.persistSessionResumeToken).toHaveBeenCalledWith("session-1", "resume-2");
  });

  it("falls back to existing resume token when capture fails", async () => {
    const error = new Error("capture failed");
    const deps = createDeps(undefined, {
      closePtyAndCaptureResume: vi.fn(async () => {
        throw error;
      }),
    });
    const controller = createSessionLifecycleController(deps);

    await expect(controller.captureSessionResumeToken("session-1")).resolves.toBe("resume-1");

    expect(deps.reportError).toHaveBeenCalledWith("Failed to capture session resume token", error);
    expect(deps.setSessionPtyId).toHaveBeenCalledWith("session-1", -1);
    expect(deps.setSessionResumeToken).toHaveBeenCalledWith("session-1", "resume-1");
    expect(deps.clearSessionPty).toHaveBeenCalledWith("session-1");
    expect(deps.persistSessionResumeToken).toHaveBeenCalledWith("session-1", "resume-1");
  });

  it("ignores PTY exit while resume capture is in progress", async () => {
    const deferred = createDeferred<{ resumeToken: string | null }>();
    const deps = createDeps(undefined, {
      closePtyAndCaptureResume: vi.fn(() => deferred.promise),
    });
    const controller = createSessionLifecycleController(deps);

    const capturePromise = controller.captureSessionResumeToken("session-1");
    await Promise.resolve();

    await controller.handleExit(42);
    expect(deps.closeSessionByPtyId).not.toHaveBeenCalled();

    deferred.resolve({ resumeToken: "resume-2" });
    await capturePromise;
    await controller.handleExit(42);

    expect(deps.closeSessionByPtyId).toHaveBeenCalledWith(42);
  });

  it("suppresses all PTY exits while app-close resume capture is running", async () => {
    const deferred = createDeferred<{ resumeToken: string | null }>();
    const sessions = new Map<string, Session>([
      ["session-1", createSession({ ptyId: 42 })],
      [
        "session-2",
        createSession({
          id: "session-2",
          title: "Second",
          workDir: "/workspace/second",
          ptyId: 77,
          resumeToken: "resume-2",
        }),
      ],
    ]);
    const deps = createDeps(sessions, {
      closePtyAndCaptureResume: vi.fn((ptyId: number) => {
        if (ptyId === 42) {
          return deferred.promise;
        }
        return Promise.resolve({ resumeToken: `resume-${ptyId}` });
      }),
    });
    const controller = createSessionLifecycleController(deps);

    const closePromise = controller.captureResumeIdsBeforeAppClose();
    await Promise.resolve();

    await controller.handleExit(77);
    expect(deps.closeSessionByPtyId).not.toHaveBeenCalled();

    deferred.resolve({ resumeToken: "resume-42" });
    await closePromise;
    await controller.handleExit(77);

    expect(deps.closeSessionByPtyId).toHaveBeenCalledWith(77);
  });

  it("clears auxiliary runtime state before app close and records history", async () => {
    const sessions = new Map<string, Session>([
      [
        "session-1",
        createSession({
          auxPtyId: 9,
          auxVisible: true,
          auxHeightPercent: 28,
        }),
      ],
      [
        "session-2",
        createSession({
          id: "session-2",
          title: "Second",
          workDir: "/workspace/second",
          ptyId: -1,
          auxPtyId: -1,
          resumeToken: "resume-2",
        }),
      ],
    ]);
    const deps = createDeps(sessions);
    const controller = createSessionLifecycleController(deps);

    await controller.captureResumeIdsBeforeAppClose();

    expect(deps.killPty).toHaveBeenCalledWith(9);
    expect(deps.setSessionAuxState).toHaveBeenNthCalledWith(1, "session-1", -1, false, 28);
    expect(deps.persistSessionAuxState).toHaveBeenNthCalledWith(
      1,
      "session-1",
      null,
      false,
      28,
    );
    expect(deps.recordTabHistory).toHaveBeenNthCalledWith(
      1,
      "claude",
      "Ubuntu",
      "/workspace/demo",
      "Demo",
      "resume-2",
    );
    expect(deps.recordTabHistory).toHaveBeenNthCalledWith(
      2,
      "claude",
      "Ubuntu",
      "/workspace/second",
      "Second",
      "resume-2",
    );
    expect(deps.persistWorkspace).toHaveBeenCalledTimes(1);
  });

  it("records history and closes the session when closing a tab", async () => {
    const deps = createDeps();
    const controller = createSessionLifecycleController(deps);

    await controller.handleCloseTab("session-1");

    expect(deps.recordTabHistory).toHaveBeenCalledWith(
      "claude",
      "Ubuntu",
      "/workspace/demo",
      "Demo",
      "resume-2",
    );
    expect(deps.closeSession).toHaveBeenCalledWith("session-1");
  });

  it("releases app-close exit suppression after app-close capture fails", async () => {
    const sessions = new Map<string, Session>([
      ["session-1", createSession({ ptyId: 42 })],
      [
        "session-2",
        createSession({
          id: "session-2",
          title: "Second",
          workDir: "/workspace/second",
          ptyId: -1,
          resumeToken: "resume-2",
        }),
      ],
    ]);
    const error = new Error("history failed");
    const deps = createDeps(sessions, {
      recordTabHistory: vi.fn(async () => {
        throw error;
      }),
    });
    const controller = createSessionLifecycleController(deps);

    await expect(controller.captureResumeIdsBeforeAppClose()).rejects.toThrow("history failed");

    await controller.handleExit(77);
    expect(deps.closeSessionByPtyId).toHaveBeenCalledWith(77);
  });
});
