import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { initializeSettings, updateSettings } from "../../../stores/settings.svelte";
import { DEFAULT_SETTINGS } from "../../../types";
import { editorPickerItemTestId, TEST_IDS } from "../../../testids";
import type { SessionShellSession } from "../contracts/session-shell";
import SessionShell from "./SessionShell.svelte";

const editorMocks = vi.hoisted(() => ({
  readSessionFile: vi.fn(),
  writeSessionFile: vi.fn(),
  listSessionFiles: vi.fn(),
  resolveTerminalPath: vi.fn(),
  openInEditor: vi.fn(),
  listAvailableEditors: vi.fn(),
}));

vi.mock("../../../components/Terminal.svelte", async () => {
  const module = await import("./test-fixtures/HostProbe.svelte");
  return { default: module.default };
});

vi.mock("../../terminal/view/TerminalEmbeddedEditorSurface.svelte", async () => {
  const module = await import("./test-fixtures/EmbeddedEditorSurfaceProbe.svelte");
  return { default: module.default };
});

vi.mock("../../agent-runtime/view/AgentTranscriptSurface.svelte", async () => {
  const module = await import("./test-fixtures/HostProbe.svelte");
  return { default: module.default };
});

vi.mock("../../../editors", () => ({
  readSessionFile: editorMocks.readSessionFile,
  writeSessionFile: editorMocks.writeSessionFile,
  listSessionFiles: editorMocks.listSessionFiles,
  resolveTerminalPath: editorMocks.resolveTerminalPath,
  openInEditor: editorMocks.openInEditor,
  listAvailableEditors: editorMocks.listAvailableEditors,
}));

vi.mock("../../../editor/monaco-host", () => ({
  warmMonacoEditorRuntime: vi.fn(async () => undefined),
}));

const BASE_SESSION: SessionShellSession = {
  id: "session-a",
  agentId: "claude",
  distro: "Ubuntu",
  workDir: "/workspace/a",
  ptyId: 11,
  auxPtyId: -1,
  auxVisible: false,
  auxHeightPercent: null,
  resumeToken: null,
  viewMode: "terminal",
  editorRootDir: "/workspace/a",
  openEditorTabs: [],
  activeEditorPath: null,
};

