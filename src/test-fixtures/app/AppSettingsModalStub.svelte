<script lang="ts">
  let {
    visible = false,
    onClose,
  } = $props<{ visible?: boolean; onClose?: () => void }>();
</script>

{#if visible}
  <div data-testid="settings-modal-stub">
    <button type="button" data-testid="settings-modal-close" onclick={() => { onClose?.(); }}>
      Close Settings
    </button>
  </div>
{/if}
