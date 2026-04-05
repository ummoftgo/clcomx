<script lang="ts">
  import Terminal from "../../../components/Terminal.svelte";
  import type { SessionShellProps } from "../contracts/session-shell";

  let props: SessionShellProps = $props();
</script>

<Terminal {...props} />
