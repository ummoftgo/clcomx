<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import { DARK_THEMES, LIGHT_THEMES } from "../themes";

  interface Props {
    selectedId: string;
    onChange: (id: string) => void;
  }

  let { selectedId, onChange }: Props = $props();

  let tab = $state<"dark" | "light">("dark");
</script>

<div class="theme-picker">
  <div class="tab-row" role="tablist" aria-label={$t("settings.themePicker.mode", { default: "Theme mode" })}>
    <button
      type="button"
      class="tab-btn"
      class:active={tab === "dark"}
      role="tab"
      aria-selected={tab === "dark"}
      onclick={() => (tab = "dark")}
    >
      {$t("settings.themePicker.dark", { default: "Dark" })} ({DARK_THEMES.length})
    </button>
    <button
      type="button"
      class="tab-btn"
      class:active={tab === "light"}
      role="tab"
      aria-selected={tab === "light"}
      onclick={() => (tab = "light")}
    >
      {$t("settings.themePicker.light", { default: "Light" })} ({LIGHT_THEMES.length})
    </button>
  </div>

  <div class="swatch-shell">
    <div class="grid" style:display={tab === "dark" ? "grid" : "none"}>
      {#each DARK_THEMES as theme (theme.id)}
        <button
          type="button"
          class="swatch"
          class:selected={theme.id === selectedId}
          style="background:{theme.theme.background}; color:{theme.theme.foreground}; border-color:{theme.id === selectedId ? theme.theme.blue ?? '#89b4fa' : 'transparent'}"
          onclick={() => onChange(theme.id)}
          title={theme.name}
        >
          <span class="swatch-meta">
            <span class="swatch-dots">
              <span style="color:{theme.theme.red}">●</span>
              <span style="color:{theme.theme.green}">●</span>
              <span style="color:{theme.theme.blue}">●</span>
            </span>
            {#if theme.id === selectedId}
              <span class="selected-pill">{$t("settings.themePicker.selected", { default: "Selected" })}</span>
            {/if}
          </span>
          <span class="swatch-name">{theme.name}</span>
        </button>
      {/each}
    </div>

    <div class="grid" style:display={tab === "light" ? "grid" : "none"}>
      {#each LIGHT_THEMES as theme (theme.id)}
        <button
          type="button"
          class="swatch"
          class:selected={theme.id === selectedId}
          style="background:{theme.theme.background}; color:{theme.theme.foreground}; border-color:{theme.id === selectedId ? theme.theme.blue ?? '#89b4fa' : 'transparent'}"
          onclick={() => onChange(theme.id)}
          title={theme.name}
        >
          <span class="swatch-meta">
            <span class="swatch-dots">
              <span style="color:{theme.theme.red}">●</span>
              <span style="color:{theme.theme.green}">●</span>
              <span style="color:{theme.theme.blue}">●</span>
            </span>
            {#if theme.id === selectedId}
              <span class="selected-pill">{$t("settings.themePicker.selected", { default: "Selected" })}</span>
            {/if}
          </span>
          <span class="swatch-name">{theme.name}</span>
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .theme-picker {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-3);
  }

  .tab-row {
    display: inline-flex;
    padding: var(--ui-space-1);
    gap: var(--ui-space-1);
    align-self: flex-start;
    border: 1px solid color-mix(in srgb, var(--tab-border) 72%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--tab-bg) 86%, transparent);
  }

  .tab-btn {
    padding: calc(7px * var(--ui-scale)) var(--ui-space-4);
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--tab-text);
    font-size: var(--ui-font-size-sm);
    font-weight: 600;
    cursor: pointer;
    opacity: 0.72;
    transition: background 0.14s ease, opacity 0.14s ease, transform 0.14s ease;
  }

  .tab-btn.active {
    opacity: 1;
    background: var(--tab-active-bg);
    box-shadow: 0 4px 14px rgba(2, 6, 23, 0.18);
    transform: translateY(-1px);
  }

  .swatch-shell {
    display: grid;
    padding: var(--ui-space-3);
    border: 1px solid color-mix(in srgb, var(--tab-border) 72%, transparent);
    border-radius: var(--ui-radius-xl);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--tab-bg) 88%, transparent), color-mix(in srgb, var(--tab-active-bg) 72%, transparent)),
      color-mix(in srgb, var(--tab-bg) 88%, transparent);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 10px 24px rgba(2, 6, 23, 0.12);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
    gap: var(--ui-space-3);
    max-height: calc(320px * var(--ui-scale));
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 4px;
    scrollbar-gutter: stable;
  }

  .swatch {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--ui-space-3);
    min-height: calc(90px * var(--ui-scale));
    padding: var(--ui-space-3);
    border-radius: var(--ui-radius-lg);
    border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    box-shadow: 0 10px 22px rgba(2, 6, 23, 0.14);
    transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
  }

  .swatch::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.08));
    pointer-events: none;
  }

  .swatch:hover {
    transform: translateY(-1px);
    box-shadow: 0 14px 28px rgba(2, 6, 23, 0.18);
  }

  .swatch.selected {
    border-color: currentColor;
    box-shadow: 0 0 0 1px currentColor, 0 16px 28px rgba(2, 6, 23, 0.2);
  }

  .swatch-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
    width: 100%;
  }

  .swatch-dots {
    font-size: var(--ui-font-size-base);
    letter-spacing: 2px;
    white-space: nowrap;
  }

  .selected-pill {
    flex-shrink: 0;
    padding: calc(3px * var(--ui-scale)) var(--ui-space-2);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.14);
    font-size: var(--ui-font-size-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .swatch-name {
    position: relative;
    z-index: 1;
    max-width: 100%;
    font-size: var(--ui-font-size-sm);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
