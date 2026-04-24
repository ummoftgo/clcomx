<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import { TEST_IDS } from "../../../testids";
  import TerminalAssistStack from "./TerminalAssistStack.svelte";
  import TerminalLoadingOverlay from "./TerminalLoadingOverlay.svelte";

  interface Props {
    viewMode: "terminal" | "editor";
    linkHovering: boolean;
    outputElement?: HTMLDivElement;
    spawnError?: string | null;
    clipboardNotice?: string | null;
    terminalLoadingState?: string | null;
    terminalLoadingLabel: string;
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
    viewMode,
    linkHovering,
    outputElement = $bindable<HTMLDivElement>(),
    spawnError = null,
    clipboardNotice = null,
    terminalLoadingState = null,
    terminalLoadingLabel,
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

<div
  class="terminal-runtime"
  class:terminal-runtime--hidden={viewMode !== "terminal"}
  aria-hidden={viewMode === "terminal" ? undefined : "true"}
>
  <div
    class="terminal-output"
    class:terminal-output--link-hover={linkHovering}
    data-testid={TEST_IDS.terminalOutput}
    bind:this={outputElement}
  >
    {#if spawnError}
      <div class="terminal-error">
        {$t("terminal.assist.startFailed", { values: { message: spawnError } })}
      </div>
    {/if}

    {#if clipboardNotice}
      <div class="terminal-notice">
        {clipboardNotice}
      </div>
    {/if}

    {#if terminalLoadingState !== null && !spawnError}
      <TerminalLoadingOverlay
        label={terminalLoadingLabel}
        hint={$t("terminal.loading.hint")}
      />
    {/if}
  </div>

  <TerminalAssistStack
    {draftOpen}
    {draftTitle}
    {draftValue}
    {draftHeightPx}
    bind:draftElement={draftElement}
    bind:draftPanelElement={draftPanelElement}
    {auxInitialized}
    {auxVisible}
    {auxBusy}
    {auxHeightPercent}
    {auxCurrentPath}
    {auxSpawnError}
    {auxLoadingState}
    {auxLoadingLabel}
    {auxTitle}
    {auxPathLabel}
    bind:auxOutputElement={auxOutputElement}
    bind:assistPanelElement={assistPanelElement}
    {onDraftResizeStart}
    {onCloseDraft}
    {onDraftInput}
    {onDraftKeydown}
    {onDraftPaste}
    {onInsertDraft}
    {onSendDraft}
    {onAuxResizeStart}
    {onCloseAux}
    {onPasteImage}
    {onOpenFile}
    {onOpenEditor}
    {onToggleAux}
    {onToggleDraft}
  />
</div>

<style>
  .terminal-runtime {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  }

  .terminal-runtime.terminal-runtime--hidden {
    display: none;
  }

  .terminal-output {
    flex: 1;
    min-height: 0;
    padding: var(--ui-space-1);
    position: relative;
  }

  .terminal-output.terminal-output--link-hover {
    cursor: pointer;
  }

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

  .terminal-notice {
    position: absolute;
    right: var(--ui-space-4);
    bottom: var(--ui-space-4);
    max-width: min(calc(420px * var(--ui-scale)), calc(100vw - 32px));
    padding: calc(10px * var(--ui-scale)) var(--ui-space-3);
    border-radius: var(--ui-radius-md);
    color: var(--ui-text-primary, #f8fafc);
    background: color-mix(in srgb, var(--ui-bg-elevated, var(--tab-bg)) 92%, black 8%);
    border: 1px solid var(--ui-border-subtle, rgba(148, 163, 184, 0.24));
    box-shadow: 0 10px 26px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.26);
    font-size: var(--ui-font-size-sm);
    z-index: 30;
  }
</style>
