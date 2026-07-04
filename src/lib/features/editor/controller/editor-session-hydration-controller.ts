import type { InternalEditorTab } from "../../../editor/contracts";
import type { ReadSessionFileResult } from "../../../editors";
import type {
  SessionEditorSnapshot,
  SessionEditorState,
  SessionViewMode,
} from "../../../types";
import {
  buildEditorHydrationPlaceholderTabs,
  loadHydratedEditorTabs,
  resolveHydratedActivePath,
  splitHydratedEditorTabs,
} from "../service/editor-session-hydration";
import type { EditorQuickOpenState } from "../state/editor-quick-open-state.svelte";
import type { EditorRuntimeState } from "../state/editor-runtime-state.svelte";

type EditorHydrationSource = Pick<
  SessionEditorSnapshot,
  "viewMode" | "editorRootDir" | "openEditorTabs" | "activeEditorPath"
>;

interface EditorSessionHydrationControllerDependencies {
  runtimeState: EditorRuntimeState;
  quickOpenState: EditorQuickOpenState;
  getSessionId: () => string;
  getSessionSnapshot: () => EditorHydrationSource | null;
  getWorkDir: () => string;
  setViewMode: (viewMode: SessionViewMode) => void;
  setRootDir: (rootDir: string) => void;
  readSessionFile: (sessionId: string, wslPath: string) => Promise<ReadSessionFileResult>;
  setTabs: (tabs: InternalEditorTab[]) => void;
  syncSessionState: () => void;
  /**
   * true를 반환하면 파일 content IPC 읽기를 지연한다(다중 세션 동시 복원 AppHang 완화).
   * viewMode/rootDir/placeholder 탭 같은 메타데이터는 항상 즉시 적용되고, 지연된 content는
   * completeDeferredContentHydration() 호출(첫 visible) 시 로드된다. 미지정이면 항상 즉시 로드.
   */
  shouldDeferContentLoading?: () => boolean;
}

