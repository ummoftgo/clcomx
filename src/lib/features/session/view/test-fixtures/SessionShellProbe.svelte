<script lang="ts">
  import type { SessionShellProps } from "../../contracts/session-shell";

  let {
    session,
    visible,
    onSessionEditorStateChange,
    onSessionPtyId,
    onSessionAuxStateChange,
    onSessionExit,
    onSessionResumeFallback,
  }: SessionShellProps = $props();

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
  }
</script>

<button
  data-testid={`session-shell-probe-${session.id}`}
  data-visible={visible ? "true" : "false"}
  onclick={emitAll}
>
  {session.id}
</button>
