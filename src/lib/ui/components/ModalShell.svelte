<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  type Size = "sm" | "md" | "lg" | "xl";

  interface Props extends HTMLAttributes<HTMLDivElement> {
    open: boolean;
    size?: Size;
    dismissible?: boolean;
    onClose: () => void;
    children?: Snippet;
  }

  let {
    open,
    size = "md",
    dismissible = true,
    onClose,
    children,
    class: className = "",
    ...rest
  }: Props = $props();

  function handleBackdropClick() {
    if (dismissible) onClose();
  }

  function handlePanelClick(event: Event) {
    event.stopPropagation();
  }

  const classes = $derived([
    "ui-modal-shell",
    `ui-modal-shell--${size}`,
    className,
  ].filter(Boolean).join(" "));
</script>

{#if open}
  <div class="ui-modal-shell__backdrop" onclick={handleBackdropClick} {...rest}>
    <div
      class={classes}
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={handlePanelClick}
      onkeydown={handlePanelClick}
    >
      {@render children?.()}
    </div>
  </div>
{/if}

<style>
  .ui-modal-shell__backdrop {
    position: fixed;
    inset: 0;
    z-index: 220;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--ui-space-4);
    background: var(--ui-bg-overlay, rgba(15, 23, 42, 0.48));
    backdrop-filter: blur(12px);
  }

  .ui-modal-shell {
    width: min(100%, 560px);
    max-height: min(100%, calc(100vh - 32px));
    overflow: auto;
    border: 1px solid var(--ui-border-subtle, var(--tab-border, #45475a));
    border-radius: var(--ui-radius-xl);
    background: var(--ui-bg-elevated, var(--tab-active-bg, #313244));
    color: var(--ui-text-primary, var(--tab-text, #cdd6f4));
    box-shadow: 0 18px 54px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.32);
  }

  .ui-modal-shell--sm {
    width: min(100%, 440px);
  }

  .ui-modal-shell--md {
    width: min(100%, 560px);
  }

  .ui-modal-shell--lg {
    width: min(100%, 720px);
  }

  .ui-modal-shell--xl {
    width: min(100%, 920px);
  }
</style>
