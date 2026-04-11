<script lang="ts">
  let {
    sessions = [],
    onRenameTab,
    onRenameWindow,
  }: {
    sessions?: Array<{ id: string }>;
    onRenameTab?: (sessionId: string) => void;
    onRenameWindow?: () => void;
  } = $props();
</script>

{#if sessions.length > 0}
  <button
    type="button"
    data-testid="rename-tab-trigger"
    onclick={() => { onRenameTab?.(sessions[0].id); }}
  >
    Rename Tab
  </button>
  <button
    type="button"
    data-testid="rename-window-trigger"
    onclick={() => { onRenameWindow?.(); }}
  >
    Rename Window
  </button>
{/if}
