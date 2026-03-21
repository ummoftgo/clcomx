<script lang="ts">
  import { tick } from "svelte";
  import type { ContextMenuItem } from "../context-menu";
  import { TEST_IDS, contextMenuItemTestId } from "../../testids";

  interface Props {
    visible: boolean;
    x: number;
    y: number;
    items: ContextMenuItem[];
    onSelect: (item: Extract<ContextMenuItem, { kind: "item" }>) => void;
    onClose: () => void;
  }

  let { visible, x, y, items, onSelect, onClose }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  let resolvedX = $state(0);
  let resolvedY = $state(0);

  function clampPosition() {
    if (!menuEl) return;

    const rect = menuEl.getBoundingClientRect();
    const maxX = Math.max(12, window.innerWidth - rect.width - 12);
    const maxY = Math.max(12, window.innerHeight - rect.height - 12);
    resolvedX = Math.min(maxX, Math.max(12, resolvedX));
    resolvedY = Math.min(maxY, Math.max(12, resolvedY));
  }

  function handleSelect(item: Extract<ContextMenuItem, { kind: "item" }>) {
    if (item.disabled) return;
    onSelect(item);
    onClose();
  }

  $effect(() => {
    if (!visible) return;
    resolvedX = x;
    resolvedY = y;
    tick().then(() => {
      requestAnimationFrame(clampPosition);
    });
  });

  $effect(() => {
    if (!visible) return;
    requestAnimationFrame(clampPosition);
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (visible && event.key === "Escape") {
      onClose();
    }
  }}
  onresize={() => {
    if (visible) {
      requestAnimationFrame(clampPosition);
    }
  }}
/>

{#if visible}
  <div class="context-menu-backdrop" role="presentation" onpointerdown={onClose}></div>
  <div
    class="context-menu"
    data-testid={TEST_IDS.contextMenu}
    role="menu"
    aria-label="Context menu"
    tabindex="-1"
    bind:this={menuEl}
    style={`left:${resolvedX}px;top:${resolvedY}px;`}
    onpointerdown={(event) => event.stopPropagation()}
  >
    {#each items as item (item.id)}
      {#if item.kind === "separator"}
        <div class="separator"></div>
      {:else if item.kind === "header"}
        <div class="header">{item.label}</div>
      {:else}
        <button
          type="button"
          data-testid={contextMenuItemTestId(item.id)}
          class:danger={item.danger}
          disabled={item.disabled}
          onclick={() => handleSelect(item)}
        >
          {item.label}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .context-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2098;
    background: transparent;
    -webkit-app-region: no-drag;
  }

  .context-menu {
    position: fixed;
    z-index: 2099;
    display: flex;
    flex-direction: column;
    width: calc(238px * var(--ui-scale));
    padding: var(--ui-space-2);
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle, var(--tab-border, #45475a)) 76%, transparent);
    border-radius: var(--ui-radius-lg);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface, var(--tab-bg, #1e1e2e)) 92%, #020617), var(--ui-bg-surface, var(--tab-bg, #1e1e2e))),
      var(--ui-bg-surface, var(--tab-bg, #1e1e2e));
    box-shadow: 0 20px 44px rgba(2, 6, 23, 0.4);
    -webkit-app-region: no-drag;
  }

  .context-menu button,
  .header {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: calc(34px * var(--ui-scale));
    padding: 0 var(--ui-space-3);
    border: none;
    border-radius: var(--ui-radius-md);
    background: transparent;
    color: var(--ui-text-primary, var(--tab-text, #cdd6f4));
    font-size: var(--ui-font-size-base);
    text-align: left;
  }

  .context-menu button {
    cursor: pointer;
  }

  .context-menu button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ui-bg-elevated, var(--tab-active-bg, #313244)) 84%, transparent);
  }

  .context-menu button:disabled {
    opacity: 0.48;
    cursor: default;
  }

  .context-menu button.danger {
    color: var(--ui-danger, #ef4444);
  }

  .header {
    min-height: calc(24px * var(--ui-scale));
    margin-top: 2px;
    margin-bottom: 4px;
    font-size: var(--ui-font-size-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--ui-text-muted, var(--tab-text, #94a3b8)) 94%, transparent);
  }

  .separator {
    height: 1px;
    margin: var(--ui-space-2) var(--ui-space-1);
    background: color-mix(in srgb, var(--ui-border-subtle, var(--tab-border, #45475a)) 72%, transparent);
  }
</style>
