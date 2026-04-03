<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import FontPicker from "../../FontPicker.svelte";
  import { getSettings, updateSettings } from "../../../stores/settings.svelte";

  const settings = getSettings();

  function clampEditorFontSize(value: number) {
    if (!Number.isFinite(value)) return settings.editor.fontSize;
    return Math.min(24, Math.max(10, Math.trunc(value)));
  }

  function setEditorFontSize(value: number) {
    updateSettings({
      editor: {
        fontSize: clampEditorFontSize(value),
      },
    });
  }
</script>

<div class="settings-fields">
  <div class="field-stack">
    <FontPicker
      label={$t("settings.fields.editorPrimaryFont")}
      value={settings.editor.fontFamily}
      placeholder={$t("settings.placeholders.primaryFont")}
      onChange={(value) => updateSettings({ editor: { fontFamily: value } })}
    />
    <FontPicker
      label={$t("settings.fields.editorFallbackFont")}
      value={settings.editor.fontFamilyFallback}
      placeholder={$t("settings.placeholders.fallbackFont")}
      onChange={(value) => updateSettings({ editor: { fontFamilyFallback: value } })}
    />
  </div>

  <div class="field">
    <label for="editor-font-size-range">{$t("settings.fields.editorFontSize")}</label>
    <div class="range-row range-row--wide">
      <input
        id="editor-font-size-range"
        class="range"
        type="range"
        min="10"
        max="24"
        step="1"
        value={settings.editor.fontSize}
        oninput={(event) => setEditorFontSize(Number((event.target as HTMLInputElement).value))}
      />
      <div class="scale-control">
        <div class="scale-input-shell">
          <input
            class="number-input scale-input"
            type="number"
            min="10"
            max="24"
            step="1"
            value={settings.editor.fontSize}
            oninput={(event) => setEditorFontSize(Number((event.target as HTMLInputElement).value))}
          />
          <span class="scale-suffix">px</span>
        </div>
      </div>
    </div>
    <p class="field-message">{$t("settings.fields.editorFontSizeHint")}</p>
  </div>
</div>

<style>
  .scale-control {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    min-width: calc(96px * var(--ui-scale));
  }

  .scale-input-shell {
    display: inline-flex;
    align-items: center;
    gap: var(--ui-space-2);
    padding-inline: var(--ui-space-2);
    min-height: calc(38px * var(--ui-scale));
    border-radius: var(--ui-radius-md);
    border: 1px solid var(--ui-border-strong, var(--tab-border));
    background: var(--ui-bg-elevated, var(--tab-hover-bg));
  }

  .scale-input {
    width: calc(60px * var(--ui-scale));
    border: 0;
    background: transparent;
    padding-inline: 0;
    text-align: right;
  }

  .scale-suffix {
    color: var(--ui-text-muted, var(--tab-text));
    font-size: 0.92em;
  }
</style>
