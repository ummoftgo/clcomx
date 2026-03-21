<script lang="ts">
  import { onMount } from "svelte";
  import { _ as t } from "svelte-i18n";
  import Button from "../../../ui/components/Button.svelte";
  import {
    clearImageCache,
    formatImageSize,
    getImageCacheStats,
    openImageCacheFolder,
    type ImageCacheStats,
  } from "../../../clipboard";
  import { TEST_IDS } from "../../../testids";

  let busy = $state(false);
  let message = $state<string | null>(null);
  let stats = $state<ImageCacheStats>({
    path: "",
    files: 0,
    bytes: 0,
  });

  async function refreshStats() {
    try {
      stats = await getImageCacheStats();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  }

  async function handleClearImageCache() {
    busy = true;
    message = null;

    try {
      const deleted = await clearImageCache();
      await refreshStats();
      message = deleted > 0
        ? $t("settings.imageCache.deleted", { values: { count: deleted } })
        : $t("settings.imageCache.empty");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function handleOpenFolder() {
    message = null;
    try {
      await openImageCacheFolder();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  }

  onMount(() => {
    void refreshStats();
  });
</script>

<div class="settings-fields">
  <div class="storage-summary">
    <div class="storage-card">
      <span class="storage-label">{$t("settings.storage.files")}</span>
      <strong data-testid={TEST_IDS.settingsStorageFiles}>{stats.files}</strong>
    </div>
    <div class="storage-card">
      <span class="storage-label">{$t("settings.storage.size")}</span>
      <strong data-testid={TEST_IDS.settingsStorageSize}>{formatImageSize(stats.bytes)}</strong>
    </div>
  </div>

  <div class="field">
    <label for="image-cache-path">{$t("settings.storage.path")}</label>
    <div class="path-row">
      <input
        id="image-cache-path"
        class="number-input path-input"
        type="text"
        value={stats.path}
        readonly
      />
      <Button
        size="sm"
        variant="ghost"
        data-testid={TEST_IDS.settingsStorageOpenFolder}
        onclick={handleOpenFolder}
      >
        {$t("settings.imageCache.openFolder")}
      </Button>
    </div>
    <p class="field-message">{$t("settings.storage.pathHint")}</p>
  </div>

  <div class="storage-actions">
    <Button
      size="sm"
      variant="secondary"
      data-testid={TEST_IDS.settingsStorageClearCache}
      onclick={handleClearImageCache}
      disabled={busy}
    >
      {#if busy}
        {$t("settings.imageCache.deleting")}
      {:else}
        {$t("settings.imageCache.clear")}
      {/if}
    </Button>
  </div>

  {#if message}
    <p class="field-message">{message}</p>
  {/if}
</div>

<style>
  .storage-summary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--ui-space-3);
  }

  .storage-card {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
    padding: var(--ui-space-4);
    border: 1px solid var(--ui-border-subtle);
    border-radius: var(--ui-radius-lg);
    background: color-mix(in srgb, var(--ui-bg-elevated) 92%, transparent);
  }

  .storage-label {
    font-size: var(--ui-font-size-sm);
    color: var(--ui-text-muted);
  }

  .storage-card strong {
    font-size: var(--ui-font-size-lg);
    color: var(--ui-text-primary);
  }

  .storage-actions {
    display: flex;
    gap: var(--ui-space-2);
    flex-wrap: wrap;
  }

  .path-row {
    display: flex;
    align-items: center;
    gap: var(--ui-space-2);
  }

  .path-input {
    flex: 1;
    min-width: 0;
  }
</style>
