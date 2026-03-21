<script lang="ts">
  import { getAgentDefinition, type AgentId } from "../agents";

  interface Props {
    agentId: AgentId;
    size?: "sm" | "md";
    title?: string;
  }

  let {
    agentId,
    size = "sm",
    title,
  }: Props = $props();

  const agent = $derived(getAgentDefinition(agentId));
  const iconSrc = $derived(
    agent.icon.monochrome ?? agent.icon.dark ?? agent.icon.light ?? null,
  );
</script>

{#if iconSrc}
  <span class={`agent-icon agent-icon--${size}`} title={title ?? agent.label} aria-hidden="true">
    <img src={iconSrc} alt="" />
  </span>
{:else}
  <span class={`agent-icon agent-icon--${size}`} title={title ?? agent.label} aria-hidden="true">
    {agent.icon.fallbackText}
  </span>
{/if}

<style>
  .agent-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-accent, var(--tab-active-bg)) 20%, transparent);
    color: var(--ui-text-primary);
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle) 75%, transparent);
    font-weight: 700;
    letter-spacing: 0.01em;
    flex: 0 0 auto;
    overflow: hidden;
  }

  .agent-icon--sm {
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    font-size: 10px;
  }

  .agent-icon--md {
    min-width: 24px;
    height: 24px;
    padding: 0 7px;
    font-size: 11px;
  }

  .agent-icon img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
