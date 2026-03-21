<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  type Tone = "surface" | "elevated" | "ghost";
  type As = "div" | "section" | "article" | "aside";

  interface Props extends HTMLAttributes<HTMLElement> {
    as?: As;
    tone?: Tone;
    compact?: boolean;
    children?: Snippet;
  }

  let {
    as = "div",
    tone = "surface",
    compact = false,
    children,
    class: className = "",
    ...rest
  }: Props = $props();

  const classes = $derived([
    "ui-panel",
    `ui-panel--${tone}`,
    compact ? "ui-panel--compact" : "",
    className,
  ].filter(Boolean).join(" "));
</script>

<svelte:element this={as} {...rest} class={classes}>
  {@render children?.()}
</svelte:element>

<style>
  .ui-panel {
    border: 1px solid var(--ui-border-subtle, var(--tab-border, #45475a));
    border-radius: var(--ui-radius-lg);
    background: var(--ui-bg-surface, var(--tab-bg, #1e1e2e));
    color: var(--ui-text-primary, var(--tab-text, #cdd6f4));
    box-shadow: 0 10px 28px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.18);
  }

  .ui-panel--elevated {
    background: var(--ui-bg-elevated, var(--tab-active-bg, #313244));
  }

  .ui-panel--ghost {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
  }

  .ui-panel--compact {
    border-radius: var(--ui-radius-md);
  }
</style>
