import { describe, expect, it, vi } from "vitest";
import { createSessionHostProps } from "./session-shell-adapter";

describe("session-shell-adapter", () => {
  it("maps a session and binds session-scoped callbacks for host components", () => {
    const onSessionEditorStateChange = vi.fn();
    const onSessionPtyId = vi.fn();
    const onSessionAuxStateChange = vi.fn();
    const onSessionExit = vi.fn();
    const onSessionResumeFallback = vi.fn();

    const hostProps = createSessionHostProps({
      session: {
        id: "session-1",
        agentId: "claude",
        distro: "Ubuntu",
        workDir: "/workspace",
        ptyId: 12,
        auxPtyId: 34,
        auxVisible: true,
        auxHeightPercent: 28,
        resumeToken: "resume-1",
        viewMode: "editor",
        editorRootDir: "/workspace/src",
        openEditorTabs: [{ wslPath: "/workspace/src/a.ts", line: 3, column: 7 }],
        activeEditorPath: "/workspace/src/a.ts",
      },
      visible: true,
      onSessionEditorStateChange,
      onSessionPtyId,
      onSessionAuxStateChange,
      onSessionExit,
      onSessionResumeFallback,
    });

    expect(hostProps).toMatchObject({
      sessionId: "session-1",
      visible: true,
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/workspace",
      ptyId: 12,
      storedAuxPtyId: 34,
      storedAuxVisible: true,
      storedAuxHeightPercent: 28,
      resumeToken: "resume-1",
      sessionSnapshot: {
        viewMode: "editor",
        editorRootDir: "/workspace/src",
        openEditorTabs: [{ wslPath: "/workspace/src/a.ts", line: 3, column: 7 }],
        activeEditorPath: "/workspace/src/a.ts",
      },
    });

    hostProps.onEditorSessionStateChange?.({
      viewMode: "terminal",
      editorRootDir: "/workspace",
      openEditorTabs: [],
      activeEditorPath: null,
      dirtyPaths: [],
    });
    hostProps.onPtyId?.(99);
    hostProps.onAuxStateChange?.({
      auxPtyId: 77,
      auxVisible: false,
      auxHeightPercent: null,
    });
    hostProps.onExit?.(99);
    hostProps.onResumeFallback?.();

    expect(onSessionEditorStateChange).toHaveBeenCalledWith("session-1", {
      viewMode: "terminal",
      editorRootDir: "/workspace",
      openEditorTabs: [],
      activeEditorPath: null,
      dirtyPaths: [],
    });
    expect(onSessionPtyId).toHaveBeenCalledWith("session-1", 99);
    expect(onSessionAuxStateChange).toHaveBeenCalledWith("session-1", {
      auxPtyId: 77,
      auxVisible: false,
      auxHeightPercent: null,
    });
    expect(onSessionExit).toHaveBeenCalledWith(99);
    expect(onSessionResumeFallback).toHaveBeenCalledWith("session-1");
  });
});
