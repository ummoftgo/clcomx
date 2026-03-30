<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import Button from "../ui/components/Button.svelte";
  import { TEST_IDS } from "../testids";

  interface Props {
    auxVisible: boolean;
    auxBusy?: boolean;
    draftOpen: boolean;
    draftValue: string;
    showPasteImageButton?: boolean;
    onPasteImage?: () => void;
    onToggleAux: () => void;
    onToggleDraft: () => void;
    onDraftInput: (event: Event) => void;
    onDraftKeydown?: (event: KeyboardEvent) => void;
    onDraftPaste?: (event: ClipboardEvent) => void;
    onInsertDraft: () => void;
    onSendDraft: () => void;
    onDraftElementChange?: (element: HTMLTextAreaElement | null) => void;
  }

  let {
    auxVisible,
    auxBusy = false,
    draftOpen,
    draftValue,
    showPasteImageButton = true,
    onPasteImage = () => {},
    onToggleAux,
    onToggleDraft,
    onDraftInput,
    onDraftKeydown,
    onDraftPaste,
    onInsertDraft,
    onSendDraft,
    onDraftElementChange,
  }: Props = $props();

  let draftEl = $state<HTMLTextAreaElement | null>(null);

  $effect(() => {
    onDraftElementChange?.(draftEl);
  });
</script>

<div class="assist-panel" class:assist-panel--draft-open={draftOpen}>
  <div class="assist-header">
    <div class="assist-copy">
      <span class="assist-label">{$t("terminal.assist.label")}</span>
      <span class="assist-hint">{$t("terminal.assist.hint")}</span>
    </div>

    <div class="assist-actions">
      {#if showPasteImageButton}
        <Button size="sm" onclick={onPasteImage}>
          {$t("terminal.assist.pasteImage")}
        </Button>
      {/if}
      <Button
        size="sm"
        data-testid={TEST_IDS.auxTerminalToggle}
        variant={auxVisible ? "primary" : "secondary"}
        onclick={onToggleAux}
        disabled={auxBusy}
      >
        {#if auxVisible}
          {$t("terminal.assist.hideTerminal")}
        {:else}
          {$t("terminal.assist.openTerminal")}
        {/if}
      </Button>
      <Button
        size="sm"
        data-testid={TEST_IDS.draftToggle}
        variant={draftOpen ? "primary" : "secondary"}
        onclick={onToggleDraft}
      >
        {#if draftOpen}
          {$t("terminal.assist.hideDraft")}
        {:else if draftValue}
          {$t("terminal.assist.draftWithCount", { values: { count: draftValue.length } })}
        {:else}
          {$t("terminal.assist.openDraft")}
        {/if}
      </Button>
    </div>
  </div>

  {#if draftOpen}
    <div class="draft-panel">
      <textarea
        bind:this={draftEl}
        value={draftValue}
        data-testid={TEST_IDS.draftTextarea}
        class="draft-textarea"
        rows="1"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        placeholder={$t("terminal.assist.draftPlaceholder")}
        oninput={onDraftInput}
        onkeydown={onDraftKeydown}
        onpaste={onDraftPaste}
      ></textarea>

      <div class="draft-footer">
        <span class="draft-hint">{$t("terminal.assist.draftHint")}</span>

        <div class="draft-actions">
          <Button
            size="sm"
            data-testid={TEST_IDS.draftInsertButton}
            onclick={onInsertDraft}
            disabled={draftValue.length === 0}
          >
            {$t("common.actions.insert")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid={TEST_IDS.draftSendButton}
            onclick={onSendDraft}
            disabled={draftValue.length === 0}
          >
            {$t("common.actions.send")}
          </Button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .assist-panel {
    flex-shrink: 0;
    padding: var(--ui-space-3) var(--ui-space-4) var(--ui-space-4);
    border-top: 1px solid var(--ui-border-subtle, var(--tab-border));
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 72%, transparent), transparent),
      var(--ui-bg-app, var(--app-bg));
    transition: box-shadow 160ms ease, border-color 160ms ease;
  }

  .assist-panel.assist-panel--draft-open {
    border-top-color: color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 82%, transparent);
    box-shadow: 0 -16px 26px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.18);
  }

  .assist-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
  }

  .assist-copy {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
    min-width: 0;
  }

  .assist-label {
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-secondary, var(--tab-text));
  }

  .assist-hint {
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .assist-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--ui-space-2);
    align-items: center;
    justify-content: flex-end;
  }

  .draft-panel {
    margin-top: var(--ui-space-3);
    padding: var(--ui-space-4);
    border-radius: var(--ui-radius-lg);
    border: 1px solid var(--ui-border-subtle, rgba(148, 163, 184, 0.18));
    background: color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 88%, transparent);
    box-shadow: 0 14px 28px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.16);
  }

  .draft-textarea {
    width: 100%;
    min-height: calc(42px * var(--ui-scale));
    max-height: 50vh;
    resize: none;
    padding: calc(10px * var(--ui-scale)) var(--ui-space-3);
    border: 1px solid var(--ui-border-subtle, rgba(148, 163, 184, 0.24));
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--ui-bg-elevated, var(--tab-bg)) 92%, transparent);
    color: var(--ui-text-primary, #e2e8f0);
    font: inherit;
    line-height: 1.5;
    outline: none;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
  }

  .draft-textarea:focus {
    border-color: var(--ui-accent, rgba(96, 165, 250, 0.65));
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.03),
      0 0 0 1px var(--ui-focus-ring, rgba(96, 165, 250, 0.12));
  }

  .draft-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
    margin-top: var(--ui-space-3);
  }

  .draft-hint {
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .draft-actions {
    display: flex;
    gap: var(--ui-space-2);
    align-items: center;
  }

  @media (max-width: 900px) {
    .assist-header,
    .draft-footer {
      flex-direction: column;
      align-items: stretch;
    }

    .assist-actions,
    .draft-actions {
      justify-content: stretch;
    }

    :global(.assist-actions .ui-button),
    :global(.draft-actions .ui-button) {
      flex: 1;
    }
  }
</style>
