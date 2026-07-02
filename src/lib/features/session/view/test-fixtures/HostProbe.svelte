<!--
  HostProbe — SessionShell host 분기 테스트용 최소 host.

  실제 Terminal/xterm과 AgentTranscriptSurface를 띄우지 않고 host props 전달 여부만 관찰한다.
-->
<script lang="ts">
  import type { FileLocation } from "../../../agent-runtime/contracts/normalized";
  import type { SessionHostProps } from "../../contracts/session-shell";

  let {
    sessionId,
    runtimeKind,
    onOpenLocation,
  }: SessionHostProps & { onOpenLocation?: (location: FileLocation) => void } = $props();
</script>

<div data-testid="session-host-probe" data-session-id={sessionId} data-runtime-kind={runtimeKind ?? "pty"}>
  {#if onOpenLocation}
    <button
      type="button"
      data-testid="host-open-location"
      onclick={() => onOpenLocation?.({ path: "/workspace/a/src/app.ts", line: 12, column: 3 })}
    >
      open location
    </button>
  {/if}
</div>
