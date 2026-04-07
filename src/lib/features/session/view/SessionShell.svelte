<script lang="ts">
  import Terminal from "../../../components/Terminal.svelte";
  import type { SessionShellProps } from "../contracts/session-shell";
  import { createSessionHostProps } from "../service/session-shell-adapter";

  let props: SessionShellProps = $props();
  const terminalProps = $derived(createSessionHostProps(props));
</script>

<Terminal {...terminalProps} />