export function createEditorSessionHydrationController(
  deps: EditorSessionHydrationControllerDependencies,
) {
  let hydratedSessionId: string | null = null;
  let hydratedSessionSnapshotKey: string | null = null;
  let hydrationToken = 0;
  /** 숨김 탭에서 지연된 content 로드 입력(첫 visible 때 completeDeferredContentHydration이 소비). */
  let pendingContentLoad: {
    refs: NonNullable<EditorHydrationSource["openEditorTabs"]>;
    token: number;
  } | null = null;

  function buildHydrationSourceKey(source: EditorHydrationSource | null) {
    return JSON.stringify({
      sessionId: deps.getSessionId(),
      viewMode: source?.viewMode ?? "terminal",
      editorRootDir: source?.editorRootDir || deps.getWorkDir(),
      openEditorTabs: (source?.openEditorTabs ?? []).map((entry) => ({
        wslPath: entry.wslPath,
        line: entry.line ?? null,
        column: entry.column ?? null,
      })),
      activeEditorPath: source?.activeEditorPath ?? null,
    });
  }

  function buildSessionStateHydrationKey(sessionState: SessionEditorState) {
    return buildHydrationSourceKey({
      viewMode: sessionState.viewMode,
      editorRootDir: sessionState.editorRootDir,
      openEditorTabs: sessionState.openEditorTabs,
      activeEditorPath: sessionState.activeEditorPath,
    });
  }

  function markSessionStateSynced(sessionId: string, sessionState: SessionEditorState) {
    hydratedSessionId = sessionId;
    hydratedSessionSnapshotKey = buildSessionStateHydrationKey(sessionState);
  }

  async function hydrateFromSession() {
    const session = deps.getSessionSnapshot();
    const token = ++hydrationToken;
    pendingContentLoad = null;
    hydratedSessionId = deps.getSessionId();
    hydratedSessionSnapshotKey = buildHydrationSourceKey(session);
    deps.setViewMode(session?.viewMode ?? "terminal");
    deps.setRootDir(session?.editorRootDir || deps.getWorkDir());
    deps.quickOpenState.rootDir = session?.editorRootDir || deps.getWorkDir();
    deps.runtimeState.activePath = session?.activeEditorPath ?? null;
    deps.runtimeState.savedContentByPath = {};
    deps.runtimeState.mtimeByPath = {};

    const refs = session?.openEditorTabs ?? [];
    if (refs.length === 0) {
      deps.setTabs([]);
      return;
    }

    deps.setTabs(buildEditorHydrationPlaceholderTabs(refs));

    if (deps.shouldDeferContentLoading?.()) {
      // 메타데이터(placeholder 탭 포함)까지만 적용하고 파일 IPC 읽기는 첫 visible로 미룬다.
      pendingContentLoad = { refs, token };
      return;
    }

    await loadTabContents(refs, token);
  }

  /** placeholder 탭의 실제 파일 content를 IPC로 읽어 채운다(hydrateFromSession 후반부). */
  async function loadTabContents(
    refs: NonNullable<EditorHydrationSource["openEditorTabs"]>,
    token: number,
  ) {
    const loadedTabs = await loadHydratedEditorTabs(
      { readSessionFile: deps.readSessionFile },
      deps.getSessionId(),
      refs,
    );

    if (token !== hydrationToken) {
      return;
    }

    const { tabs, savedContentByPath, mtimeByPath } = splitHydratedEditorTabs(loadedTabs);
    // 로드가 도는 사이(특히 지연 로드의 첫 visible 이후) 사용자가 탭을 닫았거나(현재 목록에 없음)
    // 타이핑했거나(dirty) 직접 열어 이미 로드를 끝낸(loading 아님) 탭은 보존하고, 아직 loading
    // placeholder인 탭만 로드 결과로 교체한다 — 전체 교체는 이 윈도우의 사용자 편집을 덮어쓰거나
    // 닫은 탭을 되살린다.
    const loadedByPath = new Map(tabs.map((tab) => [tab.wslPath, tab]));
    const nextSavedContentByPath = { ...deps.runtimeState.savedContentByPath };
    const nextMtimeByPath = { ...deps.runtimeState.mtimeByPath };
    const nextTabs = deps.runtimeState.tabs.map((current) => {
      const loaded = loadedByPath.get(current.wslPath);
      if (!loaded || current.dirty || !current.loading) {
        return current;
      }
      if (current.wslPath in savedContentByPath) {
        nextSavedContentByPath[current.wslPath] = savedContentByPath[current.wslPath];
      }
      if (current.wslPath in mtimeByPath) {
        nextMtimeByPath[current.wslPath] = mtimeByPath[current.wslPath];
      }
      return loaded;
    });
    deps.runtimeState.savedContentByPath = nextSavedContentByPath;
    deps.runtimeState.mtimeByPath = nextMtimeByPath;
    deps.runtimeState.tabs = nextTabs;
    deps.runtimeState.activePath = resolveHydratedActivePath(deps.runtimeState.activePath, nextTabs);

    deps.syncSessionState();
  }

  /** 숨김 탭에서 지연해 둔 content 로드를 실행한다(첫 visible). 지연분이 없으면 no-op. */
  async function completeDeferredContentHydration() {
    if (!pendingContentLoad) return;
    const { refs, token } = pendingContentLoad;
    pendingContentLoad = null;
    if (token !== hydrationToken) return;
    await loadTabContents(refs, token);
  }

  async function ensureRuntimeReady() {
    const nextSessionId = deps.getSessionId();
    const nextSessionSnapshotKey = buildHydrationSourceKey(deps.getSessionSnapshot());
    if (
      hydratedSessionId === nextSessionId
      && hydratedSessionSnapshotKey === nextSessionSnapshotKey
    ) {
      return;
    }

    await hydrateFromSession();
  }

  return {
    ensureRuntimeReady,
    hydrateFromSession,
    completeDeferredContentHydration,
    markSessionStateSynced,
  };
}
