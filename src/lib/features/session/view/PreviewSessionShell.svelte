<script lang="ts">
  import PreviewTerminal from "../../../components/PreviewTerminal.svelte";
  import type { SessionShellProps } from "../contracts/session-shell";

  let props: SessionShellProps = $props();
</script>

<PreviewTerminal {...props} />
