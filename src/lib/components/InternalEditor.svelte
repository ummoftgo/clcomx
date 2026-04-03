<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { Button } from "../ui";
  import { TEST_IDS } from "../testids";
  import {
    createMonacoEditorHost,
    type MonacoEditorHost,
  } from "../editor/monaco-host";
  import type { InternalEditorTab } from "../editor/contracts";
  import { basenameFromPath, directoryFromPath } from "../editor/path";
  import { buildFontStack, serializeFontFamilyList } from "../font-family";
  import { getThemeById } from "../themes";
  import { getSettings } from "../stores/settings.svelte";
  import { DEFAULT_SETTINGS } from "../types";

  interface Props {
    tabs: InternalEditorTab[];
    activePath: string | null;
    busy?: boolean;
    statusText?: string | null;
    title?: string;
    emptyTitle: string;
    emptyDescription: string;
    saveLabel: string;
    openFileLabel: string;
    switchToTerminalLabel: string;
    onActivePathChange: (wslPath: string) => void;
    onCloseTab: (wslPath: string) => void;
    onContentChange: (detail: { wslPath: string; content: string }) => void;
    onSaveRequest: (wslPath: string) => void;
    onOpenFile: () => void;
    onSwitchToTerminal: () => void;
  }

  let {
    tabs,
    activePath,
    busy = false,
    statusText = null,
    title = "Internal Editor",
    emptyTitle,
    emptyDescription,
    saveLabel,
    openFileLabel,
    switchToTerminalLabel,
    onActivePathChange,
    onCloseTab,
    onContentChange,
    onSaveRequest,
    onOpenFile,
    onSwitchToTerminal,
  }: Props = $props();

  let editorSurfaceEl = $state<HTMLDivElement | undefined>(undefined);
  let host: MonacoEditorHost | null = null;
  const settings = getSettings();

  const activeTab = $derived(tabs.find((tab) => tab.wslPath === activePath) ?? null);
  const activeTheme = $derived(getThemeById(settings.interface.theme) ?? null);
  const editorPresentation = $derived({
    fontFamily: buildFontStack(
      serializeFontFamilyList(settings.editor.fontFamily, DEFAULT_SETTINGS.editor.fontFamily),
      serializeFontFamilyList(
        settings.editor.fontFamilyFallback,
        DEFAULT_SETTINGS.editor.fontFamilyFallback,
      ),
    ),
    fontSize: settings.editor.fontSize,
  });

  $effect(() => {
    if (!editorSurfaceEl || host || tabs.length === 0) {
      return;
    }

    host = createMonacoEditorHost({
      target: editorSurfaceEl,
      tabs,
      activePath,
      theme: activeTheme,
      presentation: editorPresentation,
      onChange: onContentChange,
      onSaveRequest,
    });
  });

  $effect(() => {
    tabs;
    activePath;
    if (!host) return;
    host.syncTabs(tabs);
    host.setActivePath(activePath);
  });

  $effect(() => {
    activeTheme;
    if (!host) return;
    host.setTheme(activeTheme);
  });

  $effect(() => {
    editorPresentation;
    if (!host) return;
    host.setPresentation(editorPresentation);
  });

  $effect(() => {
    if (!host || tabs.length > 0) {
      return;
    }

    host.dispose();
    host = null;
  });

  $effect(() => {
    if (!host || !activePath) return;
    tick().then(() => host?.focus());
  });

  onDestroy(() => {
    host?.dispose();
    host = null;
  });

  function selectTab(wslPath: string) {
    if (wslPath === activePath) return;
    onActivePathChange(wslPath);
  }

  function requestSave() {
    if (!activePath) return;
    onSaveRequest(activePath);
  }

  function handleTabKeydown(event: KeyboardEvent, wslPath: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTab(wslPath);
    }
  }
</script>

<div
  class="internal-editor"
  data-testid={TEST_IDS.internalEditorShell}
