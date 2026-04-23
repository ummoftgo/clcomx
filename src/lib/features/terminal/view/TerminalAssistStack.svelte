<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import TerminalAssistPanel from "../../../components/TerminalAssistPanel.svelte";
  import TerminalAuxPanel from "../../../components/TerminalAuxPanel.svelte";
  import TerminalDraftPanel from "../../../components/TerminalDraftPanel.svelte";
  import { TEST_IDS } from "../../../testids";

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
      <div class="terminal-connect-overlay terminal-connect-overlay--subpanel terminal-connect-overlay--aux-panel">
        <div class="terminal-connect-card terminal-connect-card--compact">
          <div class="terminal-connect-eyebrow">CLCOMX</div>
          <div class="terminal-connect-title">{auxLoadingLabel}</div>
          <div class="terminal-connect-hint">{$t("terminal.aux.loadingHint")}</div>
          <div class="terminal-connect-dots" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      </div>
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
  .terminal-connect-overlay {
    position: absolute;
    inset: var(--ui-space-1);
    display: grid;
    place-items: center;
    padding: clamp(20px, 3vw, 28px);
    border-radius: calc(var(--ui-radius-lg) + 2px);
    background:
      linear-gradient(180deg, rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.16), rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.3)),
      color-mix(in srgb, var(--ui-bg-app, var(--app-bg)) 72%, transparent);
    backdrop-filter: blur(6px);
    z-index: 8;
  }

  .terminal-connect-overlay--subpanel {
    inset: 0;
    padding: var(--ui-space-3);
    border-radius: var(--ui-radius-md);
  }

  .terminal-connect-overlay--aux-panel {
    z-index: 24;
    border-radius: inherit;
  }

  .terminal-connect-card {
    min-width: min(320px, 100%);
    max-width: min(420px, 100%);
    display: grid;
    gap: var(--ui-space-2);
    padding: clamp(18px, 2.2vw, 24px);
    border: 1px solid color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 78%, transparent);
    border-radius: calc(var(--ui-radius-xl) + 2px);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 94%, transparent), transparent),
      color-mix(in srgb, var(--ui-bg-app, var(--app-bg)) 90%, transparent);
    box-shadow: 0 18px 40px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.24);
  }

  .terminal-connect-card--compact {
    min-width: min(280px, 100%);
    gap: var(--ui-space-2);
    padding: clamp(16px, 2vw, 20px);
  }

  .terminal-connect-eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .terminal-connect-title {
    font-size: clamp(18px, 2vw, 22px);
    font-weight: 700;
    line-height: 1.2;
    color: var(--ui-text-primary, var(--tab-text));
  }

  .terminal-connect-hint {
    font-size: var(--ui-font-size-sm);
    line-height: 1.55;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .terminal-connect-dots {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: var(--ui-space-1);
  }

  .terminal-connect-dots span {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-accent, var(--tab-accent, #6ea8ff)) 82%, white 18%);
    animation: terminal-loading-bounce 1.1s ease-in-out infinite;
  }

  .terminal-connect-dots span:nth-child(2) {
    animation-delay: 0.12s;
  }

  .terminal-connect-dots span:nth-child(3) {
    animation-delay: 0.24s;
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

  @keyframes terminal-loading-bounce {
    0%, 80%, 100% {
      transform: translateY(0);
      opacity: 0.42;
    }
    40% {
      transform: translateY(-4px);
      opacity: 1;
    }
  }
</style>
