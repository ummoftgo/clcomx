<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import { Badge, Button, ModalShell } from "../ui";
  import type { DetectedEditor } from "../editors";
  import { TEST_IDS, editorPickerItemTestId } from "../testids";

  interface Props {
    visible: boolean;
    title: string;
    description: string;
    emptyLabel: string;
    defaultEditorId?: string;
    editors: DetectedEditor[];
    onSelect: (editor: DetectedEditor) => void;
    onClose: () => void;
  }

  let {
    visible,
    title,
    description,
    emptyLabel,
    defaultEditorId = "",
    editors,
    onSelect,
    onClose,
  }: Props = $props();

  function getAbbreviation(label: string) {
    const words = label.split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return `${words[0][0] ?? ""}${words[1][0] ?? ""}`.toUpperCase();
  }
</script>

<ModalShell open={visible} size="sm" onClose={onClose}>
  <div class="editor-picker" data-testid={TEST_IDS.editorPickerModal}>
    <div class="editor-picker__header">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>

    {#if editors.length === 0}
      <div class="editor-picker__empty">{emptyLabel}</div>
    {:else}
      <div class="editor-picker__list" data-testid={TEST_IDS.editorPickerList}>
        {#each editors as editor (editor.id)}
          <button
            type="button"
            data-testid={editorPickerItemTestId(editor.id)}
            class="editor-picker__item"
            onclick={() => onSelect(editor)}
          >
            <span class="editor-picker__icon">{getAbbreviation(editor.label)}</span>
            <span class="editor-picker__copy">
              <span class="editor-picker__label">{editor.label}</span>
              <span class="editor-picker__id">{editor.id}</span>
            </span>
            {#if editor.id === defaultEditorId}
              <Badge tone="accent">{$t("common.labels.default")}</Badge>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    <div class="editor-picker__actions">
      <Button onclick={onClose}>{$t("common.actions.close")}</Button>
    </div>
  </div>
</ModalShell>

<style>
  .editor-picker {
    padding: 22px;
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-4);
  }

  .editor-picker__header h2 {
    margin: 0 0 8px;
    font-size: var(--ui-font-size-lg);
  }

  .editor-picker__header p {
    margin: 0;
    color: var(--ui-text-secondary);
    line-height: 1.5;
  }

  .editor-picker__list {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-2);
  }

  .editor-picker__item {
    display: flex;
    align-items: center;
    gap: var(--ui-space-3);
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--ui-border-subtle);
    border-radius: var(--ui-radius-lg);
    background: color-mix(in srgb, var(--ui-bg-elevated) 88%, transparent);
    color: var(--ui-text-primary);
    text-align: left;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
  }

  .editor-picker__item:hover {
    background: color-mix(in srgb, var(--ui-bg-elevated) 96%, transparent);
    border-color: color-mix(in srgb, var(--ui-accent) 52%, var(--ui-border-subtle));
    transform: translateY(-1px);
  }

  .editor-picker__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-accent) 18%, transparent);
    color: var(--ui-text-primary);
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
    letter-spacing: 0.04em;
    flex: 0 0 auto;
  }

  .editor-picker__copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .editor-picker__label {
    font-weight: 600;
  }

  .editor-picker__id {
    color: var(--ui-text-muted);
    font-size: var(--ui-font-size-xs);
  }

  .editor-picker__empty {
    padding: 16px;
    border: 1px dashed color-mix(in srgb, var(--ui-border-subtle) 80%, transparent);
    border-radius: var(--ui-radius-lg);
    color: var(--ui-text-secondary);
    text-align: center;
  }

  .editor-picker__actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
