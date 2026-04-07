import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import type { Session } from "../../../types";
import SessionViewport from "./SessionViewport.svelte";
import SessionShellProbe from "./test-fixtures/SessionShellProbe.svelte";

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

describe("SessionViewport", () => {
  it("passes session-scoped callbacks through the session shell component", async () => {
    initializeI18n("ko", "ko-KR");
    const onSessionEditorStateChange = vi.fn();
    const onSessionPtyId = vi.fn();
    const onSessionAuxStateChange = vi.fn();
    const onSessionExit = vi.fn();
    const onSessionResumeFallback = vi.fn();

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
      SessionShellComponent: SessionShellProbe,
      onOpenHistory: vi.fn(),
      onConfirmSession: vi.fn(),
      onSessionEditorStateChange,
      onSessionPtyId,
      onSessionAuxStateChange,
      onSessionExit,
      onSessionResumeFallback,
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
  });
});
