<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import type { AgentWorkspaceSessionState } from "../stores/agent-workspace.svelte";
  import { TEST_IDS } from "../testids";

  interface Props {
    state: AgentWorkspaceSessionState | null;
  }

  let { state }: Props = $props();

  const selectedNode = $derived(
    state?.nodes.find((node) => node.id === state.selectedNodeId) ?? null,
  );
  const selectedEvents = $derived(
    state && selectedNode ? state.activityByNodeId[selectedNode.id] ?? [] : [],
  );

  function formatTimestamp(timestamp: string) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }
</script>

{#if state && selectedNode}
  <aside class="activity-shell" data-testid={TEST_IDS.activityTimeline}>
    <header class="activity-header">
      <div class="activity-heading">
        <span class="activity-kicker">{$t("agentWorkspace.timeline.eyebrow")}</span>
        <strong>{selectedNode.label}</strong>
      </div>
      <div class="activity-meta">
        <span class="activity-status activity-status--{selectedNode.status}">
          {$t(`agentWorkspace.status.${selectedNode.status}`)}
        </span>
        <span class="activity-summary">{selectedNode.summary}</span>
      </div>
    </header>

    <section class="activity-section activity-section--transcript">
      <div class="activity-section-title">{$t("agentWorkspace.timeline.title")}</div>
      {#if selectedEvents.length > 0}
        <div class="activity-event-list">
          {#each selectedEvents as event (event.id)}
            <article class="activity-event">
              <div class="activity-event-title">
                <strong>{$t(`agentWorkspace.eventKind.${event.kind}`)}</strong>
                <time>{formatTimestamp(event.timestamp)}</time>
              </div>
              <pre>{event.text}</pre>
            </article>
          {/each}
        </div>
      {:else}
        <div class="activity-empty">
          <p>{$t("agentWorkspace.timeline.empty")}</p>
          <span>{$t("agentWorkspace.timeline.emptyHint")}</span>
        </div>
      {/if}
    </section>
  </aside>
{:else}
  <aside class="activity-shell activity-shell--empty" data-testid={TEST_IDS.activityTimeline}>
    <div class="activity-empty">
      <p>{$t("agentWorkspace.timeline.empty")}</p>
      <span>{$t("agentWorkspace.timeline.emptyHint")}</span>
    </div>
  </aside>
{/if}

<style>
  .activity-shell {
    width: 340px;
    min-width: 300px;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 12px;
    padding: 16px;
    border-left: 1px solid color-mix(in srgb, var(--ui-border-subtle) 92%, transparent);
    background:
      radial-gradient(circle at top right, rgba(var(--ui-shadow-rgb), 0.1), transparent 42%),
      color-mix(in srgb, var(--ui-bg-surface) 90%, transparent);
  }

  .activity-shell--empty {
    place-items: center;
  }

  .activity-header {
    display: grid;
    gap: 8px;
  }

  .activity-heading {
    display: grid;
    gap: 3px;
  }

  .activity-kicker {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ui-text-muted);
  }

  .activity-heading strong {
    font-size: 16px;
    color: var(--ui-text-primary);
  }

  .activity-meta {
    display: grid;
    gap: 6px;
  }

  .activity-status {
    justify-self: start;
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle) 92%, transparent);
    background: color-mix(in srgb, var(--ui-bg-elevated) 92%, transparent);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ui-text-primary);
  }

  .activity-status--running {
    color: #166534;
    background: rgba(104, 211, 145, 0.18);
    border-color: rgba(104, 211, 145, 0.36);
  }

  .activity-status--idle {
    color: #92400e;
    background: rgba(246, 193, 119, 0.18);
    border-color: rgba(246, 193, 119, 0.38);
  }

  .activity-status--done {
    color: #334155;
    background: rgba(148, 163, 184, 0.18);
    border-color: rgba(148, 163, 184, 0.34);
  }

  .activity-status--error {
    color: #9f1239;
    background: rgba(251, 113, 133, 0.18);
    border-color: rgba(251, 113, 133, 0.34);
  }

  .activity-summary {
    font-size: 12px;
    color: var(--ui-text-secondary);
  }

  .activity-section {
    display: grid;
    gap: 8px;
    min-height: 0;
  }

  .activity-section--transcript {
    grid-template-rows: auto minmax(0, 1fr);
  }

  .activity-section-title {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-muted);
  }

  .activity-event-list {
    display: grid;
    align-content: start;
    gap: 8px;
    min-height: 0;
    overflow: auto;
    padding-right: 4px;
  }

  .activity-event {
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle) 92%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent);
  }

  .activity-event-title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 6px;
  }

  .activity-event-title strong {
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ui-text-primary);
  }

  .activity-event-title time {
    font-size: 11px;
    color: var(--ui-text-muted);
  }

  .activity-event pre {
    margin: 0;
    color: var(--ui-text-primary);
    font-family: var(--ui-mono-font, "JetBrains Mono", monospace);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .activity-empty {
    display: grid;
    place-items: center;
    min-height: 120px;
    padding: 16px;
    border: 1px dashed color-mix(in srgb, var(--ui-border-subtle) 92%, transparent);
    border-radius: 14px;
    color: var(--ui-text-muted);
    font-size: 12px;
    text-align: center;
  }

  .activity-empty p,
  .activity-empty span {
    margin: 0;
  }

  .activity-empty span {
    font-size: 11px;
  }

  @media (max-width: 1180px) {
    .activity-shell {
      width: 300px;
      min-width: 280px;
    }
  }
</style>
