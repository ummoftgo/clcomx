<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  type Variant = "primary" | "secondary" | "ghost" | "danger";
  type Size = "sm" | "md" | "lg";

  interface Props extends HTMLButtonAttributes {
    variant?: Variant;
    size?: Size;
    busy?: boolean;
    block?: boolean;
    children?: Snippet;
  }

  let {
    variant = "secondary",
    size = "md",
    busy = false,
    block = false,
    children,
    class: className = "",
    disabled = false,
    type = "button",
    ...rest
  }: Props = $props();

  const classes = $derived([
    "ui-button",
    `ui-button--${variant}`,
    `ui-button--${size}`,
    block ? "ui-button--block" : "",
    busy ? "is-busy" : "",
    className,
  ].filter(Boolean).join(" "));
</script>

<button
  {...rest}
  class={classes}
  type={type}
  disabled={disabled || busy}
  aria-busy={busy}
>
  {@render children?.()}
</button>

<style>
  .ui-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border: 1px solid var(--ui-border-subtle, var(--tab-border, #45475a));
    border-radius: var(--ui-radius-md);
    background: var(--ui-bg-elevated, var(--tab-active-bg, #313244));
    color: var(--ui-text-primary, var(--tab-text, #cdd6f4));
    font: inherit;
    font-size: var(--ui-font-size-base);
    line-height: 1;
    cursor: pointer;
    padding: 0 var(--ui-space-4);
    min-height: calc(38px * var(--ui-scale));
    transition:
      background-color 140ms ease,
      border-color 140ms ease,
      color 140ms ease,
      transform 140ms ease,
      opacity 140ms ease;
  }

  .ui-button:hover:not(:disabled) {
    border-color: var(--ui-border-strong, var(--tab-border, #57607a));
    background: color-mix(in srgb, var(--ui-bg-elevated, #313244) 88%, var(--ui-accent-soft, rgba(137, 180, 250, 0.12)));
  }

  .ui-button:active:not(:disabled) {
    transform: translateY(1px);
  }

  .ui-button:focus-visible {
    outline: 2px solid var(--ui-focus-ring, var(--ui-accent-soft, rgba(137, 180, 250, 0.22)));
    outline-offset: 2px;
  }

  .ui-button:disabled {
    cursor: default;
    opacity: 0.58;
  }

  .ui-button--sm {
    min-height: calc(32px * var(--ui-scale));
    padding: 0 var(--ui-space-3);
    font-size: var(--ui-font-size-sm);
  }

  .ui-button--lg {
    min-height: calc(44px * var(--ui-scale));
    padding: 0 var(--ui-space-4);
    font-size: var(--ui-font-size-base);
  }

  .ui-button--block {
    width: 100%;
  }

  .ui-button--primary {
    border-color: color-mix(in srgb, var(--ui-accent, #89b4fa) 72%, white);
    background: var(--ui-accent, #89b4fa);
    color: var(--ui-accent-text, #0f172a);
  }

  .ui-button--primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ui-accent, #89b4fa) 92%, white);
  }

  .ui-button--ghost {
    background: transparent;
  }

  .ui-button--danger {
    border-color: color-mix(in srgb, var(--ui-danger, #ef4444) 72%, white);
    background: var(--ui-danger-soft, rgba(239, 68, 68, 0.14));
    color: var(--ui-danger, #ef4444);
  }
</style>
