<script lang="ts">
  let {
    launcherOpen = false,
    settingsOpen = false,
    onToggleLauncher,
    onToggleSettings,
    onToggleVisibility,
  } = $props<{
    launcherOpen?: boolean;
    settingsOpen?: boolean;
    onToggleLauncher?: () => void;
    onToggleSettings?: () => void;
    onToggleVisibility?: () => void;
  }>();
</script>

<div
  data-testid="preview-control-panel-stub"
  data-launcher-open={launcherOpen ? "true" : "false"}
  data-settings-open={settingsOpen ? "true" : "false"}
>
  <button type="button" data-testid="preview-toggle-launcher" onclick={() => { onToggleLauncher?.(); }}>
    Toggle Launcher
  </button>
  <button type="button" data-testid="preview-toggle-settings" onclick={() => { onToggleSettings?.(); }}>
    Toggle Settings
  </button>
  <button type="button" data-testid="preview-toggle-visibility" onclick={() => { onToggleVisibility?.(); }}>
    Toggle Visibility
  </button>
</div>
