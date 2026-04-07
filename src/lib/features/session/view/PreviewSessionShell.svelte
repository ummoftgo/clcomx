<script lang="ts">
  import PreviewTerminal from "../../../components/PreviewTerminal.svelte";
  import type { SessionShellProps } from "../contracts/session-shell";
  import { createSessionHostProps } from "../service/session-shell-adapter";

  let props: SessionShellProps = $props();
  const previewProps = $derived(createSessionHostProps(props));
</script>

<PreviewTerminal {...previewProps} />
