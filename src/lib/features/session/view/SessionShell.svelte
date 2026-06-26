<!--
  SessionShell — host 분기(옵션 B, 08 §9.1).

  session.runtimeKind가 "direct-*"면 direct agent runtime host(AgentTranscriptSurface)를,
  아니면 기존 terminal host(Terminal)를 렌더한다. SessionHostProps는 두 host에 동형으로 넘긴다.
  direct 경로에서 onPtyId 등 PTY 전제 콜백은 host가 호출하지 않으므로 그대로 전달돼도 no-op이다.
-->
<script lang="ts">
  import Terminal from "../../../components/Terminal.svelte";
  import AgentTranscriptSurface from "../../agent-runtime/view/AgentTranscriptSurface.svelte";
  import type { SessionShellProps } from "../contracts/session-shell";
  import { createSessionHostProps } from "../service/session-shell-adapter";

  let props: SessionShellProps = $props();
  const hostProps = $derived(createSessionHostProps(props));
  // runtimeKind: "pty" | "direct-codex" | "direct-claude"(15 §7). 미지정/pty는 기존 terminal.
  const useDirectRuntime = $derived(
    props.session.runtimeKind?.startsWith("direct-") ?? false,
  );
</script>

{#if useDirectRuntime}
  <AgentTranscriptSurface {...hostProps} />
{:else}
  <Terminal {...hostProps} />
{/if}
