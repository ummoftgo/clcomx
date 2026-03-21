<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import { getSettings, updateSettings } from "../../../stores/settings.svelte";
  import { applyTabHistoryLimit } from "../../../stores/tab-history.svelte";
  import { TEST_IDS } from "../../../testids";

  const settings = getSettings();

  function clampTabHistoryLimit(value: number) {
    if (!Number.isFinite(value)) return 10;
    return Math.min(999, Math.max(1, Math.trunc(value)));
  }

  function handleTabHistoryLimitInput(event: Event) {
    const value = clampTabHistoryLimit(Number((event.target as HTMLInputElement).value));
    updateSettings({ history: { tabLimit: value } });
    void applyTabHistoryLimit(value);
  }
</script>

<div class="settings-fields">
  <div class="field">
    <label for="tab-history-limit">{$t("settings.fields.tabHistoryLimit")}</label>
    <input
      id="tab-history-limit"
      data-testid={TEST_IDS.settingsHistoryTabLimitInput}
      class="number-input number-wide"
      type="number"
      min="1"
      max="999"
      value={settings.history.tabLimit}
      oninput={handleTabHistoryLimitInput}
    />
    <p class="field-message">{$t("settings.fields.tabHistoryLimitHint")}</p>
  </div>
</div>
