<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { _ as t } from "svelte-i18n";
  import Button from "../ui/components/Button.svelte";
  import { buildFontStack, serializeFontFamilyList } from "../font-family";

  interface Props {
    label: string;
    value: string;
    placeholder?: string;
    onChange: (val: string) => void;
  }

  let { label, value, placeholder = "", onChange }: Props = $props();
  const uid = $props.id();

  let allFonts = $state<string[]>([]);
  let query = $state("");
  let showDropdown = $state(false);
  let loading = $state(false);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);

  const filtered = $derived(
    query.trim()
      ? allFonts.filter((font) =>
          font.toLowerCase().includes(query.toLowerCase()),
        )
      : allFonts,
  );

  function buildPreviewFontStack(font: string) {
    const serialized = serializeFontFamilyList(font, "");
    return serialized
      ? buildFontStack(serialized, "var(--ui-font-stack)")
      : "var(--ui-font-stack)";
  }

  onMount(async () => {
    loading = true;
    try {
      allFonts = await invoke<string[]>("list_monospace_fonts");
    } catch {
      allFonts = [];
    }
    loading = false;
  });

  function selectFont(font: string) {
    onChange(font);
    query = "";
    showDropdown = false;
    inputEl?.blur();
  }

  function handleBlur() {
    setTimeout(() => {
      showDropdown = false;
    }, 150);
  }
</script>

<div class="font-picker">
  <label for={`fp-${uid}`}>{label}</label>
  <div class="input-row">
    <div
      class="current-value"
      title={value}
      style={`font-family:${buildPreviewFontStack(value || placeholder)}`}
    >
      {value || placeholder}
    </div>
    <Button
      class="pick-btn"
      variant="secondary"
      size="sm"
      onclick={() => {
        showDropdown = !showDropdown;
        if (showDropdown) setTimeout(() => inputEl?.focus(), 0);
      }}
      aria-label={$t("settings.fontPicker.choose", { default: "Choose a font" })}
    >
      {loading ? "..." : $t("settings.fontPicker.choose", { default: "Choose" })}
    </Button>
  </div>

  {#if showDropdown}
    <div class="dropdown">
      <input
        id={`fp-${uid}`}
        bind:this={inputEl}
        class="search-input"
        type="text"
        bind:value={query}
        placeholder={$t("settings.fontPicker.search", { default: "Search fonts..." })}
        onblur={handleBlur}
      />
      <div class="font-list">
        {#if filtered.length === 0}
          <div class="empty">
            {$t("settings.fontPicker.none", { default: "No fonts found" })}
          </div>
        {:else}
          {#each filtered as font (font)}
            <button
              type="button"
              class="font-item"
              title={font}
              style={`font-family:${buildPreviewFontStack(font)}`}
              onclick={() => selectFont(font)}
            >
              <span class="font-name">{font}</span>
              <span class="font-sample">
                Aa 가나다 123
              </span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .font-picker {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-2);
  }

  label {
    font-size: var(--ui-font-size-sm);
    color: color-mix(in srgb, var(--tab-text) 72%, transparent);
  }

  .input-row {
    display: flex;
    align-items: center;
    gap: var(--ui-space-2);
  }

  .current-value {
    flex: 1;
    min-height: calc(38px * var(--ui-scale));
    padding: calc(9px * var(--ui-scale)) var(--ui-space-3);
    border: 1px solid color-mix(in srgb, var(--tab-border) 82%, transparent);
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--tab-bg) 86%, transparent);
    color: var(--tab-text);
    font-size: var(--ui-font-size-base);
    font-family: var(--ui-font-stack);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.pick-btn) {
    min-width: 82px;
    padding: calc(9px * var(--ui-scale)) var(--ui-space-3);
    border: 1px solid color-mix(in srgb, var(--tab-border) 82%, transparent);
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--tab-active-bg) 90%, transparent);
    color: var(--tab-text);
    font-size: var(--ui-font-size-sm);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  :global(.pick-btn:hover) {
    background: color-mix(in srgb, var(--tab-active-bg) 78%, transparent);
  }

  .dropdown {
    position: absolute;
    top: calc(100% + var(--ui-space-2));
    left: 0;
    right: 0;
    z-index: 300;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--tab-border) 72%, transparent);
    border-radius: var(--ui-radius-lg);
    background: color-mix(in srgb, var(--tab-bg) 92%, #020617);
    box-shadow: 0 18px 38px rgba(2, 6, 23, 0.28);
  }

  .search-input {
    padding: calc(10px * var(--ui-scale)) var(--ui-space-3);
    border: none;
    border-bottom: 1px solid color-mix(in srgb, var(--tab-border) 72%, transparent);
    background: color-mix(in srgb, var(--tab-active-bg) 82%, transparent);
    color: var(--tab-text);
    font-size: var(--ui-font-size-base);
  }

  .font-list {
    max-height: calc(240px * var(--ui-scale));
    overflow-y: auto;
  }

  .font-item {
    display: grid;
    gap: 2px;
    width: 100%;
    padding: calc(10px * var(--ui-scale)) var(--ui-space-3);
    border: none;
    border-bottom: 1px solid color-mix(in srgb, var(--tab-border) 60%, transparent);
    background: transparent;
    color: var(--tab-text);
    font-size: var(--ui-font-size-base);
    text-align: left;
    cursor: pointer;
  }

  .font-item:hover {
    background: color-mix(in srgb, var(--tab-active-bg) 82%, transparent);
  }

  .font-item:last-child {
    border-bottom: none;
  }

  .empty {
    padding: calc(14px * var(--ui-scale)) var(--ui-space-3);
    text-align: center;
    color: color-mix(in srgb, var(--tab-text) 65%, transparent);
    font-size: var(--ui-font-size-sm);
  }

  .font-name {
    font-family: var(--ui-font-stack);
    line-height: 1.25;
  }

  .font-sample {
    color: color-mix(in srgb, var(--tab-text) 72%, transparent);
    font-size: var(--ui-font-size-sm);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