describe("SessionShell", () => {
  beforeEach(() => {
    initializeI18n("ko", "ko-KR");
    initializeSettings({
      ...DEFAULT_SETTINGS,
      interface: {
        ...DEFAULT_SETTINGS.interface,
        fileOpenTarget: "internal",
        fileOpenMode: "default",
        defaultEditorId: "",
      },
    });
    editorMocks.readSessionFile.mockReset();
    editorMocks.readSessionFile.mockResolvedValue({
      wslPath: "/workspace/a/src/app.ts",
      content: "export const app = true;",
      languageId: "typescript",
      sizeBytes: 24,
      mtimeMs: 100,
    });
    editorMocks.writeSessionFile.mockReset();
    editorMocks.listSessionFiles.mockReset();
    editorMocks.listSessionFiles.mockResolvedValue({
      rootDir: "/workspace/a",
      results: [
        {
          wslPath: "/workspace/a/src/app.ts",
          relativePath: "src/app.ts",
          basename: "app.ts",
        },
      ],
    });
    editorMocks.resolveTerminalPath.mockReset();
    editorMocks.resolveTerminalPath.mockResolvedValue({
      kind: "resolved",
      path: {
        raw: "/workspace/a/src/app.ts",
        wslPath: "/workspace/a/src/app.ts",
        copyText: "/workspace/a/src/app.ts",
        windowsPath: "C:\\workspace\\a\\src\\app.ts",
        line: null,
        column: null,
        isDirectory: false,
      },
    });
    editorMocks.openInEditor.mockReset();
    editorMocks.openInEditor.mockResolvedValue(undefined);
    editorMocks.listAvailableEditors.mockReset();
    editorMocks.listAvailableEditors.mockResolvedValue([
      { id: "cursor", label: "Cursor" },
      { id: "code", label: "VS Code" },
    ]);
  });

  it("shows that legacy PTY sessions do not provide structured permission guarantees", () => {
    render(SessionShell, {
      props: {
        session: BASE_SESSION,
        visible: true,
      },
    });

    expect(screen.getByTestId(TEST_IDS.legacyPtyPermissionNotice).textContent).toContain(
      "구조화 권한 보장",
    );
  });

  it("does not show the legacy PTY warning for direct runtime sessions", () => {
    render(SessionShell, {
      props: {
        session: {
          ...BASE_SESSION,
          runtimeKind: "direct-codex",
        },
        visible: true,
      },
    });

    expect(screen.queryByTestId(TEST_IDS.legacyPtyPermissionNotice)).toBeNull();
    expect(screen.getByTestId("session-host-probe")).toHaveAttribute(
      "data-runtime-kind",
      "direct-codex",
    );
  });

  it("OQ-61: wires direct tool location clicks into the embedded editor state", async () => {
    const onSessionEditorStateChange = vi.fn();

    render(SessionShell, {
      props: {
        session: {
          ...BASE_SESSION,
          runtimeKind: "direct-codex",
        },
        visible: true,
        onSessionEditorStateChange,
      },
    });

    await fireEvent.click(screen.getByTestId("host-open-location"));

    await waitFor(() => {
      expect(editorMocks.readSessionFile).toHaveBeenCalledWith(
        "session-a",
        "/workspace/a/src/app.ts",
      );
    });

    const editorProbe = screen.getByTestId("embedded-editor-probe");
    await waitFor(() => {
      expect(editorProbe).toHaveAttribute("data-view-mode", "editor");
      expect(editorProbe).toHaveAttribute("data-active-path", "/workspace/a/src/app.ts");
      expect(editorProbe).toHaveAttribute("data-active-line", "12");
      expect(editorProbe).toHaveAttribute("data-active-column", "3");
    });
    expect(onSessionEditorStateChange).toHaveBeenLastCalledWith("session-a", {
      viewMode: "editor",
      editorRootDir: "/workspace/a",
      openEditorTabs: [{ wslPath: "/workspace/a/src/app.ts", line: 12, column: 3 }],
      activeEditorPath: "/workspace/a/src/app.ts",
      dirtyPaths: [],
    });
  });

  it("OQ-61: honors the external default editor flow for direct tool locations", async () => {
    updateSettings({
      interface: {
        fileOpenTarget: "external",
        fileOpenMode: "default",
        defaultEditorId: "cursor",
      },
    });

    render(SessionShell, {
      props: {
        session: {
          ...BASE_SESSION,
          runtimeKind: "direct-codex",
        },
        visible: true,
      },
    });

    await fireEvent.click(screen.getByTestId("host-open-location"));

    await waitFor(() => {
      expect(editorMocks.openInEditor).toHaveBeenCalledWith("cursor", {
        raw: "/workspace/a/src/app.ts",
        wslPath: "/workspace/a/src/app.ts",
        copyText: "/workspace/a/src/app.ts:12:3",
        windowsPath: "C:\\workspace\\a\\src\\app.ts",
        line: 12,
        column: 3,
        isDirectory: false,
      });
    });
    expect(editorMocks.resolveTerminalPath).toHaveBeenCalledWith(
      "/workspace/a/src/app.ts",
      "Ubuntu",
      "/workspace/a",
      "session-a",
    );
    expect(editorMocks.readSessionFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("embedded-editor-probe")).toHaveAttribute(
      "data-view-mode",
      "terminal",
    );
  });

  it("OQ-61: shows the external editor picker for direct tool locations when configured", async () => {
    updateSettings({
      interface: {
        fileOpenTarget: "external",
        fileOpenMode: "picker",
        defaultEditorId: "code",
      },
    });

    render(SessionShell, {
      props: {
        session: {
          ...BASE_SESSION,
          runtimeKind: "direct-codex",
        },
        visible: true,
      },
    });

    await fireEvent.click(screen.getByTestId("host-open-location"));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.editorPickerModal)).toBeInTheDocument();
    });

    await fireEvent.click(screen.getByTestId(editorPickerItemTestId("cursor")));

    await waitFor(() => {
      expect(editorMocks.openInEditor).toHaveBeenCalledWith("cursor", {
        raw: "/workspace/a/src/app.ts",
        wslPath: "/workspace/a/src/app.ts",
        copyText: "/workspace/a/src/app.ts:12:3",
        windowsPath: "C:\\workspace\\a\\src\\app.ts",
        line: 12,
        column: 3,
        isDirectory: false,
      });
    });
    expect(editorMocks.readSessionFile).not.toHaveBeenCalled();
  });

  it("OQ-61: surfaces direct editor foreground errors through the direct notice", async () => {
    editorMocks.listSessionFiles.mockRejectedValue(new Error("quick open failed"));

    render(SessionShell, {
      props: {
        session: {
          ...BASE_SESSION,
          runtimeKind: "direct-codex",
        },
        visible: true,
      },
    });

    await fireEvent.click(screen.getByTestId("embedded-editor-open-file"));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("quick open failed");
    });
  });
});
