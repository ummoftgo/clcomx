<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import FontPicker from "../../FontPicker.svelte";
  import { getSettings, updateSettings } from "../../../stores/settings.svelte";

  const settings = getSettings();

  // null = 상속(FE-25 후속 규약). UI에서 빈 문자열 입력은 null로 접어 저장한다.
  function foldInherit(value: string): string | null {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }

  function clampAgentFontSize(value: number): number {
    if (!Number.isFinite(value)) return 14;
    return Math.min(24, Math.max(10, Math.trunc(value)));
  }

  function setAgentFontSize(value: number) {
    updateSettings({ agentRuntime: { fontSize: clampAgentFontSize(value) } });
  }

  function setFontSizeInherit(inherit: boolean) {
    updateSettings({ agentRuntime: { fontSize: inherit ? null : 14 } });
  }
</script>

<div class="settings-fields">
  <div class="field-stack">
    <FontPicker
      label={$t("settings.fields.agentRuntimeFont")}
      value={settings.agentRuntime.fontFamily ?? ""}
      placeholder={$t("settings.placeholders.agentRuntimeInheritUiFont")}
      onChange={(value) => updateSettings({ agentRuntime: { fontFamily: foldInherit(value) } })}
    />
    <FontPicker
      label={$t("settings.fields.agentRuntimeCodeFont")}
      value={settings.agentRuntime.codeFontFamily ?? ""}
      placeholder={$t("settings.placeholders.agentRuntimeInheritMonoFont")}
      onChange={(value) =>
        updateSettings({ agentRuntime: { codeFontFamily: foldInherit(value) } })}
    />
  </div>

  <div class="field">
    <label class="checkbox-row" for="agent-font-size-inherit">
      <input
        id="agent-font-size-inherit"
        type="checkbox"
        checked={settings.agentRuntime.fontSize === null}
        onchange={(event) =>
          setFontSizeInherit((event.target as HTMLInputElement).checked)}
      />
      <span>{$t("settings.fields.agentRuntimeFontSizeInherit")}</span>
    </label>
    {#if settings.agentRuntime.fontSize !== null}
      <div class="range-row range-row--wide">
        <input
          id="agent-font-size-range"
          class="range"
          type="range"
          min="10"
          max="24"
          step="1"
          value={settings.agentRuntime.fontSize}
          oninput={(event) => setAgentFontSize(Number((event.target as HTMLInputElement).value))}
          aria-label={$t("settings.fields.agentRuntimeFontSize")}
        />
        <div class="scale-control">
          <div class="scale-input-shell">
            <input
              class="number-input scale-input"
              type="number"
              min="10"
              max="24"
              step="1"
              value={settings.agentRuntime.fontSize}
              oninput={(event) => setAgentFontSize(Number((event.target as HTMLInputElement).value))}
            />
            <span class="scale-suffix">px</span>
          </div>
        </div>
      </div>
    {/if}
    <p class="field-message">{$t("settings.fields.agentRuntimeFontSizeHint")}</p>
  </div>

  <div class="field">
    <label class="checkbox-row" for="agent-claude-subscription-auth">
      <input
        id="agent-claude-subscription-auth"
        type="checkbox"
        checked={settings.agentRuntime.claudeAllowSubscriptionAuth}
        onchange={(event) =>
          updateSettings({
            agentRuntime: {
              claudeAllowSubscriptionAuth: (event.target as HTMLInputElement).checked,
            },
          })}
      />
      <span>{$t("settings.fields.agentRuntimeClaudeSubscriptionAuth")}</span>
    </label>
    <p class="field-message">{$t("settings.fields.agentRuntimeClaudeSubscriptionAuthHint")}</p>
  </div>
</div>

<style>
  .checkbox-row {
    display: inline-flex;
    align-items: center;
    gap: var(--ui-space-2);
    cursor: pointer;
  }

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
