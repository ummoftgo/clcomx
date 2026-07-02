<!--
  SessionShell — host 분기(옵션 B, 08 §9.1).

  session.runtimeKind가 "direct-*"면 direct agent runtime host(AgentTranscriptSurface)를,
  아니면 기존 terminal host(Terminal)를 렌더한다. SessionHostProps는 두 host에 동형으로 넘긴다.
  direct 경로에서 onPtyId 등 PTY 전제 콜백은 host가 호출하지 않으므로 그대로 전달돼도 no-op이다.
-->
<script lang="ts">
  import EditorPickerModal from "../../../components/EditorPickerModal.svelte";
  import Terminal from "../../../components/Terminal.svelte";
  import { warmMonacoEditorRuntime } from "../../../editor/monaco-host";
  import {
    openInEditor,
    listSessionFiles,
    readSessionFile,
    resolveTerminalPath,
    writeSessionFile,
    type DetectedEditor,
    type ResolvedTerminalPath,
  } from "../../../editors";
  import { t } from "../../../i18n";
  import { getSettings } from "../../../stores/settings.svelte";
  import { ensureEditorsDetected, getEditorDetectionState } from "../../../stores/editors.svelte";
  import { TEST_IDS } from "../../../testids";
  import type { FileLocation } from "../../agent-runtime/contracts/normalized";
  import { createEditorFacade } from "../../editor/controller/editor-facade";
  import { createEditorQuickOpenState } from "../../editor/state/editor-quick-open-state.svelte";
  import { createEditorRuntimeState } from "../../editor/state/editor-runtime-state.svelte";
  import { createOverlayFileLinkActions } from "../../terminal/controller/overlay-file-link-actions";
  import TerminalEmbeddedEditorSurface from "../../terminal/view/TerminalEmbeddedEditorSurface.svelte";
  import AgentTranscriptSurface from "../../agent-runtime/view/AgentTranscriptSurface.svelte";
  import type { SessionShellProps } from "../contracts/session-shell";
  import { createSessionHostProps } from "../service/session-shell-adapter";

  let props: SessionShellProps = $props();
  const settings = getSettings();
  const editorDetection = getEditorDetectionState();
  const hostProps = $derived(createSessionHostProps(props));
  let directEditorSessionId = "";
  let directEditorViewMode = $state<"terminal" | "editor">("terminal");
  let directEditorRootDir = $state("");
  let directEditorPickerVisible = $state(false);
  let directEditorPickerPath = $state<ResolvedTerminalPath | null>(null);
  let directFileOpenNotice = $state<string | null>(null);
  const directEditorQuickOpenState = createEditorQuickOpenState();
  const directEditorRuntimeState = createEditorRuntimeState();
  // runtimeKind: "pty" | "direct-codex" | "direct-claude"(15 §7). 미지정/pty는 기존 terminal.
  const useDirectRuntime = $derived(
    props.session.runtimeKind?.startsWith("direct-") ?? false,
  );
  const directEditorBusy = $derived(
    directEditorRuntimeState.tabs.some((tab) => tab.loading || tab.saving),
  );
  const directEditorSurfaceRootDir = $derived(directEditorRootDir || props.session.workDir);
  const directEditorCloseConfirmLabel = $derived(
    directEditorRuntimeState.closeConfirmPath
      ? directEditorRuntimeState.closeConfirmPath.split("/").pop() || directEditorRuntimeState.closeConfirmPath
      : "",
  );
  const directEditorSurfaceLabels = $derived({
    title: $t("terminal.editor.title"),
    emptyTitle: $t("terminal.editor.emptyTitle"),
    emptyDescription: $t("terminal.editor.emptyDescription"),
    saveLabel: $t("common.actions.save"),
    openFileLabel: $t("terminal.editor.openFile"),
    switchToTerminalLabel: $t("agentRuntime.editor.switchToTranscript"),
    quickOpenTitle: $t("terminal.editor.quickOpenTitle"),
    quickOpenDescription: $t("terminal.editor.quickOpenDescription"),
    quickOpenPlaceholder: $t("terminal.editor.quickOpenPlaceholder"),
    quickOpenIdleLabel: $t("terminal.editor.quickOpenIdle"),
    quickOpenEmptyLabel: $t("terminal.editor.quickOpenEmpty"),
    quickOpenLoadingLabel: $t("terminal.editor.quickOpenLoading"),
    refreshLabel: $t("common.actions.refresh"),
    closeLabel: $t("common.actions.close"),
    keyboardHintLabel: $t("terminal.editor.quickOpenKeyboardHint"),
  });
  const directEditorPickerEmptyLabel = $derived(
    editorDetection.error || $t("terminal.filePaths.noEditors"),
  );

  /** direct tool location path를 editor facade가 기대하는 WSL 절대 경로로 맞춘다. */
  function resolveDirectLocationPath(path: string) {
    if (path.startsWith("/")) return path;
    const base = props.session.workDir.replace(/\/+$/, "");
    return `${base}/${path.replace(/^\.?\//, "")}`;
  }

  /** direct tool location의 line/column을 복사·외부 editor 전달용 경로 문자열에 반영한다. */
  function formatDirectLocationCopyText(
    wslPath: string,
    line: number | null,
    column: number | null,
  ) {
    if (line === null) return wslPath;
    return column === null ? `${wslPath}:${line}` : `${wslPath}:${line}:${column}`;
  }

  /** internal editor만 필요한 direct location을 터미널 링크와 같은 path shape로 감싼다. */
  function createInternalDirectLocationPath(location: FileLocation): ResolvedTerminalPath {
    const wslPath = resolveDirectLocationPath(location.path);
    const line = location.line ?? null;
    const column = location.column ?? null;
    return {
      raw: location.path,
      wslPath,
      copyText: formatDirectLocationCopyText(wslPath, line, column),
      windowsPath: "",
      line,
      column,
      isDirectory: false,
    };
  }

  const directEditorFacade = createEditorFacade({
    runtimeState: directEditorRuntimeState,
    quickOpenState: directEditorQuickOpenState,
    getSessionId: () => props.session.id,
    getSessionSnapshot: () => hostProps.sessionSnapshot ?? null,
    getWorkDir: () => props.session.workDir,
    getViewMode: () => directEditorViewMode,
    setViewMode: (viewMode) => {
      directEditorViewMode = viewMode;
    },
    getRootDir: () => directEditorRootDir,
    setRootDir: (rootDir) => {
      directEditorRootDir = rootDir;
    },
    syncSessionState: (_sessionId, sessionState) => {
      void hostProps.onEditorSessionStateChange?.(sessionState);
    },
    prepareForEditorMode: () => {
      // direct host에는 PTY/aux preflight가 없으므로 editor surface 전환만 수행한다.
    },
    prepareForEditorPathOpen: () => {
      // direct host에는 닫아야 할 terminal overlay가 없다.
    },
    getLoadingStatusLabel: () => $t("common.labels.loading"),
    getSaveStatusLabel: () => $t("common.actions.save"),
    readSessionFile,
    writeSessionFile,
    getVisible: () => props.visible,
    getTerminalReady: () => true,
    getTerminalStartupSettled: () => true,
    getThemeDefinition: () => null,
    warmMonacoRuntime: warmMonacoEditorRuntime,
    listSessionFiles,
    reportForegroundError: (message) => {
      // quick-open 같은 foreground editor 오류를 direct host notice로 표면화한다.
      directFileOpenNotice = message;
    },
  });

  /** direct external editor picker를 열고 선택 대상 path를 보존한다. */
  function openDirectEditorPicker(path: ResolvedTerminalPath) {
    directFileOpenNotice = null;
    directEditorPickerPath = path;
    directEditorPickerVisible = true;
  }

  /** direct external editor picker 상태를 닫는다. */
  function closeDirectEditorPicker() {
    directEditorPickerVisible = false;
    directEditorPickerPath = null;
  }

  const directFileLinkActions = createOverlayFileLinkActions({
    getWorkDir: () => props.session.workDir,
    getFileOpenTarget: () => settings.interface.fileOpenTarget,
    getFileOpenMode: () => settings.interface.fileOpenMode,
    getDefaultEditorId: () => settings.interface.defaultEditorId,
    getEditorsError: () => editorDetection.error,
    ensureEditorsLoaded: () => ensureEditorsDetected(),
    openInEditor,
    openInternalEditorForLinkPath: directEditorFacade.openInternalEditorForLinkPath,
    openExternalUrl: async () => undefined,
    openEditorPicker: openDirectEditorPicker,
    writeClipboardText: async () => undefined,
    setNotice: (message) => {
      directFileOpenNotice = message;
    },
    reportError: (message, error) => {
      console.error(message, error);
    },
    t: (key, options) => $t(key, options),
  });

  /** external editor가 요구하는 Windows path를 기존 resolver로 보강한다. */
  async function resolveExternalDirectLocationPath(
    location: FileLocation,
  ): Promise<ResolvedTerminalPath | null> {
    const wslPath = resolveDirectLocationPath(location.path);
    const line = location.line ?? null;
    const column = location.column ?? null;

    try {
      const resolution = await resolveTerminalPath(
        wslPath,
        props.session.distro,
        props.session.workDir,
        props.session.id,
      );
      if (resolution.kind !== "resolved") {
        directFileOpenNotice = $t("terminal.filePaths.resolveFailed");
        return null;
      }

      return {
        ...resolution.path,
        raw: wslPath,
        line,
        column,
        copyText: formatDirectLocationCopyText(resolution.path.wslPath, line, column),
      };
    } catch (error) {
      console.error("Failed to resolve direct runtime file location", error);
      directFileOpenNotice = $t("terminal.filePaths.resolveFailed");
      return null;
    }
  }

  /** direct tool location을 설정에 맞는 internal/external file-open 경로로 연다. */
  async function openDirectLocationWithConfiguredTarget(location: FileLocation) {
    directFileOpenNotice = null;
    const path =
      settings.interface.fileOpenTarget === "internal"
        ? createInternalDirectLocationPath(location)
        : await resolveExternalDirectLocationPath(location);
    if (!path) return;

    try {
      await directFileLinkActions.openPathInEditor(path);
    } catch (error) {
      console.error("Failed to open direct runtime file location", error);
      directFileOpenNotice = $t("terminal.filePaths.openFailed");
    }
  }

  /** picker에서 선택한 외부 editor로 direct tool location을 연다. */
  async function handleDirectEditorSelect(editor: DetectedEditor) {
    const opened = await directFileLinkActions.handleEditorSelect(
      editor,
      directEditorPickerPath,
    );
    if (opened) {
      directFileOpenNotice = null;
      closeDirectEditorPicker();
    }
  }

  /** transcript tool location click을 기존 editor navigation adapter로 연결한다. */
  function openDirectLocation(location: FileLocation) {
    void openDirectLocationWithConfiguredTarget(location);
  }

  $effect(() => {
    if (directEditorSessionId !== props.session.id) {
      directEditorSessionId = props.session.id;
      directEditorViewMode = props.session.viewMode;
      directEditorRootDir = props.session.editorRootDir || props.session.workDir;
    }
  });

  $effect(() => {
    if (!useDirectRuntime) return;
    props.session.id;
    hostProps.sessionSnapshot;
    void directEditorFacade.ensureRuntimeReady();
  });
