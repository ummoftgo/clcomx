export interface SessionShellAuxState {
  auxPtyId: number;
  auxVisible: boolean;
  auxHeightPercent: number | null;
}

export interface SessionShellProps {
  sessionId: string;
  visible: boolean;
  agentId: string;
  distro: string;
  workDir: string;
  ptyId: number;
  storedAuxPtyId?: number;
  storedAuxVisible?: boolean;
  storedAuxHeightPercent?: number | null;
  resumeToken?: string | null;
  onPtyId?: (ptyId: number) => void;
  onAuxStateChange?: (state: SessionShellAuxState) => void;
  onExit?: (ptyId: number) => void;
  onResumeFallback?: () => void;
}
