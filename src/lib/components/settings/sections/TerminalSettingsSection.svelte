<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import FontPicker from "../../FontPicker.svelte";
  import { getSettings, updateSettings } from "../../../stores/settings.svelte";

  const settings = getSettings();

  function getDraftRowsCap() {
    const approxLineHeight = settings.terminal.fontSize * 1.5;
    const reservedHeight = 320;
    return Math.max(1, Math.floor((window.innerHeight - reservedHeight) / approxLineHeight));
  }

  let draftRowsCap = $state(20);

  function clampDraftRows(value: number) {
    if (!Number.isFinite(value)) return 5;
    return Math.min(draftRowsCap, Math.max(1, Math.trunc(value)));
  }

  $effect(() => {
    draftRowsCap = getDraftRowsCap();
    if (settings.terminal.draftMaxRows > draftRowsCap) {
      updateSettings({ terminal: { draftMaxRows: draftRowsCap } });
    }
  });
</script>

<svelte:window onresize={() => { draftRowsCap = getDraftRowsCap(); }} />

<div class="settings-fields">
  <div class="field-stack">
    <FontPicker
      label={$t("settings.fields.terminalPrimaryFont")}
      value={settings.terminal.fontFamily}
      placeholder={$t("settings.placeholders.primaryFont")}
      onChange={(value) => updateSettings({ terminal: { fontFamily: value } })}
    />
    <FontPicker
      label={$t("settings.fields.terminalFallbackFont")}
      value={settings.terminal.fontFamilyFallback}
      placeholder={$t("settings.placeholders.fallbackFont")}
      onChange={(value) => updateSettings({ terminal: { fontFamilyFallback: value } })}
    />
  </div>

  <div class="field">
    <label for="terminal-font-size">{$t("settings.fields.terminalFontSize")}</label>
    <div class="range-row">
      <input
        id="terminal-font-size"
        class="range"
        type="range"
        min="10"
        max="24"
        value={settings.terminal.fontSize}
        oninput={(event) =>
          updateSettings({
            terminal: { fontSize: Number((event.target as HTMLInputElement).value) },
          })}
      />
      <span class="value-label">{settings.terminal.fontSize}px</span>
    </div>
  </div>

  <div class="field">
    <label for="draft-max-rows">{$t("settings.fields.draftMaxRows")}</label>
    <input
      id="draft-max-rows"
      class="number-input number-wide"
      type="number"
      min="1"
      max={draftRowsCap}
      value={Math.min(settings.terminal.draftMaxRows, draftRowsCap)}
      oninput={(event) =>
        updateSettings({
          terminal: { draftMaxRows: clampDraftRows(Number((event.target as HTMLInputElement).value)) },
        })}
    />
    <p class="field-message">{$t("settings.fields.draftMaxRowsHint")}</p>
    <p class="field-message">{$t("settings.fields.draftBehaviorHint")}</p>
  </div>
</div>
