<!--
  EmbeddedEditorSurfaceProbe — direct SessionShell editor wiring 테스트용 최소 surface.

  실제 Monaco/editor UI 대신 editor runtime state가 열린 파일과 위치를 받았는지만 노출한다.
-->
<script lang="ts">
  import type { EditorRuntimeState } from "../../../editor/state/editor-runtime-state.svelte";

  let {
    viewMode,
    runtimeState,
    onOpenFile,
  }: {
    viewMode: "terminal" | "editor";
    runtimeState: EditorRuntimeState;
    onOpenFile?: () => void;
  } = $props();

  const activeTab = $derived(
    runtimeState.tabs.find((tab) => tab.wslPath === runtimeState.activePath) ?? null,
  );
</script>

<div
  data-testid="embedded-editor-probe"
  data-view-mode={viewMode}
  data-active-path={runtimeState.activePath ?? ""}
  data-active-line={String(activeTab?.line ?? "")}
  data-active-column={String(activeTab?.column ?? "")}
>
  {activeTab?.content ?? ""}
  {#if onOpenFile}
    <button type="button" data-testid="embedded-editor-open-file" onclick={onOpenFile}>
      open
    </button>
  {/if}
</div>
