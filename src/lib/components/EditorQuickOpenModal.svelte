<script lang="ts">
  import { tick } from "svelte";
  import { filterEditorQuickOpenResults } from "../editor/quick-open";
  import { Button, ModalShell } from "../ui";
  import type { EditorSearchResult } from "../editors";
  import { TEST_IDS } from "../testids";

  type QuickOpenSegment = { text: string; match: boolean };
  type QuickOpenRow = {
    id: string;
    result: EditorSearchResult;
    directory: string;
    basenameSegments: QuickOpenSegment[];
  };

  interface Props {
    visible: boolean;
    openKey: number;
    initialQuery?: string;
    rootDir: string;
    entries: EditorSearchResult[];
    title: string;
    description: string;
    placeholder: string;
    idleLabel: string;
    emptyLabel: string;
    loadingLabel: string;
    refreshLabel: string;
    closeLabel?: string;
    keyboardHintLabel?: string;
    onSelect: (result: EditorSearchResult) => void;
    onClose: () => void;
    onRefresh: () => void;
    busy?: boolean;
  }

  let {
    visible,
    openKey,
    initialQuery = "",
    rootDir,
    entries,
    title,
    description,
    placeholder,
    idleLabel,
    emptyLabel,
    loadingLabel,
    refreshLabel,
    closeLabel = "Close",
    keyboardHintLabel = "Enter to open, Arrow keys to navigate",
    onSelect,
    onClose,
    onRefresh,
    busy = false,
  }: Props = $props();

  let inputElement: HTMLInputElement | undefined;
  let localQuery = $state("");
  let selectedIndex = $state(0);
  let lastOpenKey = $state("");

  const normalizedQuery = $derived(localQuery.trim().toLowerCase());
  const isIdle = $derived(normalizedQuery.length === 0);
  const rows = $derived.by(() =>
    filterEditorQuickOpenResults(entries, localQuery, 80).map((result) =>
      createQuickOpenRow(result, normalizedQuery),
    ),
  );
  const activeRow = $derived(rows[selectedIndex] ?? null);
  const activeDescendantId = $derived(activeRow ? activeRow.id : undefined);
  const hasRows = $derived(rows.length > 0);

  $effect(() => {
    if (!visible) {
      lastOpenKey = "";
      selectedIndex = 0;
      return;
    }

    void tick().then(() => inputElement?.focus());
  });

  $effect(() => {
    if (!visible) {
      return;
    }

    const nextOpenKey = String(openKey);
    if (lastOpenKey === nextOpenKey) {
      return;
    }

    lastOpenKey = nextOpenKey;
    localQuery = initialQuery;
    selectedIndex = 0;
  });

  $effect(() => {
    rows;
    if (rows.length === 0) {
      selectedIndex = 0;
      return;
    }

    selectedIndex = clampIndex(selectedIndex, rows.length);
  });

  function clampIndex(index: number, length: number) {
    if (length <= 0) return 0;
    return Math.min(Math.max(index, 0), length - 1);
  }

  function quickOpenOptionId(wslPath: string) {
    return `internal-editor-quick-open-option-${encodeURIComponent(wslPath).replace(/%/g, "_")}`;
  }

  function createQuickOpenRow(result: EditorSearchResult, search: string): QuickOpenRow {
    return {
      id: quickOpenOptionId(result.wslPath),
      result,
      directory: splitDirectory(result.relativePath, result.basename),
      basenameSegments: buildHighlightSegments(result.basename, search),
    };
  }

  function splitDirectory(relativePath: string, basename: string) {
    if (relativePath === basename) return "";
    return relativePath.slice(0, Math.max(0, relativePath.length - basename.length - 1));
  }

  function buildHighlightSegments(value: string, search: string) {
    if (!search) {
      return [{ text: value, match: false }];
    }

    const normalizedValue = value.toLowerCase();
    const normalizedSearch = search.toLowerCase();
    const segments: Array<{ text: string; match: boolean }> = [];
    let cursor = 0;

    while (cursor < value.length) {
      const nextIndex = normalizedValue.indexOf(normalizedSearch, cursor);
      if (nextIndex === -1) {
        segments.push({ text: value.slice(cursor), match: false });
        break;
      }

      if (nextIndex > cursor) {
        segments.push({ text: value.slice(cursor, nextIndex), match: false });
      }

      segments.push({
        text: value.slice(nextIndex, nextIndex + normalizedSearch.length),
        match: true,
      });
      cursor = nextIndex + normalizedSearch.length;
    }

    return segments;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!visible) return;

    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (rows.length === 0) {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        selectedIndex = (selectedIndex + 1) % rows.length;
        break;
      case "ArrowUp":
        event.preventDefault();
        selectedIndex = (selectedIndex - 1 + rows.length) % rows.length;
        break;
      case "Enter":
        if (!activeRow) return;
        event.preventDefault();
        onSelect(activeRow.result);
        break;
      default:
        break;
    }
  }
