import type { AgentId } from "../../../agents";
import type { Session, TabHistoryEntry } from "../../../types";
import type { SessionRuntimeKind } from "../../agent-runtime/contracts/metadata";
import {
  buildSession,
  createSessionLaunchRequest,
  createSessionLaunchRequestFromHistoryEntry,
} from "../service/session-factory";

interface SessionLaunchControllerDependencies {
  addSession: (session: Session) => void;
  hideSessionLauncher: () => void;
  persistWorkspace: () => void | Promise<void>;
  ensureSessionShellComponent: () => void | Promise<void>;
}

export function launchSession(
  deps: SessionLaunchControllerDependencies,
  input: {
    agentId: AgentId;
    distro: string;
    workDir: string;
    title?: string | null;
    resumeToken?: string | null;
    /** direct runtime 선택 시 host 종류(10 §5). 미지정 시 PTY. */
    runtimeKind?: SessionRuntimeKind;
  },
) {
  const request = createSessionLaunchRequest(input);
  deps.addSession(buildSession(request));
  deps.hideSessionLauncher();
  void deps.persistWorkspace();
  void deps.ensureSessionShellComponent();
}

export function launchSessionFromHistoryEntry(
  deps: SessionLaunchControllerDependencies,
  entry: TabHistoryEntry,
) {
  const request = createSessionLaunchRequestFromHistoryEntry(entry);
  launchSession(deps, request);
}
