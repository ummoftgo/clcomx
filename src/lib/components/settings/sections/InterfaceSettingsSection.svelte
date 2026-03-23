<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import Button from "../../../ui/components/Button.svelte";
  import ThemePicker from "../../ThemePicker.svelte";
  import FontPicker from "../../FontPicker.svelte";
  import { ensureEditorsDetected, getEditorDetectionState } from "../../../stores/editors.svelte";
  import { getSettings, updateSettings } from "../../../stores/settings.svelte";
  import { TEST_IDS } from "../../../testids";
  import type { FileOpenMode, LanguagePreference } from "../../../types";

  const settings = getSettings();
  const editorDetection = getEditorDetectionState();
  const editors = $derived(editorDetection.editors);
  const editorsLoading = $derived(editorDetection.loading);
  const editorsError = $derived(editorDetection.error);

  function clampUiScale(value: number) {
    if (!Number.isFinite(value)) return 100;
    return Math.min(200, Math.max(80, Math.trunc(value)));
  }

  function setUiScale(value: number) {
    updateSettings({
      interface: {
        uiScale: clampUiScale(value),
      },
    });
  }

  function clampWindowCols(value: number) {
    if (!Number.isFinite(value)) return settings.interface.windowDefaultCols;
    return Math.min(300, Math.max(60, Math.trunc(value)));
  }

  function clampWindowRows(value: number) {
    if (!Number.isFinite(value)) return settings.interface.windowDefaultRows;
    return Math.min(100, Math.max(10, Math.trunc(value)));
  }

  function handleLanguageInput(event: Event) {
    updateSettings({
      language: (event.target as HTMLSelectElement).value as LanguagePreference,
    });
  }

  function handleFileOpenModeInput(event: Event) {
    updateSettings({
      interface: {
        fileOpenMode: (event.target as HTMLSelectElement).value as FileOpenMode,
      },
    });
  }

  function primeEditors() {
    void ensureEditorsDetected();
  }
</script>

