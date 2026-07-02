import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import type { Session, TabHistoryEntry } from "../../../types";
import SessionViewport from "./SessionViewport.svelte";
import SessionLauncherProbe from "./test-fixtures/SessionLauncherProbe.svelte";
import SessionShellProbe, {
  lifecycleLog,
  resetLifecycleLog,
} from "./test-fixtures/SessionShellProbe.svelte";

const BASE_SESSION: Session = {
  id: "session-a",
  agentId: "claude",
  resumeToken: null,
  title: "project-a",
  pinned: false,
  locked: false,
  distro: "Ubuntu",
  workDir: "/workspace/a",
  ptyId: 11,
  auxPtyId: -1,
  auxVisible: false,
  auxHeightPercent: null,
  viewMode: "terminal",
  editorRootDir: "/workspace/a",
  openEditorTabs: [],
  activeEditorPath: null,
  dirtyPaths: [],
};

const HISTORY_ENTRY: TabHistoryEntry = {
  agentId: "claude",
  distro: "Ubuntu",
  workDir: "/workspace/history",
  title: "History",
  resumeToken: "resume-1",
  lastOpenedAt: "2026-04-11T00:00:00.000Z",
};

describe("SessionViewport", () => {
  it("keeps mounted session shells when only activeSessionId changes (FE-21)", async () => {
    initializeI18n("ko", "ko-KR");
    resetLifecycleLog();
    const sessions = [
      BASE_SESSION,
      {
        ...BASE_SESSION,
        id: "session-b",
        title: "project-b",
        workDir: "/workspace/b",
        ptyId: 22,
      },
    ];
    const props = {
      sessions,
      activeSessionId: "session-a",
      historyEntries: [],
      SessionLauncherComponent: SessionLauncherProbe,
      SessionShellComponent: SessionShellProbe,
      onOpenHistory: vi.fn(),
      onConfirmSession: vi.fn(),
      onSessionEditorStateChange: vi.fn(),
      onSessionPtyId: vi.fn(),
      onSessionAuxStateChange: vi.fn(),
      onSessionExit: vi.fn(),
      onSessionResumeFallback: vi.fn(),
    };

    const view = render(SessionViewport, props);

    expect(lifecycleLog).toEqual(["mount:session-a", "mount:session-b"]);
    expect(screen.getByTestId("session-shell-probe-session-a")).toHaveAttribute("data-visible", "true");
    expect(screen.getByTestId("session-shell-probe-session-b")).toHaveAttribute("data-visible", "false");

    await view.rerender({
      ...props,
      activeSessionId: "session-b",
    });

    expect(lifecycleLog).toEqual(["mount:session-a", "mount:session-b"]);
    expect(screen.getByTestId("session-shell-probe-session-a")).toHaveAttribute("data-visible", "false");
    expect(screen.getByTestId("session-shell-probe-session-b")).toHaveAttribute("data-visible", "true");
  });

  it("passes session-scoped callbacks through the session shell component", async () => {
    initializeI18n("ko", "ko-KR");
    const onSessionEditorStateChange = vi.fn();
    const onSessionPtyId = vi.fn();
    const onSessionAuxStateChange = vi.fn();
    const onSessionExit = vi.fn();
    const onSessionResumeFallback = vi.fn();
    const onSessionAgentRuntimeStatusChange = vi.fn();
    const onSessionTitleChange = vi.fn();

    render(SessionViewport, {
      sessions: [
        BASE_SESSION,
        {
          ...BASE_SESSION,
          id: "session-b",
          title: "project-b",
          workDir: "/workspace/b",
          ptyId: 22,
        },
      ],
      activeSessionId: "session-b",
      historyEntries: [],
      SessionLauncherComponent: SessionLauncherProbe,
      SessionShellComponent: SessionShellProbe,
      onOpenHistory: vi.fn(),
      onConfirmSession: vi.fn(),
      onSessionEditorStateChange,
      onSessionPtyId,
      onSessionAuxStateChange,
      onSessionExit,
      onSessionResumeFallback,
      onSessionAgentRuntimeStatusChange,
      onSessionTitleChange,
    });

    const first = screen.getByTestId("session-shell-probe-session-a");
    const second = screen.getByTestId("session-shell-probe-session-b");

    expect(first).toHaveAttribute("data-visible", "false");
    expect(second).toHaveAttribute("data-visible", "true");

    await fireEvent.click(first);
    await fireEvent.click(second);

    expect(onSessionEditorStateChange).toHaveBeenNthCalledWith(1, "session-a", {
      viewMode: "editor",
      editorRootDir: "/workspace/a/src",
      openEditorTabs: [{ wslPath: "/workspace/a/src/App.svelte", line: 3, column: 7 }],
      activeEditorPath: "/workspace/a/src/App.svelte",
      dirtyPaths: [],
    });
    expect(onSessionEditorStateChange).toHaveBeenNthCalledWith(2, "session-b", {
      viewMode: "editor",
      editorRootDir: "/workspace/b/src",
      openEditorTabs: [{ wslPath: "/workspace/b/src/App.svelte", line: 3, column: 7 }],
      activeEditorPath: "/workspace/b/src/App.svelte",
      dirtyPaths: [],
    });
    expect(onSessionPtyId).toHaveBeenNthCalledWith(1, "session-a", 91);
    expect(onSessionPtyId).toHaveBeenNthCalledWith(2, "session-b", 91);
    expect(onSessionAuxStateChange).toHaveBeenNthCalledWith(1, "session-a", {
      auxPtyId: 52,
      auxVisible: true,
      auxHeightPercent: 33,
    });
    expect(onSessionAuxStateChange).toHaveBeenNthCalledWith(2, "session-b", {
      auxPtyId: 52,
      auxVisible: true,
      auxHeightPercent: 33,
    });
    expect(onSessionExit).toHaveBeenCalledTimes(2);
    expect(onSessionExit).toHaveBeenNthCalledWith(1, 91);
    expect(onSessionExit).toHaveBeenNthCalledWith(2, 91);
    expect(onSessionResumeFallback).toHaveBeenNthCalledWith(1, "session-a");
    expect(onSessionResumeFallback).toHaveBeenNthCalledWith(2, "session-b");
    expect(onSessionAgentRuntimeStatusChange).toHaveBeenNthCalledWith(1, "session-a", "running");
    expect(onSessionAgentRuntimeStatusChange).toHaveBeenNthCalledWith(2, "session-b", "running");
    expect(onSessionTitleChange).toHaveBeenNthCalledWith(1, "session-a", "Provider session-a");
    expect(onSessionTitleChange).toHaveBeenNthCalledWith(2, "session-b", "Provider session-b");
  });

  it("renders the injected launcher component for the empty session state", async () => {
    initializeI18n("ko", "ko-KR");
    const onOpenHistory = vi.fn();
    const onConfirmSession = vi.fn();

    render(SessionViewport, {
      sessions: [],
      activeSessionId: null,
      historyEntries: [HISTORY_ENTRY],
      SessionLauncherComponent: SessionLauncherProbe,
      SessionShellComponent: SessionShellProbe,
      onOpenHistory,
      onConfirmSession,
      onSessionEditorStateChange: vi.fn(),
      onSessionPtyId: vi.fn(),
      onSessionAuxStateChange: vi.fn(),
      onSessionExit: vi.fn(),
      onSessionResumeFallback: vi.fn(),
    });

    const launcher = screen.getByTestId("session-launcher-probe");
    expect(launcher).toHaveAttribute("data-visible", "true");
    expect(launcher).toHaveAttribute("data-embedded", "true");

    await fireEvent.click(launcher);

    expect(onOpenHistory).toHaveBeenCalledWith(HISTORY_ENTRY);
    expect(onConfirmSession).not.toHaveBeenCalled();
  });
});
