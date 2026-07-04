import { describe, expect, it, vi } from "vitest";
import { createEditorQuickOpenState } from "../state/editor-quick-open-state.svelte";
import { createEditorRuntimeState } from "../state/editor-runtime-state.svelte";
import { createEditorSessionHydrationController } from "./editor-session-hydration-controller";

function createController(options?: {
  sessionSnapshot?: {
    viewMode: "terminal" | "editor";
    editorRootDir: string;
    openEditorTabs: { wslPath: string; line?: number | null; column?: number | null }[];
    activeEditorPath: string | null;
  } | null;
  readSessionFileImpl?: (sessionId: string, wslPath: string) => Promise<{
    wslPath: string;
    content: string;
    languageId: string;
    sizeBytes: number;
    mtimeMs: number;
  }>;
  /** 지정하면 shouldDeferContentLoading 게이트를 켠다(visible=false → content 지연). */
  visible?: boolean;
}) {
  const runtimeState = createEditorRuntimeState();
  const quickOpenState = createEditorQuickOpenState();
  let sessionSnapshot = options?.sessionSnapshot ?? null;
  let visible = options?.visible ?? true;
  let viewMode: "terminal" | "editor" = "editor";
  let rootDir = "/workspace";
  const syncSessionState = vi.fn();
  const readSessionFile = vi.fn(
    options?.readSessionFileImpl
      ?? (async (_sessionId: string, wslPath: string) => ({
        wslPath,
        content: "alpha",
        languageId: "typescript",
        sizeBytes: 5,
        mtimeMs: 12,
      })),
  );
  const setTabs = vi.fn((tabs) => {
    runtimeState.tabs = tabs;
    syncSessionState("session-1", {
      viewMode,
      editorRootDir: rootDir,
      openEditorTabs: tabs.map((tab: { wslPath: string; line?: number | null; column?: number | null }) => ({
        wslPath: tab.wslPath,
        line: tab.line ?? null,
        column: tab.column ?? null,
      })),
      activeEditorPath: runtimeState.activePath,
      dirtyPaths: [],
    });
  });

  const controller = createEditorSessionHydrationController({
    runtimeState,
    quickOpenState,
    getSessionId: () => "session-1",
    getSessionSnapshot: () => sessionSnapshot,
    getWorkDir: () => "/workspace",
    setViewMode: (nextViewMode) => {
      viewMode = nextViewMode;
    },
    setRootDir: (nextRootDir) => {
      rootDir = nextRootDir;
    },
    readSessionFile,
    setTabs,
    shouldDeferContentLoading: options?.visible === undefined ? undefined : () => !visible,
    syncSessionState: () => {
      syncSessionState("session-1", {
        viewMode,
        editorRootDir: rootDir,
        openEditorTabs: runtimeState.tabs.map((tab) => ({
          wslPath: tab.wslPath,
          line: tab.line ?? null,
          column: tab.column ?? null,
        })),
        activeEditorPath: runtimeState.activePath,
        dirtyPaths: [],
      });
    },
  });

  syncSessionState.mockImplementation((sessionId, sessionState) => {
    controller.markSessionStateSynced(sessionId, sessionState);
  });

  return {
    controller,
    runtimeState,
    quickOpenState,
    readSessionFile,
    syncSessionState,
    getViewMode: () => viewMode,
    getRootDir: () => rootDir,
    setVisible: (nextVisible: boolean) => {
      visible = nextVisible;
    },
    setSessionSnapshot: (
      nextSessionSnapshot: {
        viewMode: "terminal" | "editor";
        editorRootDir: string;
        openEditorTabs: { wslPath: string; line?: number | null; column?: number | null }[];
        activeEditorPath: string | null;
      } | null,
    ) => {
      sessionSnapshot = nextSessionSnapshot;
    },
  };
}

