<script lang="ts">
  let {
    launcherOpen = false,
    settingsOpen = false,
    onOpenCloseDialog,
    onOpenRename,
    onResetOverlays,
    onToggleLauncher,
    onToggleSettings,
    onToggleVisibility,
  } = $props<{
    launcherOpen?: boolean;
    settingsOpen?: boolean;
    onOpenCloseDialog?: () => void;
    onOpenRename?: () => void;
    onResetOverlays?: () => void;
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
  <button type="button" data-testid="preview-reset-overlays" onclick={() => { onResetOverlays?.(); }}>
    Reset Overlays
  </button>
  <button type="button" data-testid="preview-open-rename" onclick={() => { onOpenRename?.(); }}>
    Preview Rename
  </button>
  <button type="button" data-testid="preview-open-close-dialog" onclick={() => { onOpenCloseDialog?.(); }}>
    Preview Close
  </button>
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
