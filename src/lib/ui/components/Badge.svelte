<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  type Tone = "default" | "success" | "warning" | "danger" | "accent";

  interface Props extends HTMLAttributes<HTMLSpanElement> {
    tone?: Tone;
    children?: Snippet;
  }

  let {
    tone = "default",
    children,
    class: className = "",
    ...rest
  }: Props = $props();

  const classes = $derived(["ui-badge", `ui-badge--${tone}`, className].filter(Boolean).join(" "));
</script>

<span {...rest} class={classes}>
  {@render children?.()}
</span>

<style>
  .ui-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--ui-space-1);
    padding: var(--ui-space-1) var(--ui-space-2);
    border-radius: 999px;
    border: 1px solid var(--ui-border-subtle, var(--tab-border, #45475a));
    font-size: var(--ui-font-size-xs);
    font-weight: 600;
    line-height: 1;
    color: var(--ui-text-primary, var(--tab-text, #cdd6f4));
    background: var(--ui-bg-elevated, var(--tab-active-bg, #313244));
  }

  .ui-badge--accent {
    color: var(--ui-accent-text, #0f172a);
    background: var(--ui-accent-soft, rgba(137, 180, 250, 0.16));
    border-color: var(--ui-accent, #89b4fa);
  }

  .ui-badge--success {
    color: var(--ui-success, #22c55e);
    background: color-mix(in srgb, var(--ui-success, #22c55e) 14%, transparent);
  }

  .ui-badge--warning {
    color: var(--ui-warning, #f59e0b);
    background: color-mix(in srgb, var(--ui-warning, #f59e0b) 14%, transparent);
  }

  .ui-badge--danger {
    color: var(--ui-danger, #ef4444);
    background: color-mix(in srgb, var(--ui-danger, #ef4444) 14%, transparent);
  }
</style>
