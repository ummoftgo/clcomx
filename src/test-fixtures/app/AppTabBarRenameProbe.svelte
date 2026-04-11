<script lang="ts">
  let {
    sessions = [],
    onRenameTab,
  }: {
    sessions?: Array<{ id: string }>;
    onRenameTab?: (sessionId: string) => void;
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
{/if}
