<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLElement> {
    title?: string;
    description?: string;
    compact?: boolean;
    children?: Snippet;
  }

  let {
    title = "",
    description = "",
    compact = false,
    children,
    class: className = "",
    ...rest
  }: Props = $props();

  const classes = $derived([
    "ui-section",
    compact ? "ui-section--compact" : "",
    className,
  ].filter(Boolean).join(" "));
</script>

<section {...rest} class={classes}>
  {#if title || description}
    <header class="ui-section__header">
      {#if title}<h3 class="ui-section__title">{title}</h3>{/if}
      {#if description}<p class="ui-section__description">{description}</p>{/if}
    </header>
  {/if}
  <div class="ui-section__body">
    {@render children?.()}
  </div>
</section>

<style>
  .ui-section {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-3);
  }

  .ui-section--compact {
    gap: var(--ui-space-2);
  }

  .ui-section__header {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
  }

  .ui-section__title {
    margin: 0;
    font-size: var(--ui-font-size-base);
    font-weight: 700;
    color: var(--ui-text-primary, var(--tab-text, #cdd6f4));
  }

  .ui-section__description {
    margin: 0;
    font-size: var(--ui-font-size-sm);
    line-height: 1.5;
    color: var(--ui-text-muted, var(--tab-text, #94a3b8));
  }

  .ui-section__body {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-3);
  }
</style>
