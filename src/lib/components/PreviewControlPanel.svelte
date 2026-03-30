<script lang="ts">
  import type { PreviewPresetId, PreviewPresetOption } from "../preview/runtime";
  import Button from "../ui/components/Button.svelte";

  export interface PreviewFrameOption {
    id: string;
    label: string;
  }

  interface Props {
    presetId: PreviewPresetId;
    presetOptions: readonly PreviewPresetOption[];
    frameMode: string;
    frameOptions: readonly PreviewFrameOption[];
    launcherOpen: boolean;
    settingsOpen: boolean;
    hasSessions: boolean;
    onPresetChange?: (presetId: PreviewPresetId) => void;
    onFrameModeChange?: (frameMode: string) => void;
    onToggleLauncher?: () => void;
    onToggleSettings?: () => void;
    onOpenRename?: () => void;
    onOpenCloseDialog?: () => void;
    onResetOverlays?: () => void;
    onToggleVisibility?: () => void;
  }

  let {
    presetId,
    presetOptions,
    frameMode,
    frameOptions,
    launcherOpen,
    settingsOpen,
    hasSessions,
    onPresetChange,
    onFrameModeChange,
    onToggleLauncher,
    onToggleSettings,
    onOpenRename,
    onOpenCloseDialog,
    onResetOverlays,
    onToggleVisibility,
  }: Props = $props();

  const activePreset = $derived(
    presetOptions.find((option) => option.id === presetId) ?? presetOptions[0],
  );
</script>

<aside class="preview-control-panel" aria-label="Browser preview controls">
  <div class="preview-control-panel__header">
    <div>
      <strong>Browser Preview</strong>
      <p>앱 셸은 그대로 두고 상태만 바꿔 보실 수 있습니다.</p>
    </div>
    <div class="preview-control-panel__header-actions">
      <Button size="sm" variant="ghost" onclick={() => onResetOverlays?.()}>
        Reset
      </Button>
      <Button size="sm" variant="ghost" onclick={() => onToggleVisibility?.()}>
        Hide
      </Button>
    </div>
  </div>

  <section class="preview-control-panel__section">
    <label class="preview-control-panel__label" for="preview-preset-select">Preset</label>
    <select
      id="preview-preset-select"
      class="preview-control-panel__select"
      value={presetId}
      onchange={(event) => {
        onPresetChange?.((event.currentTarget as HTMLSelectElement).value as PreviewPresetId);
      }}
    >
      {#each presetOptions as option}
        <option value={option.id}>{option.label}</option>
      {/each}
    </select>
    <p class="preview-control-panel__hint">{activePreset?.description}</p>
  </section>

  <section class="preview-control-panel__section">
    <span class="preview-control-panel__label">Frame</span>
    <div class="preview-control-panel__segmented">
      {#each frameOptions as option}
        <button
          class:active={option.id === frameMode}
          type="button"
          onclick={() => onFrameModeChange?.(option.id)}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </section>

  <section class="preview-control-panel__section">
    <span class="preview-control-panel__label">Overlays</span>
    <div class="preview-control-panel__actions">
      <Button
        size="sm"
        variant={launcherOpen ? "primary" : "secondary"}
        onclick={() => onToggleLauncher?.()}
      >
        Launcher
      </Button>
      <Button
        size="sm"
        variant={settingsOpen ? "primary" : "secondary"}
        onclick={() => onToggleSettings?.()}
      >
        Settings
      </Button>
      <Button size="sm" onclick={() => onOpenRename?.()} disabled={!hasSessions}>
        Rename Tab
      </Button>
      <Button size="sm" onclick={() => onOpenCloseDialog?.()} disabled={!hasSessions}>
        Close Dialog
      </Button>
    </div>
  </section>
</aside>

<style>
  .preview-control-panel {
    position: fixed;
    top: 16px;
    right: 18px;
    z-index: 50;
    width: min(360px, calc(100vw - 36px));
    display: grid;
    gap: 14px;
    padding: 16px;
    border: 1px solid color-mix(in srgb, var(--ui-border-strong) 84%, transparent);
    border-radius: 18px;
    background:
      linear-gradient(180deg, rgba(14, 18, 29, 0.92), rgba(10, 13, 20, 0.88)),
      color-mix(in srgb, var(--ui-bg-app) 84%, #05070d);
    color: var(--ui-text-primary);
    box-shadow:
      0 24px 48px rgba(var(--ui-shadow-rgb), 0.34),
      inset 0 1px 0 rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(20px);
  }

  .preview-control-panel__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .preview-control-panel__header-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  .preview-control-panel__header strong {
    display: block;
    font-size: 14px;
    line-height: 1.2;
    letter-spacing: 0.02em;
  }

  .preview-control-panel__header p {
    margin: 6px 0 0;
    color: var(--ui-text-muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .preview-control-panel__section {
    display: grid;
    gap: 8px;
  }

  .preview-control-panel__label {
    color: var(--ui-text-secondary);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .preview-control-panel__select {
    min-height: 38px;
    padding: 0 12px;
    border: 1px solid var(--ui-border-subtle);
    border-radius: 12px;
    background: color-mix(in srgb, var(--ui-bg-elevated) 82%, #070910);
    color: var(--ui-text-primary);
    font: inherit;
  }

  .preview-control-panel__hint {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: 12px;
    line-height: 1.45;
  }

  .preview-control-panel__segmented {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .preview-control-panel__segmented button {
    min-height: 34px;
    border: 1px solid var(--ui-border-subtle);
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-bg-elevated) 78%, transparent);
    color: var(--ui-text-secondary);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition:
      border-color 140ms ease,
      background-color 140ms ease,
      color 140ms ease,
      transform 140ms ease;
  }

  .preview-control-panel__segmented button:hover {
    border-color: var(--ui-border-strong);
    color: var(--ui-text-primary);
  }

  .preview-control-panel__segmented button:active {
    transform: translateY(1px);
  }

  .preview-control-panel__segmented button.active {
    border-color: color-mix(in srgb, var(--ui-accent) 78%, white);
    background: color-mix(in srgb, var(--ui-accent) 20%, var(--ui-bg-elevated));
    color: var(--ui-text-primary);
  }

  .preview-control-panel__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  @media (max-width: 960px) {
    .preview-control-panel {
      width: min(100vw - 24px, 320px);
      top: 12px;
      right: 12px;
      padding: 14px;
    }
  }
</style>
