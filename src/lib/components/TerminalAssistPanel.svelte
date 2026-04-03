<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import Button from "../ui/components/Button.svelte";
  import { TEST_IDS } from "../testids";

  interface Props {
    auxVisible: boolean;
    auxBusy?: boolean;
    draftOpen: boolean;
    draftValue: string;
    showEditorActions?: boolean;
    showPasteImageButton?: boolean;
    onPasteImage?: () => void;
    onOpenFile?: () => void;
    onOpenEditor?: () => void;
    onToggleAux: () => void;
    onToggleDraft: () => void;
  }

  let {
    auxVisible,
    auxBusy = false,
    draftOpen,
    draftValue,
    showEditorActions = false,
    showPasteImageButton = true,
    onPasteImage = () => {},
    onOpenFile = () => {},
    onOpenEditor = () => {},
    onToggleAux,
    onToggleDraft,
  }: Props = $props();
</script>

<div class="assist-panel" class:assist-panel--draft-open={draftOpen}>
  <div class="assist-header">
    <div class="assist-copy">
      <span class="assist-label">{$t("terminal.assist.label")}</span>
      <span class="assist-hint">{$t("terminal.assist.hint")}</span>
    </div>

    <div class="assist-actions">
      {#if showEditorActions}
        <Button size="sm" onclick={onOpenFile}>
          {$t("terminal.editor.openFile")}
        </Button>
        <Button size="sm" variant="secondary" onclick={onOpenEditor}>
          {$t("terminal.editor.openEditor")}
        </Button>
      {/if}
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

  @media (max-width: 900px) {
    .assist-header {
      flex-direction: column;
      align-items: stretch;
    }

    .assist-actions {
      justify-content: stretch;
    }

    :global(.assist-actions .ui-button) {
      flex: 1;
    }
  }
</style>
