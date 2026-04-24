<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import { TEST_IDS } from "../../../testids";
  import TerminalAssistStack from "./TerminalAssistStack.svelte";

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
      <div class="terminal-connect-overlay">
        <div class="terminal-connect-card">
          <div class="terminal-connect-eyebrow">CLCOMX</div>
          <div class="terminal-connect-title">{terminalLoadingLabel}</div>
          <div class="terminal-connect-hint">{$t("terminal.loading.hint")}</div>
          <div class="terminal-connect-dots" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div class="terminal-connect-bar" aria-hidden="true">
            <span></span>
          </div>
        </div>
      </div>
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

  .terminal-connect-bar {
    position: relative;
    overflow: hidden;
    width: 100%;
    height: 4px;
    margin-top: var(--ui-space-1);
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-border-subtle, var(--tab-border)) 72%, transparent);
  }

  .terminal-connect-bar span {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -24%;
    width: 24%;
    border-radius: inherit;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ui-accent, var(--tab-accent, #6ea8ff)) 92%, white 8%), transparent);
    animation: terminal-loading-sweep 1.5s ease-in-out infinite;
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

  @keyframes terminal-loading-sweep {
    0% {
      transform: translateX(0);
    }
    100% {
      transform: translateX(520%);
    }
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
