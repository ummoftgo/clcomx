<script lang="ts">
  import type { Snippet } from "svelte";
  import { _ as t } from "svelte-i18n";
  import Button from "../ui/components/Button.svelte";

  interface Props {
    visible: boolean;
    heightPercent: number;
    title: string;
    currentPath: string;
    pathLabel: string;
    outputTestId?: string;
    resizable?: boolean;
    onResizeStart?: (event: PointerEvent) => void;
    onClose?: () => void;
    onOutputElementChange?: (element: HTMLDivElement | null) => void;
    body?: Snippet;
    overlay?: Snippet;
  }

  let {
    visible,
    heightPercent,
    title,
    currentPath,
    pathLabel,
    outputTestId,
    resizable = false,
    onResizeStart,
    onClose,
    onOutputElementChange,
    body,
    overlay,
  }: Props = $props();

  let outputEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    onOutputElementChange?.(outputEl);
  });
</script>

<div
  class="aux-panel"
  class:aux-panel--hidden={!visible}
  style:height={`${heightPercent}%`}
  aria-hidden={!visible}
>
  <div class="aux-surface">
    {#if resizable}
      <button
        type="button"
        class="aux-resize-handle"
        tabindex="-1"
        aria-label={$t("terminal.aux.resizeHint")}
        title={$t("terminal.aux.resizeHint")}
        onpointerdown={onResizeStart}
      ></button>
    {/if}

    <div class="aux-header">
      <div class="aux-copy">
        <span class="aux-title">{title}</span>
        <span class="aux-path">{pathLabel}: {currentPath}</span>
      </div>

      {#if onClose}
        <Button
          size="sm"
          variant="ghost"
          onclick={(event) => {
            (event.currentTarget as HTMLButtonElement | null)?.blur();
            onClose();
          }}
        >
          {$t("common.actions.close")}
        </Button>
      {/if}
    </div>

    <div class="aux-output" data-testid={outputTestId} bind:this={outputEl}>
      {@render body?.()}
    </div>
  </div>

  {@render overlay?.()}
</div>

<style>
  .aux-panel {
    position: absolute;
    left: var(--ui-space-1);
    right: var(--ui-space-1);
    bottom: calc(var(--assist-panel-height, 0px) + var(--ui-space-1));
    overflow: hidden;
    min-height: 0;
    max-height: calc(100% - var(--assist-panel-height, 0px) - calc(12px * var(--ui-scale)));
    border: 1px solid color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 76%, transparent);
    border-radius: var(--ui-radius-lg);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 90%, transparent), transparent),
      color-mix(in srgb, var(--ui-bg-app, var(--app-bg)) 88%, transparent);
    box-shadow: 0 -12px 28px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.22);
    transition: border-color 160ms ease, opacity 160ms ease, transform 160ms ease, visibility 0s linear;
    z-index: 15;
  }

  .aux-panel.aux-panel--hidden {
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
    transform: translateY(calc(100% + var(--ui-space-2)));
  }

  .aux-surface {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .aux-resize-handle {
    flex: 0 0 auto;
    height: calc(14px * var(--ui-scale));
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    cursor: ns-resize;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .aux-resize-handle::before {
    content: "";
    width: calc(56px * var(--ui-scale));
    height: calc(4px * var(--ui-scale));
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 74%, transparent);
  }

  .aux-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
    padding: 0 var(--ui-space-4) var(--ui-space-3);
  }

  .aux-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
  }

  .aux-title {
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-secondary, var(--tab-text));
  }

  .aux-path {
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    color: var(--ui-text-muted, var(--tab-text));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .aux-output {
    flex: 1;
    min-height: 0;
    position: relative;
    padding: 0 var(--ui-space-3) var(--ui-space-3);
  }
</style>