<div class="settings-fields">
  <div class="field">
    <label for="language-pref">{$t("settings.fields.language")}</label>
    <select
      id="language-pref"
      class="number-input"
      value={settings.language}
      onchange={handleLanguageInput}
    >
      <option value="system">{$t("common.locales.system")}</option>
      <option value="en">{$t("common.locales.en")}</option>
      <option value="ko">{$t("common.locales.ko")}</option>
    </select>
  </div>

  <div class="field-block">
    <div class="field-head">
      <h4>{$t("settings.fields.theme")}</h4>
      <p>{$t("settings.fields.themeHint")}</p>
    </div>
    <ThemePicker
      selectedId={settings.interface.theme}
      onChange={(id) => updateSettings({ interface: { theme: id } })}
    />
  </div>

  <div class="field">
    <label for="ui-scale-range">{$t("settings.fields.uiScale")}</label>
    <div class="range-row range-row--wide">
      <input
        id="ui-scale-range"
        class="range"
        type="range"
        min="80"
        max="200"
        step="1"
        value={settings.interface.uiScale}
        oninput={(event) => setUiScale(Number((event.target as HTMLInputElement).value))}
      />
      <div class="scale-control">
        <div class="scale-input-shell">
          <input
            data-testid={TEST_IDS.settingsInterfaceUiScaleInput}
            class="number-input scale-input"
            type="number"
            min="80"
            max="200"
            step="1"
            value={settings.interface.uiScale}
            oninput={(event) => setUiScale(Number((event.target as HTMLInputElement).value))}
          />
          <span class="scale-suffix">%</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="scale-reset"
          onclick={() => setUiScale(100)}
          aria-label={$t("settings.fields.uiScaleReset", { default: "Reset UI scale to 100%" })}
        >
          100%
        </Button>
      </div>
    </div>
    <p class="field-message">{$t("settings.fields.uiScaleHint")}</p>
  </div>

  <div class="field-stack">
    <FontPicker
      label={$t("settings.fields.uiPrimaryFont")}
      value={settings.interface.uiFontFamily}
      placeholder={$t("settings.placeholders.uiPrimaryFont")}
      onChange={(value) => updateSettings({ interface: { uiFontFamily: value } })}
    />
    <FontPicker
      label={$t("settings.fields.uiFallbackFont")}
      value={settings.interface.uiFontFamilyFallback}
      placeholder={$t("settings.placeholders.uiFallbackFont")}
      onChange={(value) => updateSettings({ interface: { uiFontFamilyFallback: value } })}
    />
  </div>

  <div class="field-block">
    <div class="field-head">
      <h4>{$t("settings.fields.fileOpenMode")}</h4>
      <p>{$t("settings.fields.fileOpenModeHint")}</p>
    </div>

    <div class="field-grid">
      <div class="field">
        <label for="file-open-mode">{$t("settings.fields.fileOpenMode")}</label>
        <select
          id="file-open-mode"
          class="number-input"
          value={settings.interface.fileOpenMode}
          onchange={handleFileOpenModeInput}
        >
          <option value="default">{$t("settings.fileOpen.modes.default")}</option>
          <option value="picker">{$t("settings.fileOpen.modes.picker")}</option>
        </select>
      </div>

      <div class="field">
        <label for="default-editor">{$t("settings.fields.defaultEditor")}</label>
        <select
          id="default-editor"
          class="number-input"
          value={settings.interface.defaultEditorId}
          disabled={editorsLoading || editors.length === 0}
          onfocus={primeEditors}
          onpointerdown={primeEditors}
          onchange={(event) =>
            updateSettings({
              interface: { defaultEditorId: (event.target as HTMLSelectElement).value },
            })}
        >
          <option value="">
            {#if editorsLoading}
              {$t("settings.fileOpen.loadingEditors")}
            {:else}
              {$t("settings.workspace.none")}
            {/if}
          </option>
          {#each editors as editor (editor.id)}
            <option value={editor.id}>{editor.label}</option>
          {/each}
        </select>
        <p class="field-message">
          {#if editorsError}
            {$t("settings.fileOpen.detectFailed")}
          {:else if !editorsLoading && editors.length === 0}
            {$t("settings.fileOpen.noEditors")}
          {:else}
            {$t("settings.fields.defaultEditorHint")}
          {/if}
        </p>
      </div>
    </div>
  </div>

  <div class="field-block">
    <div class="field-head">
      <h4>{$t("settings.fields.windowDefaultSize")}</h4>
      <p>{$t("settings.fields.windowDefaultSizeHint")}</p>
    </div>

    <div class="field-grid">
      <div class="field">
        <label for="window-default-cols">{$t("settings.fields.windowDefaultCols")}</label>
        <input
          id="window-default-cols"
          class="number-input"
          type="number"
          min="60"
          max="300"
          value={settings.interface.windowDefaultCols}
          oninput={(event) =>
            updateSettings({
              interface: {
                windowDefaultCols: clampWindowCols(Number((event.target as HTMLInputElement).value)),
              },
            })}
        />
      </div>

      <div class="field">
        <label for="window-default-rows">{$t("settings.fields.windowDefaultRows")}</label>
        <input
          id="window-default-rows"
          class="number-input"
          type="number"
          min="10"
          max="100"
          value={settings.interface.windowDefaultRows}
          oninput={(event) =>
            updateSettings({
              interface: {
                windowDefaultRows: clampWindowRows(Number((event.target as HTMLInputElement).value)),
              },
            })}
        />
      </div>
    </div>
  </div>
</div>

<style>
  .scale-control {
    display: flex;
    align-items: center;
    gap: var(--ui-space-2);
    flex-shrink: 0;
  }

  .scale-input-shell {
    display: inline-flex;
    align-items: stretch;
    min-width: 122px;
    border: 1px solid var(--ui-border-subtle);
    border-radius: var(--ui-radius-md);
    overflow: hidden;
    background: color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent);
  }

  .scale-input {
    width: 84px;
    border: none;
    border-radius: 0;
    background: transparent;
  }

  .scale-suffix {
    display: inline-flex;
    align-items: center;
    padding: 0 var(--ui-space-3);
    border-left: 1px solid color-mix(in srgb, var(--ui-border-subtle) 82%, transparent);
    color: var(--ui-text-muted);
    font-size: var(--ui-font-size-sm);
    font-weight: 600;
    white-space: nowrap;
  }

  :global(.scale-reset) {
    white-space: nowrap;
  }
</style>
