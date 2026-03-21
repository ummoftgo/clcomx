<script lang="ts">
  import { onMount } from "svelte";
  import { listWslDistros, listWslDirectories, type WslEntry } from "../wsl";

  interface Props {
    visible: boolean;
    onConfirm: (distro: string, workDir: string) => void;
    onCancel: () => void;
  }

  let { visible, onConfirm, onCancel }: Props = $props();

  let step = $state<"distro" | "directory">("distro");
  let distros = $state<string[]>([]);
  let selectedDistro = $state("");
  let currentPath = $state("/home");
  let directories = $state<WslEntry[]>([]);
  let loading = $state(true);
  let pathInput = $state("/home");
  let error = $state("");

  onMount(async () => {
    try {
      distros = await listWslDistros();
      if (distros.length === 0) {
        error = "No WSL distributions found.";
      }
      loading = false;
    } catch (e) {
      error = `Failed to list WSL distributions: ${e}`;
      loading = false;
    }
  });

  function selectDistro(distro: string) {
    selectedDistro = distro;
    step = "directory";
    navigateTo("/home");
  }

  async function navigateTo(path: string) {
    currentPath = path;
    pathInput = path;
    loading = true;
    error = "";
    try {
      directories = await listWslDirectories(selectedDistro, path);
    } catch (e) {
      error = `Failed to list directories: ${e}`;
      directories = [];
    }
    loading = false;
  }

  function goUp() {
    const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
    navigateTo(parent);
  }

  function enterDir(dir: WslEntry) {
    navigateTo(dir.path);
  }

  function confirmDirectory() {
    onConfirm(selectedDistro, currentPath);
  }

  function handlePathKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      navigateTo(pathInput);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!visible) return;
    if (e.key === "Escape") {
      onCancel();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" style:display={visible ? "flex" : "none"} onclick={onCancel}>
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    {#if step === "distro"}
      <h2>Select WSL Distribution</h2>

      {#if loading}
        <div class="loading">Loading distributions...</div>
      {:else if error}
        <div class="error">{error}</div>
      {:else}
        <div class="list">
          {#each distros as distro}
            <button class="list-item" onclick={() => selectDistro(distro)}>
              <span class="icon">&#x1F4E6;</span>
              <span>{distro}</span>
            </button>
          {/each}
        </div>
      {/if}
    {:else}
      <h2>Select Working Directory</h2>
      <p class="distro-badge">{selectedDistro}</p>

      <div class="path-bar">
        <button class="path-btn" onclick={goUp} title="Go up">&#x2191;</button>
        <input
          class="path-input"
          type="text"
          bind:value={pathInput}
          onkeydown={handlePathKeydown}
        />
        <button class="path-btn" onclick={() => navigateTo(pathInput)}>Go</button>
      </div>

      {#if loading}
        <div class="loading">Loading...</div>
      {:else if error}
        <div class="error">{error}</div>
      {:else}
        <div class="list">
          {#each directories as dir}
            <button class="list-item" ondblclick={() => enterDir(dir)} onclick={() => { currentPath = dir.path; pathInput = dir.path; }}>
              <span class="icon">&#x1F4C1;</span>
              <span>{dir.name}</span>
            </button>
          {/each}
          {#if directories.length === 0}
            <div class="empty">No subdirectories</div>
          {/if}
        </div>
      {/if}

      <div class="dialog-footer">
        <span class="current-path" title={currentPath}>{currentPath}</span>
        <div class="dialog-actions">
          <button class="btn btn-secondary" onclick={() => { step = "distro"; }}>Back</button>
          <button class="btn btn-primary" onclick={confirmDirectory}>Open Here</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    background: var(--tab-bg);
    border: 1px solid var(--tab-border);
    border-radius: 8px;
    padding: 20px;
    min-width: 480px;
    max-width: 600px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 16px;
    font-weight: 500;
    color: var(--tab-text);
  }

  .distro-badge {
    display: inline-block;
    padding: 2px 8px;
    background: var(--tab-active-bg);
    border-radius: 4px;
    font-size: 12px;
    color: var(--tab-text);
    opacity: 0.8;
    margin: 0 0 12px;
  }

  .path-bar {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }

  .path-input {
    flex: 1;
    padding: 6px 10px;
    background: var(--tab-active-bg);
    border: 1px solid var(--tab-border);
    border-radius: 4px;
    color: var(--tab-text);
    font-family: monospace;
    font-size: 13px;
  }

  .path-btn {
    padding: 6px 10px;
    background: var(--tab-active-bg);
    border: 1px solid var(--tab-border);
    border-radius: 4px;
    color: var(--tab-text);
    cursor: pointer;
    font-size: 14px;
  }

  .path-btn:hover {
    background: var(--tab-border);
  }

  .list {
    flex: 1;
    overflow-y: auto;
    max-height: 300px;
    border: 1px solid var(--tab-border);
    border-radius: 4px;
  }

  .list-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--tab-border);
    color: var(--tab-text);
    font-size: 14px;
    cursor: pointer;
    text-align: left;
  }

  .list-item:last-child {
    border-bottom: none;
  }

  .list-item:hover {
    background: var(--tab-active-bg);
  }

  .icon {
    font-size: 16px;
    flex-shrink: 0;
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 12px;
    gap: 12px;
  }

  .current-path {
    font-size: 12px;
    font-family: monospace;
    color: var(--tab-text);
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .dialog-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .btn {
    padding: 6px 16px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid var(--tab-border);
  }

  .btn-secondary {
    background: transparent;
    color: var(--tab-text);
  }

  .btn-primary {
    background: #89b4fa;
    color: #1e1e2e;
    border-color: #89b4fa;
    font-weight: 500;
  }

  .btn:hover {
    opacity: 0.9;
  }

  .loading, .empty {
    padding: 20px;
    text-align: center;
    color: var(--tab-text);
    opacity: 0.6;
  }

  .error {
    padding: 12px;
    color: #f38ba8;
    font-size: 13px;
  }
</style>
