<script lang="ts">
  import SessionLauncher from "../../../components/SessionLauncher.svelte";
  import { t } from "../../../i18n";
  import type { SessionViewportProps } from "../contracts/session-viewport";
  import type { SessionShellAuxState } from "../contracts/session-shell";

  let {
    sessions,
    activeSessionId,
    historyEntries,
    TerminalComponent,
    onOpenHistory,
    onConfirmSession,
    onSessionPtyId,
    onSessionAuxStateChange,
    onSessionExit,
    onSessionResumeFallback,
  }: SessionViewportProps = $props();

  function handleSessionAuxState(sessionId: string, state: SessionShellAuxState) {
    void onSessionAuxStateChange(sessionId, state);
  }
</script>

<div class="terminal-area">
  <div
    class="welcome-layer"
    style:display={sessions.length === 0 ? "block" : "none"}
  >
    <SessionLauncher
      visible={sessions.length === 0}
      embedded={true}
      historyEntries={historyEntries}
      onOpenHistory={onOpenHistory}
      onConfirm={onConfirmSession}
    />
  </div>

  <div
    class="sessions-layer"
    style:display={sessions.length > 0 ? "block" : "none"}
  >
    {#if TerminalComponent}
      {#each sessions as session (session.id)}
        <TerminalComponent
          sessionId={session.id}
          visible={session.id === activeSessionId}
          agentId={session.agentId}
          distro={session.distro}
          workDir={session.workDir}
          ptyId={session.ptyId}
          storedAuxPtyId={session.auxPtyId}
          storedAuxVisible={session.auxVisible}
          storedAuxHeightPercent={session.auxHeightPercent}
          resumeToken={session.resumeToken}
          onPtyId={(ptyId: number) => void onSessionPtyId(session.id, ptyId)}
          onAuxStateChange={(state: SessionShellAuxState) =>
            handleSessionAuxState(session.id, state)}
          onExit={(ptyId: number) => void onSessionExit(ptyId)}
          onResumeFallback={() => void onSessionResumeFallback(session.id)}
        />
      {/each}
    {:else}
      <div class="terminal-loading">
        <div class="terminal-loading-card">{$t("common.labels.loading")}</div>
      </div>
    {/if}
  </div>
</div>

<style>
  .terminal-area {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .welcome-layer,
  .sessions-layer {
    width: 100%;
    height: 100%;
  }

  .terminal-loading {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .terminal-loading-card {
    min-width: 180px;
    padding: 14px 18px;
    border: 1px solid var(--ui-border-subtle);
    border-radius: 14px;
    background: var(--ui-bg-surface);
    color: var(--ui-text-secondary);
    text-align: center;
    box-shadow: 0 12px 32px rgba(var(--ui-shadow-rgb), 0.18);
  }
</style>
