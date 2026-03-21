<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  interface Props extends HTMLButtonAttributes {
    label: string;
    active?: boolean;
    danger?: boolean;
    children?: Snippet;
  }

  let {
    label,
    active = false,
    danger = false,
    children,
    class: className = "",
    type = "button",
    ...rest
  }: Props = $props();

  const classes = $derived([
    "ui-icon-button",
    active ? "is-active" : "",
    danger ? "is-danger" : "",
    className,
  ].filter(Boolean).join(" "));
</script>

<button
  {...rest}
  class={classes}
  type={type}
  aria-label={label}
  title={label}
>
  {@render children?.()}
</button>

<style>
  .ui-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: calc(34px * var(--ui-scale));
    height: calc(34px * var(--ui-scale));
    border: 1px solid var(--ui-border-subtle, var(--tab-border, #45475a));
    border-radius: var(--ui-radius-md);
    background: var(--ui-bg-elevated, var(--tab-active-bg, #313244));
    color: var(--ui-text-primary, var(--tab-text, #cdd6f4));
    cursor: pointer;
    transition:
      background-color 140ms ease,
      border-color 140ms ease,
      color 140ms ease,
      transform 140ms ease;
  }

  .ui-icon-button:hover:not(:disabled) {
    border-color: var(--ui-border-strong, var(--tab-border, #57607a));
  }

  .ui-icon-button:active:not(:disabled) {
    transform: translateY(1px);
  }

  .ui-icon-button:focus-visible {
    outline: 2px solid var(--ui-focus-ring, var(--ui-accent-soft, rgba(137, 180, 250, 0.22)));
    outline-offset: 2px;
  }

  .ui-icon-button.is-active {
    background: var(--ui-accent-soft, rgba(137, 180, 250, 0.16));
    border-color: var(--ui-accent, #89b4fa);
  }

  .ui-icon-button.is-danger {
    color: var(--ui-danger, #ef4444);
  }

  .ui-icon-button:disabled {
    cursor: default;
    opacity: 0.55;
  }
</style>
