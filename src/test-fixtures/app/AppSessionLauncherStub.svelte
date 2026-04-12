<script lang="ts">
  let {
    visible = false,
    onCancel,
  } = $props<{ visible?: boolean; onCancel?: () => void }>();
</script>

{#if visible}
  <div data-testid="session-launcher-stub">
    <button type="button" data-testid="session-launcher-cancel" onclick={() => { onCancel?.(); }}>
      Cancel Launcher
    </button>
  </div>
{/if}
