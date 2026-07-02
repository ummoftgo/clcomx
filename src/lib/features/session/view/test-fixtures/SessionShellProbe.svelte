<script module lang="ts">
  /** SessionViewport 무재mount 테스트가 관찰하는 probe lifecycle 로그. */
  export const lifecycleLog: string[] = [];

  /** 테스트 간 lifecycle 로그를 초기화한다. */
  export function resetLifecycleLog() {
    lifecycleLog.length = 0;
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import type { SessionShellProps } from "../../contracts/session-shell";

  let {
    session,
    visible,
    onSessionEditorStateChange,
    onSessionPtyId,
    onSessionAuxStateChange,
    onSessionExit,
    onSessionResumeFallback,
    onSessionAgentRuntimeStatusChange,
    onSessionTitleChange,
  }: SessionShellProps = $props();

  onMount(() => {
    lifecycleLog.push(`mount:${session.id}`);
    return () => {
      lifecycleLog.push(`destroy:${session.id}`);
    };
  });

  function emitAll() {
    void onSessionEditorStateChange?.(session.id, {
      viewMode: "editor",
      editorRootDir: `${session.workDir}/src`,
      openEditorTabs: [{ wslPath: `${session.workDir}/src/App.svelte`, line: 3, column: 7 }],
      activeEditorPath: `${session.workDir}/src/App.svelte`,
      dirtyPaths: [],
    });
    void onSessionPtyId?.(session.id, 91);
    void onSessionAuxStateChange?.(session.id, {
      auxPtyId: 52,
      auxVisible: !session.auxVisible,
      auxHeightPercent: 33,
    });
    void onSessionExit?.(91);
    void onSessionResumeFallback?.(session.id);
    void onSessionAgentRuntimeStatusChange?.(session.id, "running");
    void onSessionTitleChange?.(session.id, `Provider ${session.id}`);
  }
</script>

<button
  data-testid={`session-shell-probe-${session.id}`}
  data-visible={visible ? "true" : "false"}
  onclick={emitAll}
>
  {session.id}
</button>