</script>

<ModalShell open={visible} size="lg" onClose={onClose}>
  <div
    class="quick-open"
    data-testid={TEST_IDS.internalEditorQuickOpenModal}
    role="document"
  >
    <div class="quick-open__header">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <span class="quick-open__root">{rootDir}</span>
    </div>

    <label class="quick-open__search">
      <span class="quick-open__search-label">{title}</span>
      <input
        bind:this={inputElement}
        data-testid={TEST_IDS.internalEditorQuickOpenInput}
        type="text"
        value={localQuery}
        placeholder={placeholder}
        autocomplete="off"
        spellcheck="false"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={TEST_IDS.internalEditorQuickOpenList}
        aria-activedescendant={activeDescendantId}
        aria-expanded={visible}
        oninput={(event) => {
          localQuery = event.currentTarget.value;
        }}
        onkeydown={handleKeydown}
      />
    </label>

    <div
      class="quick-open__list"
      data-testid={TEST_IDS.internalEditorQuickOpenList}
      id={TEST_IDS.internalEditorQuickOpenList}
      role="listbox"
      aria-label={title}
      aria-busy={busy}
    >
      {#if busy && hasRows}
        <div class="quick-open__busy-banner" role="status" aria-live="polite">
          <span>{loadingLabel}</span>
          <Button variant="ghost" size="sm" disabled={busy} onclick={onRefresh}>
            {refreshLabel}
          </Button>
        </div>
      {/if}

      {#if hasRows}
        <div class="quick-open__rows">
          {#each rows as row, index (row.id)}
          <button
            id={row.id}
            type="button"
            role="option"
            tabindex="-1"
            class:selected={index === selectedIndex}
            aria-selected={index === selectedIndex}
            class="quick-open__item"
            onclick={() => onSelect(row.result)}
            onmouseenter={() => {
              if (selectedIndex !== index) {
                selectedIndex = index;
              }
            }}
          >
            <span class="quick-open__basename">
              {#each row.basenameSegments as segment}
                {#if segment.match}
                  <mark>{segment.text}</mark>
                {:else}
                  <span>{segment.text}</span>
                {/if}
              {/each}
            </span>
            <span class="quick-open__meta">
              {#if row.directory}
                <span class="quick-open__directory">{row.directory}</span>
              {/if}
              {#if row.result.line}
                <span class="quick-open__position"
                  >:{row.result.line}{row.result.column ? `:${row.result.column}` : ""}</span
                >
              {/if}
            </span>
          </button>
          {/each}
        </div>
      {:else if busy}
        <div class="quick-open__status" role="status" aria-live="polite">{loadingLabel}</div>
      {:else if isIdle}
        <div class="quick-open__status" role="status" aria-live="polite">{idleLabel}</div>
      {:else}
        <div class="quick-open__status" role="status" aria-live="polite">{emptyLabel}</div>
      {/if}
    </div>

    <div class="quick-open__footer">
      <p>{keyboardHintLabel}</p>
      <div class="quick-open__footer-actions">
        <Button variant="ghost" disabled={busy} onclick={onRefresh}>{refreshLabel}</Button>
        <Button onclick={onClose}>{closeLabel}</Button>
      </div>
    </div>
  </div>
</ModalShell>

<style>
  .quick-open {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-4);
    padding: 22px;
  }

  .quick-open__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--ui-space-3);
  }

  .quick-open__header h2 {
    margin: 0 0 8px;
    font-size: var(--ui-font-size-lg);
  }

  .quick-open__header p {
    margin: 0;
    color: var(--ui-text-secondary);
    line-height: 1.5;
  }

  .quick-open__root {
    max-width: min(50%, 340px);
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle) 84%, transparent);
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--ui-bg-elevated) 92%, transparent);
    color: var(--ui-text-muted);
    font-size: var(--ui-font-size-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-open__search {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .quick-open__search-label {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .quick-open__search input {
    width: 100%;
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle) 84%, transparent);
    border-radius: var(--ui-radius-lg);
    background: color-mix(in srgb, var(--ui-bg-elevated) 88%, transparent);
    color: var(--ui-text-primary);
    padding: 14px 16px;
    font-size: var(--ui-font-size-md);
    outline: none;
  }

  .quick-open__search input:focus {
    border-color: color-mix(in srgb, var(--ui-accent) 54%, var(--ui-border-subtle));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent) 18%, transparent);
  }

  .quick-open__list {
    min-height: 260px;
    max-height: min(52vh, 460px);
    overflow: auto;
    position: relative;
    padding-right: 4px;
  }

  .quick-open__rows {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-2);
  }

  .quick-open__busy-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
    position: sticky;
    top: 0;
    z-index: 1;
    margin-bottom: var(--ui-space-2);
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle) 84%, transparent);
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--ui-bg-elevated) 96%, transparent);
    color: var(--ui-text-secondary);
    font-size: var(--ui-font-size-xs);
    box-shadow: 0 10px 24px color-mix(in srgb, var(--ui-shadow) 14%, transparent);
  }

  .quick-open__status {
    display: grid;
    place-items: center;
    min-height: 220px;
    border: 1px dashed color-mix(in srgb, var(--ui-border-subtle) 84%, transparent);
    border-radius: var(--ui-radius-lg);
    color: var(--ui-text-secondary);
  }

  .quick-open__item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    width: 100%;
    padding: 14px 16px;
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle) 84%, transparent);
    border-radius: var(--ui-radius-lg);
    background: color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent);
    color: var(--ui-text-primary);
    text-align: left;
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
  }

  .quick-open__item:hover,
  .quick-open__item.selected {
    border-color: color-mix(in srgb, var(--ui-accent) 56%, var(--ui-border-subtle));
    background: color-mix(in srgb, var(--ui-accent) 10%, var(--ui-bg-elevated));
    transform: translateY(-1px);
  }

  .quick-open__basename {
    font-weight: 700;
    word-break: break-word;
  }

  .quick-open__basename mark {
    background: color-mix(in srgb, var(--ui-accent) 26%, transparent);
    color: inherit;
    border-radius: 4px;
    padding: 0 2px;
  }

  .quick-open__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--ui-text-muted);
    font-size: var(--ui-font-size-xs);
    min-width: 0;
  }

  .quick-open__directory {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-open__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
  }

  .quick-open__footer p {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--ui-font-size-xs);
  }

  .quick-open__footer-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--ui-space-2);
  }

  @media (max-width: 720px) {
    .quick-open__header {
      flex-direction: column;
    }

    .quick-open__root {
      max-width: 100%;
    }

    .quick-open__footer {
      flex-direction: column;
      align-items: stretch;
    }

    .quick-open__footer-actions {
      justify-content: stretch;
    }
  }
</style>
