<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLDivElement> {
    label: string;
    for?: string;
    hint?: string;
    error?: string;
    required?: boolean;
    children?: Snippet;
  }

  let {
    label,
    for: forId,
    hint = "",
    error = "",
    required = false,
    children,
    class: className = "",
    ...rest
  }: Props = $props();

  const classes = $derived(["ui-field", className].filter(Boolean).join(" "));
</script>

<div {...rest} class={classes}>
  <label class="ui-field__label" for={forId}>
    {label}
    {#if required}<span class="ui-field__required">*</span>{/if}
  </label>
  <div class="ui-field__control">
    {@render children?.()}
  </div>
  {#if hint}
    <p class="ui-field__hint">{hint}</p>
  {/if}
  {#if error}
    <p class="ui-field__error">{error}</p>
  {/if}
</div>

<style>
  .ui-field {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-2);
  }

  .ui-field__label {
    display: inline-flex;
    align-items: center;
    gap: var(--ui-space-2);
    font-size: var(--ui-font-size-sm);
    font-weight: 600;
    color: var(--ui-text-secondary, var(--tab-text, #cdd6f4));
  }

  .ui-field__required {
    color: var(--ui-danger, #ef4444);
  }

  .ui-field__control {
    min-width: 0;
  }

  .ui-field__hint,
  .ui-field__error {
    margin: 0;
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
  }

  .ui-field__hint {
    color: var(--ui-text-muted, var(--tab-text, #94a3b8));
  }

  .ui-field__error {
    color: var(--ui-danger, #ef4444);
  }
</style>
