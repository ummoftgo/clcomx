<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import AgentIcon from "./AgentIcon.svelte";
  import type { AgentNode } from "../types";
  import type { AgentWorkspaceSessionState } from "../stores/agent-workspace.svelte";
  import { TEST_IDS, agentTreeNodeTestId } from "../testids";

  interface Props {
    state: AgentWorkspaceSessionState | null;
    onSelect?: (agentNodeId: string) => void;
  }

  let { state, onSelect = () => {} }: Props = $props();

  const rootNode = $derived(
    state?.nodes.find((node) => node.id === state.rootNodeId) ?? null,
  );
  const childNodes = $derived(
    state?.nodes.filter((node) => node.parentId === state?.rootNodeId) ?? [],
  );

  function handleSelect(node: AgentNode) {
    onSelect(node.id);
  }
</script>

{#if state && rootNode && childNodes.length > 0}
  <aside class="agent-tree-shell" data-testid={TEST_IDS.agentTree}>
    <div class="agent-tree-header">
      <span class="agent-tree-kicker">{$t("agentWorkspace.tree.eyebrow")}</span>
      <strong>{$t("agentWorkspace.tree.title")}</strong>
    </div>

    <div class="agent-tree-list" role="tree">
      <button
        type="button"
        class="agent-node agent-node--root"
        class:agent-node--selected={state.selectedNodeId === rootNode.id}
        data-testid={agentTreeNodeTestId(rootNode.id)}
        onclick={() => handleSelect(rootNode)}
      >
        <span class="agent-node-status agent-node-status--{rootNode.status}"></span>
        <AgentIcon agentId={rootNode.agentId} size="sm" />
        <span class="agent-node-body">
          <span class="agent-node-label">{rootNode.label}</span>
          <span class="agent-node-summary">{rootNode.summary}</span>
        </span>
      </button>

      <div class="agent-tree-branch">
        {#each childNodes as node (node.id)}
          <button
            type="button"
            class="agent-node agent-node--child"
            class:agent-node--selected={state.selectedNodeId === node.id}
            data-testid={agentTreeNodeTestId(node.id)}
            onclick={() => handleSelect(node)}
          >
            <span class="agent-node-branch-line" aria-hidden="true"></span>
            <span class="agent-node-status agent-node-status--{node.status}"></span>
            <AgentIcon agentId={node.agentId} size="sm" />
            <span class="agent-node-body">
              <span class="agent-node-label">{node.label}</span>
              <span class="agent-node-summary">{node.summary}</span>
            </span>
          </button>
        {/each}
      </div>
    </div>
  </aside>
{/if}

<style>
  .agent-tree-shell {
    width: 176px;
    min-width: 176px;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 12px;
    padding: 14px 12px 14px 14px;
    border-right: 1px solid color-mix(in srgb, var(--ui-border-subtle) 92%, transparent);
    background:
      linear-gradient(180deg, rgba(var(--ui-shadow-rgb), 0.05), transparent 26%),
      color-mix(in srgb, var(--ui-bg-surface) 88%, transparent);
  }

  .agent-tree-header {
    display: grid;
    gap: 3px;
  }

  .agent-tree-kicker {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ui-text-muted);
  }

  .agent-tree-header strong {
    font-size: 13px;
    color: var(--ui-text-primary);
  }

  .agent-tree-list {
    display: grid;
    align-content: start;
    gap: 8px;
    overflow: auto;
    padding-right: 2px;
  }

  .agent-tree-branch {
    display: grid;
    gap: 8px;
    margin-left: 8px;
    padding-left: 10px;
    border-left: 1px solid color-mix(in srgb, var(--ui-border-subtle) 82%, transparent);
  }

  .agent-node {
    position: relative;
    width: 100%;
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr);
    align-items: start;
    gap: 8px;
    padding: 10px 10px 10px 10px;
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle) 92%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--ui-bg-elevated) 88%, transparent);
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .agent-node--selected {
    border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border-subtle));
    box-shadow: 0 10px 24px rgba(var(--ui-shadow-rgb), 0.16);
  }

  .agent-node-branch-line {
    position: absolute;
    left: -11px;
    top: 50%;
    width: 11px;
    border-top: 1px solid color-mix(in srgb, var(--ui-border-subtle) 82%, transparent);
    transform: translateY(-50%);
  }

  .agent-node-status {
    width: 8px;
    height: 8px;
    margin-top: 5px;
    border-radius: 999px;
    background: var(--ui-text-muted);
    box-shadow: 0 0 0 4px rgba(var(--ui-shadow-rgb), 0.08);
  }

  .agent-node-status--running {
    background: #52c271;
  }

  .agent-node-status--idle {
    background: #e0af68;
  }

  .agent-node-status--done {
    background: #7f849c;
  }

  .agent-node-status--error {
    background: #f7768e;
  }

  .agent-node-body {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .agent-node-label {
    font-size: 12px;
    font-weight: 700;
    color: var(--ui-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .agent-node-summary {
    font-size: 11px;
    line-height: 1.35;
    color: var(--ui-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
