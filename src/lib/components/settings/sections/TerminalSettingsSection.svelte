<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import Button from "../../../ui/components/Button.svelte";
  import FontPicker from "../../FontPicker.svelte";
  import { eventToShortcut, normalizeShortcut } from "../../../hotkeys";
  import { getSettings, updateSettings } from "../../../stores/settings.svelte";
  import type { TerminalRendererPreference } from "../../../types";

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

  function clampAuxTerminalHeight(value: number) {
    if (!Number.isFinite(value)) return 28;
    return Math.min(70, Math.max(18, Math.trunc(value)));
  }

  function handleAuxShortcutKeydown(event: KeyboardEvent) {
    if (event.key === "Tab") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const shortcut = eventToShortcut(event);
    if (!shortcut) {
      return;
    }

    updateSettings({
      terminal: {
        auxTerminalShortcut: normalizeShortcut(shortcut),
      },
    });
  }

  function handleRendererInput(event: Event) {
    updateSettings({
      terminal: {
        renderer: (event.target as HTMLSelectElement).value as TerminalRendererPreference,
      },
    });
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
    <label for="terminal-renderer">{$t("settings.fields.terminalRenderer")}</label>
    <select
      id="terminal-renderer"
      class="number-input"
      value={settings.terminal.renderer}
      onchange={handleRendererInput}
    >
      <option value="dom">{$t("settings.terminalRenderer.modes.dom")}</option>
      <option value="webgl">{$t("settings.terminalRenderer.modes.webgl")}</option>
    </select>
    <p class="field-message">{$t("settings.fields.terminalRendererHint")}</p>
  </div>

  <div class="field-block">
    <div class="field-head">
      <h4>{$t("settings.fields.claudeFooterGhostingMitigation")}</h4>
      <p>{$t("settings.fields.claudeFooterGhostingMitigationHint")}</p>
    </div>
    <label class="toggle-row" for="claude-footer-ghosting-mitigation">
      <input
        id="claude-footer-ghosting-mitigation"
        class="toggle-input"
        type="checkbox"
        checked={settings.terminal.claudeFooterGhostingMitigation}
        onchange={(event) =>
          updateSettings({
            terminal: {
              claudeFooterGhostingMitigation: (event.target as HTMLInputElement).checked,
            },
          })}
      />
      <span class="toggle-copy">{$t("settings.fields.claudeFooterGhostingMitigationLabel")}</span>
    </label>
  </div>

  <div class="field">
    <label for="terminal-scrollback">{$t("settings.fields.terminalScrollback")}</label>
    <input
      id="terminal-scrollback"
      class="number-input number-wide"
      type="number"
      min="1000"
      max="200000"
      step="1000"
      value={settings.terminal.scrollback}
      oninput={(event) =>
        updateSettings({
          terminal: {
            scrollback: Math.min(
              200000,
              Math.max(1000, Math.trunc(Number((event.target as HTMLInputElement).value) || 10000)),
            ),
          },
        })}
    />
    <p class="field-message">{$t("settings.fields.terminalScrollbackHint")}</p>
  </div>

  <div class="field-block">
    <div class="field-head">
      <h4>{$t("settings.fields.auxTerminalShortcut")}</h4>
      <p>{$t("settings.fields.auxTerminalShortcutHint")}</p>
    </div>

    <div class="shortcut-row">
      <input
        id="aux-terminal-shortcut"
        class="number-input shortcut-input"
        type="text"
        readonly
        value={settings.terminal.auxTerminalShortcut}
        onkeydown={handleAuxShortcutKeydown}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onclick={() =>
          updateSettings({
            terminal: {
              auxTerminalShortcut: "Ctrl+`",
            },
          })}
      >
        {$t("settings.fields.auxTerminalShortcutReset")}
      </Button>
    </div>
  </div>

  <div class="field">
    <label for="aux-terminal-height-range">{$t("settings.fields.auxTerminalDefaultHeight")}</label>
    <div class="range-row range-row--wide">
      <input
        id="aux-terminal-height-range"
        class="range"
        type="range"
        min="18"
        max="70"
        step="1"
        value={settings.terminal.auxTerminalDefaultHeight}
        oninput={(event) =>
          updateSettings({
            terminal: {
              auxTerminalDefaultHeight: clampAuxTerminalHeight(
                Number((event.target as HTMLInputElement).value),
              ),
            },
          })}
      />
      <div class="scale-control">
        <div class="scale-input-shell">
          <input
            class="number-input scale-input"
            type="number"
            min="18"
            max="70"
            step="1"
            value={settings.terminal.auxTerminalDefaultHeight}
            oninput={(event) =>
              updateSettings({
                terminal: {
                  auxTerminalDefaultHeight: clampAuxTerminalHeight(
                    Number((event.target as HTMLInputElement).value),
                  ),
                },
              })}
          />
          <span class="scale-suffix">%</span>
        </div>
      </div>
    </div>
    <p class="field-message">{$t("settings.fields.auxTerminalDefaultHeightHint")}</p>
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

<style>
  .toggle-row {
    display: flex;
    align-items: flex-start;
    gap: var(--ui-space-3);
    color: var(--ui-text);
    cursor: pointer;
  }

  .toggle-input {
    margin: 0;
    margin-top: calc(var(--ui-scale) * 2px);
    inline-size: calc(16px * var(--ui-scale));
    block-size: calc(16px * var(--ui-scale));
    accent-color: var(--ui-accent);
    flex: 0 0 auto;
  }

  .toggle-copy {
    line-height: 1.45;
  }

  .shortcut-row {
    display: flex;
    gap: var(--ui-space-2);
    align-items: center;
  }

  .shortcut-input {
    flex: 1;
    cursor: pointer;
  }

  .shortcut-input:focus {
    outline: none;
  }

  .scale-control {
    display: flex;
    align-items: center;
  }

  .scale-input-shell {
    position: relative;
    min-width: calc(96px * var(--ui-scale));
  }

  .scale-input {
    width: 100%;
    padding-right: calc(28px * var(--ui-scale));
  }

  .scale-suffix {
    position: absolute;
    right: calc(10px * var(--ui-scale));
    top: 50%;
    transform: translateY(-50%);
    font-size: var(--ui-font-size-sm);
    color: var(--ui-text-muted);
    pointer-events: none;
  }
</style>
