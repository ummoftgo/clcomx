<script lang="ts">
  let { visible = false } = $props<{ visible?: boolean }>();
</script>

{#if visible}
  <div data-testid="session-launcher-stub"></div>
{/if}