>
  <div class="internal-editor__toolbar">
    <div class="internal-editor__meta">
      <span class="internal-editor__eyebrow">{title}</span>
      {#if activeTab}
        <div class="internal-editor__path">
          <strong>{basenameFromPath(activeTab.wslPath)}</strong>
          <span>{directoryFromPath(activeTab.wslPath)}</span>
        </div>
      {:else}
        <div class="internal-editor__path">
          <strong>{emptyTitle}</strong>
          <span>{emptyDescription}</span>
        </div>
      {/if}
    </div>

    <div class="internal-editor__actions">
      {#if statusText}
        <span class="internal-editor__status">{statusText}</span>
      {/if}
      <Button size="sm" onclick={onOpenFile}>
        {openFileLabel}
      </Button>
      <Button size="sm" variant="secondary" onclick={onSwitchToTerminal}>
        {switchToTerminalLabel}
      </Button>
      <Button
        size="sm"
        variant="primary"
        busy={busy || activeTab?.saving}
        disabled={!activeTab || !activeTab.dirty || !!activeTab.loading || !!activeTab.saving}
        onclick={requestSave}
      >
        {saveLabel}
      </Button>
    </div>
  </div>

  <div class="internal-editor__tabs" data-testid={TEST_IDS.internalEditorTabBar} role="tablist">
    {#if tabs.length === 0}
      <div class="internal-editor__empty-strip">{emptyDescription}</div>
    {:else}
      {#each tabs as tab (tab.wslPath)}
        <div
          class:selected={tab.wslPath === activePath}
          class="internal-editor__tab"
          role="tab"
          tabindex="0"
          aria-selected={tab.wslPath === activePath}
          onkeydown={(event) => handleTabKeydown(event, tab.wslPath)}
        >
          <button type="button" class="internal-editor__tab-select" onclick={() => selectTab(tab.wslPath)}>
            <span>{basenameFromPath(tab.wslPath)}</span>
            {#if tab.dirty}
              <span class="internal-editor__dirty" aria-label="dirty"></span>
            {/if}
          </button>
          <button
            type="button"
            class="internal-editor__tab-close"
            aria-label={`Close ${basenameFromPath(tab.wslPath)}`}
            onclick={() => onCloseTab(tab.wslPath)}
          >
            ×
          </button>
        </div>
      {/each}
    {/if}
  </div>

  <div class="internal-editor__surface-wrap">
    {#if activeTab}
      <div class="internal-editor__surface" bind:this={editorSurfaceEl}></div>
      {#if activeTab.error}
        <div class="internal-editor__overlay internal-editor__overlay--error">
          {activeTab.error}
        </div>
      {:else if activeTab.loading}
        <div class="internal-editor__overlay">Loading…</div>
      {/if}
    {:else}
      <div class="internal-editor__empty-state">
        <h2>{emptyTitle}</h2>
        <p>{emptyDescription}</p>
        <Button onclick={onOpenFile}>{openFileLabel}</Button>
      </div>
    {/if}
  </div>
</div>

<style>
  .internal-editor {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    background:
      radial-gradient(circle at top right, rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.12), transparent 28%),
      var(--ui-bg-app, var(--app-bg));
  }

  .internal-editor__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-4);
    padding: var(--ui-space-4);
    border-bottom: 1px solid var(--ui-border-subtle, var(--tab-border));
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 94%, transparent), transparent),
      var(--ui-bg-app, var(--app-bg));
  }

  .internal-editor__meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
  }

  .internal-editor__eyebrow {
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ui-text-muted, var(--tab-text));
    font-weight: 700;
  }

  .internal-editor__path {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .internal-editor__path strong,
  .internal-editor__path span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .internal-editor__path strong {
    color: var(--ui-text-primary, var(--tab-text));
  }

  .internal-editor__path span {
    font-size: var(--ui-font-size-sm);
    color: var(--ui-text-muted, var(--tab-text));
  }

  .internal-editor__actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--ui-space-2);
    flex-wrap: wrap;
  }

  .internal-editor__status {
    font-size: var(--ui-font-size-sm);
    color: var(--ui-text-muted, var(--tab-text));
  }

  .internal-editor__tabs {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 0 var(--ui-space-3);
    border-bottom: 1px solid var(--ui-border-subtle, var(--tab-border));
    background: color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 46%, transparent);
    overflow-x: auto;
  }

  .internal-editor__empty-strip {
    padding: var(--ui-space-3) 0;
    font-size: var(--ui-font-size-sm);
    color: var(--ui-text-muted, var(--tab-text));
  }

  .internal-editor__tab {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 0;
    margin-top: 6px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: var(--ui-radius-md) var(--ui-radius-md) 0 0;
    background: transparent;
  }

  .internal-editor__tab.selected {
    background: var(--ui-bg-elevated, var(--tab-active-bg));
    border-color: var(--ui-border-subtle, var(--tab-border));
  }

  .internal-editor__tab-select,
  .internal-editor__tab-close {
    border: none;
    background: transparent;
    color: var(--ui-text-primary, var(--tab-text));
    cursor: pointer;
    font: inherit;
  }

  .internal-editor__tab-select {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 240px;
    padding: 10px 8px 10px 12px;
  }

  .internal-editor__tab-select span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .internal-editor__tab-close {
    padding: 0 10px 0 0;
    opacity: 0.7;
  }

  .internal-editor__dirty {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--ui-accent, #7dd3fc);
    flex-shrink: 0;
  }

  .internal-editor__surface-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .internal-editor__surface {
    width: 100%;
    height: 100%;
  }

  .internal-editor__overlay,
  .internal-editor__empty-state {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    text-align: center;
    padding: var(--ui-space-6);
  }

  .internal-editor__overlay {
    background: rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.14);
    backdrop-filter: blur(3px);
    color: var(--ui-text-primary, var(--tab-text));
  }

  .internal-editor__overlay--error {
    color: var(--ui-danger, #ef4444);
  }

  .internal-editor__empty-state {
    gap: var(--ui-space-3);
    align-content: center;
  }

  .internal-editor__empty-state h2,
  .internal-editor__empty-state p {
    margin: 0;
  }

  .internal-editor__empty-state p {
    color: var(--ui-text-muted, var(--tab-text));
  }

  @media (max-width: 900px) {
    .internal-editor__toolbar {
      flex-direction: column;
      align-items: stretch;
    }

    .internal-editor__actions {
      justify-content: stretch;
    }

    :global(.internal-editor__actions .ui-button) {
      flex: 1;
    }
  }
</style>