</script>

{#if useDirectRuntime}
  <div class="direct-runtime-host" class:hidden={!props.visible}>
    <div class="direct-transcript-host" class:hidden={directEditorViewMode === "editor"}>
      <AgentTranscriptSurface
        {...hostProps}
        onOpenLocation={openDirectLocation}
        onFallbackToPty={(context) => props.onSessionFallbackToPty?.(context)}
      />
    </div>
    <TerminalEmbeddedEditorSurface
      viewMode={directEditorViewMode}
      runtimeState={directEditorRuntimeState}
      quickOpenState={directEditorQuickOpenState}
      rootDir={directEditorSurfaceRootDir}
      busy={directEditorBusy}
      closeConfirmTitle={directEditorCloseConfirmLabel}
      labels={directEditorSurfaceLabels}
      onActivePathChange={directEditorFacade.handleActivePathChange}
      onCloseTab={directEditorFacade.requestCloseTab}
      onContentChange={directEditorFacade.handleContentChange}
      onSaveRequest={(wslPath) => void directEditorFacade.saveTab(wslPath)}
      onOpenFile={() => void directEditorFacade.openQuickOpen(directEditorSurfaceRootDir)}
      onSwitchToTerminal={directEditorFacade.switchToTerminalView}
      onListWorkspaceFiles={directEditorFacade.listWorkspaceFiles}
      onReadWorkspaceFile={directEditorFacade.readNavigationFile}
      onOpenLocation={directEditorFacade.openNavigationLocation}
      onRefreshQuickOpen={(forceRefresh) => void directEditorFacade.refreshQuickOpenEntries(forceRefresh)}
      onSelectQuickOpenResult={directEditorFacade.openPathFromQuickResult}
      onCloseQuickOpen={directEditorFacade.closeQuickOpen}
      onCancelCloseConfirm={directEditorFacade.cancelCloseTab}
      onConfirmCloseConfirm={directEditorFacade.confirmCloseTab}
    />
    <EditorPickerModal
      visible={directEditorPickerVisible}
      title={$t("terminal.filePaths.pickerTitle")}
      description={$t("terminal.filePaths.pickerDescription")}
      emptyLabel={directEditorPickerEmptyLabel}
      defaultEditorId={settings.interface.defaultEditorId}
      editors={editorDetection.editors}
      onSelect={(editor) => void handleDirectEditorSelect(editor)}
      onClose={closeDirectEditorPicker}
    />
    {#if directFileOpenNotice}
      <div class="direct-file-open-notice" role="status">{directFileOpenNotice}</div>
    {/if}
  </div>
{:else}
  <div class="legacy-pty-host" class:hidden={!props.visible}>
    <div
      class="legacy-pty-notice"
      role="note"
      data-testid={TEST_IDS.legacyPtyPermissionNotice}
    >
      <strong>{$t("agentRuntime.fallback.legacyPermissionTitle")}</strong>
      <span>{$t("agentRuntime.fallback.legacyPermissionDescription")}</span>
    </div>
    <div class="legacy-pty-terminal">
      <Terminal {...hostProps} />
    </div>
  </div>
{/if}

<style>
  .legacy-pty-host {
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--ui-bg-app, var(--app-bg));
  }

  .direct-runtime-host {
    width: 100%;
    height: 100%;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--ui-bg-app, var(--app-bg));
  }

  .direct-transcript-host {
    flex: 1 1 auto;
    min-height: 0;
  }

  .direct-runtime-host.hidden,
  .direct-transcript-host.hidden {
    position: absolute;
    left: -9999px;
    visibility: hidden;
  }

  .legacy-pty-host.hidden {
    position: absolute;
    left: -9999px;
    visibility: hidden;
  }

  .legacy-pty-notice {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-height: 2rem;
    padding: 0.35rem 0.75rem;
    border-bottom: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.25));
    background: var(--ui-bg-surface, rgba(127, 127, 127, 0.08));
    color: var(--ui-text-secondary, inherit);
    font-size: var(--ui-font-size-xs, 0.75rem);
  }

  .legacy-pty-notice strong {
    flex: 0 0 auto;
    color: var(--ui-text-primary, inherit);
    font-weight: 600;
  }

  .legacy-pty-notice span {
    min-width: 0;
  }

  .direct-file-open-notice {
    position: absolute;
    right: var(--ui-space-4, 16px);
    bottom: var(--ui-space-4, 16px);
    max-width: min(360px, calc(100% - 32px));
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.25));
    border-radius: var(--ui-radius-md, 8px);
    background: var(--ui-bg-elevated, rgba(24, 24, 28, 0.96));
    color: var(--ui-text-primary, inherit);
    font-size: var(--ui-font-size-sm, 0.875rem);
    box-shadow: var(--ui-shadow-popover, 0 8px 24px rgba(0, 0, 0, 0.24));
    z-index: 20;
  }

  .legacy-pty-terminal {
    flex: 1 1 auto;
    min-height: 0;
  }
</style>
