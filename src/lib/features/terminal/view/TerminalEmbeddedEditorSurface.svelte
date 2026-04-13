<script lang="ts">
  import type { NavigationFileSnapshot } from "../../../editor/navigation";
  import type { EditorSearchResult, ReadSessionFileResult } from "../../../editors";
  import type { EditorQuickOpenState } from "../../editor/state/editor-quick-open-state.svelte";
  import type { EditorRuntimeState } from "../../editor/state/editor-runtime-state.svelte";
  import InternalEditor from "../../../components/InternalEditor.svelte";
  import EditorQuickOpenModal from "../../../components/EditorQuickOpenModal.svelte";
  import TerminalEditorCloseConfirmModal from "./TerminalEditorCloseConfirmModal.svelte";

  interface TerminalEmbeddedEditorSurfaceLabels {
    title: string;
    emptyTitle: string;
    emptyDescription: string;
    saveLabel: string;
    openFileLabel: string;
    switchToTerminalLabel: string;
    quickOpenTitle: string;
    quickOpenDescription: string;
    quickOpenPlaceholder: string;
    quickOpenIdleLabel: string;
    quickOpenEmptyLabel: string;
    quickOpenLoadingLabel: string;
    refreshLabel: string;
    closeLabel: string;
    keyboardHintLabel: string;
  }

  interface Props {
    viewMode: "terminal" | "editor";
    runtimeState: EditorRuntimeState;
    quickOpenState: EditorQuickOpenState;
    rootDir: string;
    busy: boolean;
    closeConfirmTitle: string;
    labels: TerminalEmbeddedEditorSurfaceLabels;
    onActivePathChange: (wslPath: string) => void;
    onCloseTab: (wslPath: string) => void;
    onContentChange: (detail: { wslPath: string; content: string }) => void;
    onSaveRequest: (wslPath: string) => void;
    onOpenFile: () => void;
    onSwitchToTerminal: () => void;
    onListWorkspaceFiles: (rootDir: string) => Promise<EditorSearchResult[]>;
    onReadWorkspaceFile: (
      wslPath: string,
    ) => Promise<Pick<ReadSessionFileResult, "wslPath" | "content" | "languageId">>;
    onOpenLocation: (detail: {
      wslPath: string;
      line?: number | null;
      column?: number | null;
      rootDir?: string;
      snapshot?: NavigationFileSnapshot;
    }) => void | Promise<void>;
    onRefreshQuickOpen: (forceRefresh?: boolean) => void | Promise<void>;
    onSelectQuickOpenResult: (result: EditorSearchResult) => void | Promise<void>;
    onCloseQuickOpen: () => void;
    onCancelCloseConfirm: () => void;
    onConfirmCloseConfirm: () => void;
  }

  let {
    viewMode,
    runtimeState,
    quickOpenState,
    rootDir,
    busy,
    closeConfirmTitle,
    labels,
    onActivePathChange,
    onCloseTab,
    onContentChange,
    onSaveRequest,
    onOpenFile,
    onSwitchToTerminal,
    onListWorkspaceFiles,
    onReadWorkspaceFile,
    onOpenLocation,
    onRefreshQuickOpen,
    onSelectQuickOpenResult,
    onCloseQuickOpen,
    onCancelCloseConfirm,
    onConfirmCloseConfirm,
  }: Props = $props();
</script>

{#if viewMode === "editor"}
  <InternalEditor
    tabs={runtimeState.tabs}
    activePath={runtimeState.activePath}
    {rootDir}
    {busy}
    statusText={runtimeState.statusText}
    title={labels.title}
    emptyTitle={labels.emptyTitle}
    emptyDescription={labels.emptyDescription}
    saveLabel={labels.saveLabel}
    openFileLabel={labels.openFileLabel}
    switchToTerminalLabel={labels.switchToTerminalLabel}
    onActivePathChange={onActivePathChange}
    onCloseTab={onCloseTab}
    onContentChange={onContentChange}
    onSaveRequest={(wslPath) => void onSaveRequest(wslPath)}
    onOpenFile={() => void onOpenFile()}
    onSwitchToTerminal={onSwitchToTerminal}
    onListWorkspaceFiles={onListWorkspaceFiles}
    onReadWorkspaceFile={onReadWorkspaceFile}
    onOpenLocation={onOpenLocation}
  />
{/if}

<EditorQuickOpenModal
  visible={quickOpenState.visible}
  openKey={quickOpenState.openKey}
  initialQuery={quickOpenState.query}
  rootDir={quickOpenState.rootDir || rootDir}
  entries={quickOpenState.entries}
  title={labels.quickOpenTitle}
  description={labels.quickOpenDescription}
  placeholder={labels.quickOpenPlaceholder}
  idleLabel={labels.quickOpenIdleLabel}
  emptyLabel={labels.quickOpenEmptyLabel}
  loadingLabel={labels.quickOpenLoadingLabel}
  refreshLabel={labels.refreshLabel}
  closeLabel={labels.closeLabel}
  keyboardHintLabel={labels.keyboardHintLabel}
  busy={quickOpenState.busy}
  onRefresh={() => void onRefreshQuickOpen(true)}
  onSelect={onSelectQuickOpenResult}
  onClose={onCloseQuickOpen}
/>

<TerminalEditorCloseConfirmModal
  open={runtimeState.closeConfirmVisible}
  title={closeConfirmTitle}
  onClose={onCancelCloseConfirm}
  onConfirm={onConfirmCloseConfirm}
/>
