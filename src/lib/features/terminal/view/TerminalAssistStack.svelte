<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import TerminalAssistPanel from "../../../components/TerminalAssistPanel.svelte";
  import TerminalAuxPanel from "../../../components/TerminalAuxPanel.svelte";
  import TerminalDraftPanel from "../../../components/TerminalDraftPanel.svelte";
  import { TEST_IDS } from "../../../testids";
  import TerminalLoadingOverlay from "./TerminalLoadingOverlay.svelte";

  interface Props {
    draftOpen: boolean;
    draftTitle: string;
    draftValue: string;
    draftHeightPx?: number | null;
    draftElement?: HTMLTextAreaElement | null;
    draftPanelElement?: HTMLDivElement | null;
    auxInitialized: boolean;
    auxVisible: boolean;
    auxBusy?: boolean;
    auxHeightPercent: number;
    auxCurrentPath: string;
    auxSpawnError?: string | null;
    auxLoadingState?: string | null;
    auxLoadingLabel: string;
    auxTitle: string;
    auxPathLabel: string;
    auxOutputElement?: HTMLDivElement | null;
    assistPanelElement?: HTMLDivElement | null;
    onDraftResizeStart?: (event: PointerEvent) => void;
    onCloseDraft: () => void;
    onDraftInput: (event: Event) => void;
    onDraftKeydown?: (event: KeyboardEvent) => void;
    onDraftPaste?: (event: ClipboardEvent) => void;
    onInsertDraft: () => void;
    onSendDraft: () => void;
    onAuxResizeStart?: (event: PointerEvent) => void;
    onCloseAux: () => void;
    onPasteImage?: () => void;
    onOpenFile?: () => void;
    onOpenEditor?: () => void;
    onToggleAux: () => void;
    onToggleDraft: () => void;
  }

  let {
    draftOpen,
    draftTitle,
    draftValue,
    draftHeightPx = null,
    draftElement = $bindable<HTMLTextAreaElement | null>(null),
    draftPanelElement = $bindable<HTMLDivElement | null>(null),
    auxInitialized,
    auxVisible,
    auxBusy = false,
    auxHeightPercent,
    auxCurrentPath,
    auxSpawnError = null,
    auxLoadingState = null,
    auxLoadingLabel,
    auxTitle,
    auxPathLabel,
    auxOutputElement = $bindable<HTMLDivElement | null>(null),
    assistPanelElement = $bindable<HTMLDivElement | null>(null),
    onDraftResizeStart,
    onCloseDraft,
    onDraftInput,
    onDraftKeydown,
    onDraftPaste,
    onInsertDraft,
    onSendDraft,
    onAuxResizeStart,
    onCloseAux,
    onPasteImage = () => {},
    onOpenFile = () => {},
    onOpenEditor = () => {},
    onToggleAux,
    onToggleDraft,
  }: Props = $props();
</script>

{#if draftOpen}
  <TerminalDraftPanel
    title={draftTitle}
    draftValue={draftValue}
    fixedHeightPx={draftHeightPx}
    bind:draftElement={draftElement}
    bind:panelElement={draftPanelElement}
    onResizeStart={onDraftResizeStart}
    onClose={onCloseDraft}
    onDraftInput={onDraftInput}
    onDraftKeydown={onDraftKeydown}
    onDraftPaste={onDraftPaste}
    onInsertDraft={onInsertDraft}
    onSendDraft={onSendDraft}
  />
{/if}

{#if auxInitialized}
  {#snippet liveAuxBody()}
    {#if auxSpawnError}
      <div class="terminal-error">
        {$t("terminal.aux.startFailed", { values: { message: auxSpawnError } })}
      </div>
    {/if}
  {/snippet}

  {#snippet liveAuxOverlay()}
    {#if auxLoadingState !== null && !auxSpawnError}
      <TerminalLoadingOverlay
        variant="aux"
        label={auxLoadingLabel}
        hint={$t("terminal.aux.loadingHint")}
      />
    {/if}
  {/snippet}

  <TerminalAuxPanel
    visible={auxVisible}
    heightPercent={auxHeightPercent}
    title={auxTitle}
    currentPath={auxCurrentPath}
    pathLabel={auxPathLabel}
    outputTestId={TEST_IDS.auxTerminalShell}
    resizable={true}
    onResizeStart={onAuxResizeStart}
    onClose={onCloseAux}
    body={liveAuxBody}
    overlay={liveAuxOverlay}
    onOutputElementChange={(element) => {
      auxOutputElement = element;
    }}
  />
{/if}

<div bind:this={assistPanelElement}>
  <TerminalAssistPanel
    auxVisible={auxVisible}
    auxBusy={auxBusy}
    draftOpen={draftOpen}
    draftValue={draftValue}
    showEditorActions={true}
    onPasteImage={onPasteImage}
    onOpenFile={onOpenFile}
    onOpenEditor={onOpenEditor}
    onToggleAux={onToggleAux}
    onToggleDraft={onToggleDraft}
  />
</div>

<style>
  .terminal-error {
    position: absolute;
    inset: var(--ui-space-4);
    padding: var(--ui-space-3) var(--ui-space-4);
    border: 1px solid color-mix(in srgb, var(--ui-danger, #ef4444) 70%, transparent);
    border-radius: var(--ui-radius-md);
    background: var(--ui-danger-soft, rgba(127, 29, 29, 0.18));
    color: color-mix(in srgb, var(--ui-danger, #ef4444) 28%, white);
    font-size: var(--ui-font-size-base);
    white-space: pre-wrap;
    z-index: 10;
  }

</style>
