<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLDivElement> {
    title: string;
    description?: string;
    children?: Snippet;
  }

  let {
    title,
    description = "",
    children,
    class: className = "",
    ...rest
  }: Props = $props();

  const classes = $derived(["ui-empty-state", className].filter(Boolean).join(" "));
</script>

<div {...rest} class={classes}>
  <div class="ui-empty-state__title">{title}</div>
  {#if description}
    <p class="ui-empty-state__description">{description}</p>
  {/if}
  <div class="ui-empty-state__actions">
    {@render children?.()}
  </div>
</div>

<style>
  .ui-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 20px;
    border: 1px dashed var(--ui-border-subtle, var(--tab-border, #45475a));
    border-radius: 14px;
    background: color-mix(in srgb, var(--ui-bg-surface, #1e1e2e) 88%, transparent);
    text-align: center;
  }

  .ui-empty-state__title {
    font-size: 14px;
    font-weight: 600;
    color: var(--ui-text-primary, var(--tab-text, #cdd6f4));
  }

  .ui-empty-state__description {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--ui-text-muted, var(--tab-text, #94a3b8));
  }

  .ui-empty-state__actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
    margin-top: 2px;
  }
</style>