describe("editor-session-hydration-controller", () => {
  it("hydrates runtime state from the current session snapshot", async () => {
    const { controller, runtimeState, quickOpenState, readSessionFile, syncSessionState, getViewMode, getRootDir } =
      createController({
        sessionSnapshot: {
          viewMode: "editor",
          editorRootDir: "/workspace/src",
          openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
          activeEditorPath: "/workspace/src/a.ts",
        },
      });

    await controller.ensureRuntimeReady();

    expect(getViewMode()).toBe("editor");
    expect(getRootDir()).toBe("/workspace/src");
    expect(quickOpenState.rootDir).toBe("/workspace/src");
    expect(readSessionFile).toHaveBeenCalledWith("session-1", "/workspace/src/a.ts");
    expect(runtimeState.tabs).toMatchObject([
      {
        wslPath: "/workspace/src/a.ts",
        content: "alpha",
        languageId: "typescript",
        dirty: false,
        loading: false,
        saving: false,
        error: null,
      },
    ]);
    expect(runtimeState.activePath).toBe("/workspace/src/a.ts");
    expect(syncSessionState).toHaveBeenLastCalledWith("session-1", {
      viewMode: "editor",
      editorRootDir: "/workspace/src",
      openEditorTabs: [{ wslPath: "/workspace/src/a.ts", line: null, column: null }],
      activeEditorPath: "/workspace/src/a.ts",
      dirtyPaths: [],
    });
  });

  it("rehydrates when the mounted session receives a new external snapshot", async () => {
    const { controller, runtimeState, getViewMode, getRootDir, readSessionFile, setSessionSnapshot } =
      createController({
        sessionSnapshot: {
          viewMode: "editor",
          editorRootDir: "/workspace/src",
          openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
          activeEditorPath: "/workspace/src/a.ts",
        },
      });

    await controller.ensureRuntimeReady();

    setSessionSnapshot({
      viewMode: "terminal",
      editorRootDir: "/workspace/next",
      openEditorTabs: [],
      activeEditorPath: null,
    });

    await controller.ensureRuntimeReady();

    expect(getViewMode()).toBe("terminal");
    expect(getRootDir()).toBe("/workspace/next");
    expect(runtimeState.tabs).toEqual([]);
    expect(runtimeState.activePath).toBeNull();
    expect(readSessionFile).toHaveBeenCalledTimes(1);
  });

  it("does not rehydrate when the external snapshot only reflects the current runtime state", async () => {
    const { controller, readSessionFile, syncSessionState, setSessionSnapshot } = createController({
      sessionSnapshot: {
        viewMode: "terminal",
        editorRootDir: "/workspace",
        openEditorTabs: [],
        activeEditorPath: null,
      },
    });

    await controller.ensureRuntimeReady();
    const latestSessionState = syncSessionState.mock.calls[syncSessionState.mock.calls.length - 1]?.[1];
    expect(latestSessionState).toBeTruthy();

    setSessionSnapshot({
      viewMode: latestSessionState.viewMode,
      editorRootDir: latestSessionState.editorRootDir,
      openEditorTabs: latestSessionState.openEditorTabs,
      activeEditorPath: latestSessionState.activeEditorPath,
    });

    await controller.ensureRuntimeReady();

    expect(readSessionFile).toHaveBeenCalledTimes(0);
  });

  it("cancels an in-flight hydrate when the same session snapshot clears all open tabs", async () => {
    type ReadSessionFileResponse = {
      wslPath: string;
      content: string;
      languageId: string;
      sizeBytes: number;
      mtimeMs: number;
    };
    let resolveRead!: (value: ReadSessionFileResponse) => void;
    const { controller, runtimeState, setSessionSnapshot } = createController({
      sessionSnapshot: {
        viewMode: "editor",
        editorRootDir: "/workspace/src",
        openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
        activeEditorPath: "/workspace/src/a.ts",
      },
      readSessionFileImpl: async () =>
        await new Promise<ReadSessionFileResponse>((resolve) => {
          resolveRead = resolve;
        }),
    });

    const firstHydration = controller.ensureRuntimeReady();

    setSessionSnapshot({
      viewMode: "terminal",
      editorRootDir: "/workspace",
      openEditorTabs: [],
      activeEditorPath: null,
    });

    await controller.ensureRuntimeReady();
    resolveRead({
      wslPath: "/workspace/src/a.ts",
      content: "alpha",
      languageId: "typescript",
      sizeBytes: 5,
      mtimeMs: 12,
    });
    await firstHydration;

    expect(runtimeState.tabs).toEqual([]);
    expect(runtimeState.activePath).toBeNull();
  });

  it("defer: 숨김 탭은 메타데이터/placeholder만 적용하고 파일 content 읽기를 지연한다", async () => {
    const { controller, runtimeState, readSessionFile, getViewMode, getRootDir } = createController({
      visible: false,
      sessionSnapshot: {
        viewMode: "editor",
        editorRootDir: "/workspace/src",
        openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
        activeEditorPath: "/workspace/src/a.ts",
      },
    });

    await controller.ensureRuntimeReady();

    // 메타데이터는 즉시 적용된다(포커스 시 terminal→editor 깜빡임 방지).
    expect(getViewMode()).toBe("editor");
    expect(getRootDir()).toBe("/workspace/src");
    expect(runtimeState.tabs).toMatchObject([{ wslPath: "/workspace/src/a.ts", loading: true }]);
    // 파일 IPC 읽기는 지연된다(다중 세션 동시 복원 AppHang 완화).
    expect(readSessionFile).not.toHaveBeenCalled();

    await controller.completeDeferredContentHydration();

    expect(readSessionFile).toHaveBeenCalledWith("session-1", "/workspace/src/a.ts");
    expect(runtimeState.tabs).toMatchObject([
      { wslPath: "/workspace/src/a.ts", content: "alpha", loading: false },
    ]);
  });

  it("defer: 지연 중 재hydrate가 오면 이전 지연분은 폐기되고 최신 snapshot의 content만 로드된다", async () => {
    const { controller, readSessionFile, runtimeState, setSessionSnapshot } = createController({
      visible: false,
      sessionSnapshot: {
        viewMode: "editor",
        editorRootDir: "/workspace/src",
        openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
        activeEditorPath: "/workspace/src/a.ts",
      },
    });

    await controller.ensureRuntimeReady();

    setSessionSnapshot({
      viewMode: "editor",
      editorRootDir: "/workspace/src",
      openEditorTabs: [{ wslPath: "/workspace/src/b.ts" }],
      activeEditorPath: "/workspace/src/b.ts",
    });
    await controller.ensureRuntimeReady();

    await controller.completeDeferredContentHydration();

    expect(readSessionFile).toHaveBeenCalledTimes(1);
    expect(readSessionFile).toHaveBeenCalledWith("session-1", "/workspace/src/b.ts");
    expect(runtimeState.tabs).toMatchObject([{ wslPath: "/workspace/src/b.ts", content: "alpha" }]);
  });

  it("defer: 완료 전 사용자가 편집한(dirty) 탭은 지연 로드가 덮어쓰지 않는다", async () => {
    const { controller, runtimeState, readSessionFile } = createController({
      visible: false,
      sessionSnapshot: {
        viewMode: "editor",
        editorRootDir: "/workspace/src",
        openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
        activeEditorPath: "/workspace/src/a.ts",
      },
    });
    await controller.ensureRuntimeReady();

    // 첫 visible 직후 사용자가 placeholder 모델에 타이핑한 상황을 재현한다.
    runtimeState.tabs = runtimeState.tabs.map((tab) => ({
      ...tab,
      content: "user edit",
      dirty: true,
    }));

    await controller.completeDeferredContentHydration();

    expect(readSessionFile).toHaveBeenCalledTimes(1);
    // 사용자 편집(content/dirty)은 보존하되, 로드 기준선을 병합하고 loading을 내려
    // 저장 버튼 영구 비활성/빈 baseline으로 인한 dirty 오판정을 막는다.
    expect(runtimeState.tabs).toMatchObject([
      {
        wslPath: "/workspace/src/a.ts",
        content: "user edit",
        dirty: true,
        loading: false,
        languageId: "typescript",
      },
    ]);
    expect(runtimeState.savedContentByPath["/workspace/src/a.ts"]).toBe("alpha");
    expect(runtimeState.mtimeByPath["/workspace/src/a.ts"]).toBe(12);
  });

  it("defer: 완료 전 닫힌 탭은 지연 로드가 되살리지 않는다", async () => {
    const { controller, runtimeState, readSessionFile } = createController({
      visible: false,
      sessionSnapshot: {
        viewMode: "editor",
        editorRootDir: "/workspace/src",
        openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
        activeEditorPath: "/workspace/src/a.ts",
      },
    });
    await controller.ensureRuntimeReady();

    // 완료 전에 사용자가 탭을 닫은 상황을 재현한다.
    runtimeState.tabs = [];

    await controller.completeDeferredContentHydration();

    expect(readSessionFile).toHaveBeenCalledTimes(1);
    expect(runtimeState.tabs).toEqual([]);
  });

  it("defer: 지연분이 없으면 completeDeferredContentHydration은 no-op이다", async () => {
    const { controller, readSessionFile } = createController({
      visible: true,
      sessionSnapshot: {
        viewMode: "editor",
        editorRootDir: "/workspace/src",
        openEditorTabs: [{ wslPath: "/workspace/src/a.ts" }],
        activeEditorPath: "/workspace/src/a.ts",
      },
    });

    // visible이므로 즉시 로드된다.
    await controller.ensureRuntimeReady();
    expect(readSessionFile).toHaveBeenCalledTimes(1);

    await controller.completeDeferredContentHydration();
    expect(readSessionFile).toHaveBeenCalledTimes(1);
  });
});
