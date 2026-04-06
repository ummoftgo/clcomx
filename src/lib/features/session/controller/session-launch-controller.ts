import type { AgentId } from "../../../agents";
import type { Session, TabHistoryEntry } from "../../../types";
import {
  buildSession,
  createSessionLaunchRequest,
  createSessionLaunchRequestFromHistoryEntry,
} from "../service/session-factory";

interface SessionLaunchControllerDependencies {
  addSession: (session: Session) => void;
  hideSessionLauncher: () => void;
  persistWorkspace: () => void | Promise<void>;
  ensureTerminalComponent: () => void | Promise<void>;
}

export function launchSession(
  deps: SessionLaunchControllerDependencies,
  input: {
    agentId: AgentId;
    distro: string;
    workDir: string;
    title?: string | null;
    resumeToken?: string | null;
  },
) {
  const request = createSessionLaunchRequest(input);
  deps.addSession(buildSession(request));
  deps.hideSessionLauncher();
  void deps.persistWorkspace();
  void deps.ensureTerminalComponent();
}

export function launchSessionFromHistoryEntry(
  deps: SessionLaunchControllerDependencies,
  entry: TabHistoryEntry,
) {
  const request = createSessionLaunchRequestFromHistoryEntry(entry);
  launchSession(deps, request);
}
