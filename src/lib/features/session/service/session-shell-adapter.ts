import type { SessionHostProps, SessionShellProps } from "../contracts/session-shell";

export function createSessionHostProps(props: SessionShellProps): SessionHostProps {
  const { session, visible } = props;

  return {
    sessionId: session.id,
    visible,
    agentId: session.agentId,
    distro: session.distro,
    workDir: session.workDir,
    ptyId: session.ptyId,
    storedAuxPtyId: session.auxPtyId,
    storedAuxVisible: session.auxVisible,
    storedAuxHeightPercent: session.auxHeightPercent,
    resumeToken: session.resumeToken,
    sessionSnapshot: {
      viewMode: session.viewMode,
      editorRootDir: session.editorRootDir,
      openEditorTabs: session.openEditorTabs,
      activeEditorPath: session.activeEditorPath,
    },
    onEditorSessionStateChange: props.onSessionEditorStateChange
      ? (state) => props.onSessionEditorStateChange?.(session.id, state)
      : undefined,
    onPtyId: props.onSessionPtyId
      ? (ptyId) => props.onSessionPtyId?.(session.id, ptyId)
      : undefined,
    onAuxStateChange: props.onSessionAuxStateChange
      ? (state) => props.onSessionAuxStateChange?.(session.id, state)
      : undefined,
    onExit: props.onSessionExit
      ? (ptyId) => props.onSessionExit?.(ptyId)
      : undefined,
    onResumeFallback: props.onSessionResumeFallback
      ? () => props.onSessionResumeFallback?.(session.id)
      : undefined,
  };
}
