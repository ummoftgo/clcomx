<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import type { Component } from "svelte";
  import Button from "../ui/components/Button.svelte";
  import Panel from "../ui/components/Panel.svelte";
  import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings/registry";
  import { TEST_IDS, settingsNavSectionTestId } from "../testids";

  interface Props {
    visible: boolean;
    onClose: () => void;
  }

  let { visible, onClose }: Props = $props();
  let activeSectionId = $state<SettingsSectionId>("interface");
  let sectionBodyEl = $state<HTMLDivElement | null>(null);
  let sectionScrolled = $state(false);

  function handleKeydown(event: KeyboardEvent) {
    if (!visible) return;
    if (event.key === "Escape") onClose();
  }

  function updateSectionScrollState() {
    sectionScrolled = (sectionBodyEl?.scrollTop ?? 0) > 0;
  }

  const activeSection = $derived(
    SETTINGS_SECTIONS.find((section) => section.id === activeSectionId) ?? SETTINGS_SECTIONS[0],
  );

  const ActiveSectionComponent = $derived(activeSection.component as Component);

  $effect(() => {
    visible;
    activeSectionId;
    requestAnimationFrame(updateSectionScrollState);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="settings-shell"
  data-testid={TEST_IDS.settingsModal}
  style:display={visible ? "flex" : "none"}
>
  <Panel as="div" tone="elevated" class="settings-panel">
    <header class="panel-header">
      <div class="heading-copy">
        <p class="eyebrow">{$t("settings.eyebrow")}</p>
        <h2>{$t("settings.title")}</h2>
        <p class="subtitle">{$t("settings.subtitle")}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        class="close-btn"
        onclick={onClose}
        aria-label={$t("settings.close")}
      >
        &times;
      </Button>
    </header>

    <div class="settings-layout">
      <nav
        class="settings-nav"
        data-testid={TEST_IDS.settingsNav}
        aria-label={$t("settings.nav.label")}
      >
        {#each SETTINGS_SECTIONS as section (section.id)}
          <button
            type="button"
            class:active={section.id === activeSectionId}
            data-testid={settingsNavSectionTestId(section.id)}
            onclick={() => { activeSectionId = section.id; }}
          >
            <span class="nav-title">{$t(section.titleKey)}</span>
            <span class="nav-description">{$t(section.descriptionKey)}</span>
          </button>
        {/each}
      </nav>

      <section class="settings-content settings-view" class:scrolled={sectionScrolled}>
        <div class="section-header">
          <h3>{$t(activeSection.titleKey)}</h3>
          <p>{$t(activeSection.descriptionKey)}</p>
        </div>

        <div
          class="section-body"
          data-testid={TEST_IDS.settingsBody}
          data-section-id={activeSection.id}
          bind:this={sectionBodyEl}
          onscroll={updateSectionScrollState}
        >
          <ActiveSectionComponent />
        </div>
      </section>
    </div>
  </Panel>
</div>

<style>
  .settings-shell {
    position: fixed;
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: stretch;
    padding: var(--ui-space-4);
    background: var(--ui-bg-overlay);
    z-index: 200;
    backdrop-filter: blur(10px);
  }

  :global(.settings-panel) {
    width: min(1120px, 100%);
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-elevated) 92%, transparent), var(--ui-bg-surface)),
      var(--ui-bg-surface);
    border: 1px solid var(--ui-border-subtle);
    box-shadow: 0 24px 54px rgba(var(--ui-shadow-rgb), 0.34);
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--ui-space-4);
    padding: var(--ui-space-5) var(--ui-space-5) var(--ui-space-4);
    border-bottom: 1px solid color-mix(in srgb, var(--ui-border-subtle) 72%, transparent);
  }

  .heading-copy {
    display: grid;
    gap: var(--ui-space-2);
  }

  .eyebrow {
    font-size: var(--ui-font-size-sm);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-muted);
  }

  .heading-copy h2 {
    font-size: var(--ui-font-size-xl);
    line-height: 1.1;
  }

  .subtitle {
    max-width: 72ch;
    font-size: var(--ui-font-size-base);
    color: var(--ui-text-secondary);
  }

  .settings-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(240px, 280px) minmax(0, 1fr);
  }

  .settings-nav {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-2);
    padding: var(--ui-space-4);
    border-right: 1px solid color-mix(in srgb, var(--ui-border-subtle) 72%, transparent);
    background: color-mix(in srgb, var(--ui-bg-elevated) 82%, transparent);
  }

  .settings-nav button {
    display: grid;
    gap: var(--ui-space-1);
    padding: var(--ui-space-3) var(--ui-space-4);
    border: 1px solid transparent;
    border-radius: var(--ui-radius-lg);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
  }

  .settings-nav button:hover {
    border-color: var(--ui-border-subtle);
    background: color-mix(in srgb, var(--ui-bg-surface) 72%, transparent);
  }

  .settings-nav button.active {
    border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border-strong));
    background: color-mix(in srgb, var(--ui-accent-soft) 72%, var(--ui-bg-surface));
  }

  .nav-title {
    font-size: var(--ui-font-size-md);
    font-weight: 700;
    color: var(--ui-text-primary);
  }

  .nav-description {
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    color: var(--ui-text-muted);
  }

  .settings-content {
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .section-header {
    display: grid;
    gap: var(--ui-space-1);
    padding: var(--ui-space-5) var(--ui-space-5) var(--ui-space-4);
    border-bottom: 1px solid color-mix(in srgb, var(--ui-border-subtle) 72%, transparent);
    position: relative;
    z-index: 1;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface) 94%, transparent), color-mix(in srgb, var(--ui-bg-elevated) 74%, transparent)),
      var(--ui-bg-surface);
    transition: box-shadow 160ms ease, border-color 160ms ease;
  }

  .settings-content.scrolled .section-header {
    box-shadow: 0 14px 26px rgba(var(--ui-shadow-rgb), 0.18);
    border-bottom-color: color-mix(in srgb, var(--ui-border-strong) 84%, transparent);
  }

  .section-header h3 {
    font-size: calc(var(--ui-font-size-lg) + 2px);
    line-height: 1.15;
  }

  .section-header p {
    font-size: var(--ui-font-size-base);
    color: var(--ui-text-secondary);
  }

  .section-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--ui-space-5);
  }

  :global(.settings-view .settings-fields) {
    display: grid;
    gap: var(--ui-space-5);
  }

  :global(.settings-view .field),
  :global(.settings-view .field-block) {
    display: grid;
    gap: var(--ui-space-2);
  }

  :global(.settings-view .field-stack) {
    display: grid;
    gap: var(--ui-space-4);
  }

  :global(.settings-view .field-head) {
    display: grid;
    gap: var(--ui-space-1);
  }

  :global(.settings-view .field-head h4) {
    font-size: var(--ui-font-size-md);
  }

  :global(.settings-view .field-head p),
  :global(.settings-view .field-message) {
    font-size: var(--ui-font-size-sm);
    line-height: 1.5;
    color: var(--ui-text-muted);
  }

  :global(.settings-view .field label) {
    font-size: var(--ui-font-size-sm);
    color: var(--ui-text-secondary);
  }

  :global(.settings-view .field-grid) {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--ui-space-4);
  }

  :global(.settings-view .number-input) {
    min-height: calc(42px * var(--ui-scale));
    padding: 0 var(--ui-space-3);
    border: 1px solid var(--ui-border-subtle);
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent);
    color: var(--ui-text-primary);
    font-size: var(--ui-font-size-base);
  }

  :global(.settings-view .number-wide) {
    max-width: 180px;
  }

  :global(.settings-view .range-row) {
    display: flex;
    align-items: center;
    gap: var(--ui-space-3);
  }

  :global(.settings-view .input-with-affix) {
    position: relative;
    display: inline-flex;
    align-items: stretch;
  }

  :global(.settings-view .input-with-affix .number-input) {
    padding-right: calc(38px * var(--ui-scale));
  }

  :global(.settings-view .input-affix) {
    position: absolute;
    top: 0;
    right: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: calc(34px * var(--ui-scale));
    height: 100%;
    border-left: 1px solid color-mix(in srgb, var(--ui-border-subtle) 84%, transparent);
    color: var(--ui-text-muted);
    font-size: var(--ui-font-size-sm);
    pointer-events: none;
  }

  :global(.settings-view .range-row--wide .range) {
    flex: 1;
  }

  :global(.settings-view .range) {
    width: 100%;
  }

  :global(.settings-view .scale-input) {
    width: 92px;
  }

  :global(.settings-view .scale-reset) {
    flex-shrink: 0;
    min-width: 72px;
  }

  @media (max-width: 960px) {
    :global(.settings-panel) {
      width: 100%;
    }

    .settings-layout {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }

    .settings-nav {
      flex-direction: row;
      overflow-x: auto;
      border-right: none;
      border-bottom: 1px solid color-mix(in srgb, var(--ui-border-subtle) 72%, transparent);
    }

    .settings-nav button {
      min-width: 200px;
    }

    :global(.settings-view .field-grid) {
      grid-template-columns: 1fr;
    }
  }
</style>
