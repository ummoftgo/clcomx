import { invoke } from "@tauri-apps/api/core";
import { getAgentDefinition, type AgentId } from "./agents";

export interface PtyOutputChunk {
  id: number;
  seq: number;
  data: string;
}

export interface PtyOutputSnapshot {
  data: string;
  seq: number;
}

export async function spawnPty(
  cols: number,
  rows: number,
  agentId: AgentId,
  distro: string,
  workDir: string,
  resumeToken?: string | null,
): Promise<number> {
  const escapeShellSingleQuoted = (value: string) => value.replace(/'/g, "'\\''");
  const safeWorkDir = escapeShellSingleQuoted(workDir);
  const safeResumeToken = resumeToken ? escapeShellSingleQuoted(resumeToken) : null;
  const agent = getAgentDefinition(agentId);
  const startCommand = safeResumeToken
    ? `if ! ${agent.buildResumeCommand(safeResumeToken)}; then printf '__CLCOMX_RESUME_FAILED__\\r\\n'; ${agent.buildStartCommand()}; fi`
    : agent.buildStartCommand();

  return await invoke<number>("pty_spawn", {
    cols,
    rows,
    command: "wsl.exe",
    args: ["-d", distro, "-e", "bash", "-li", "-c", `cd '${safeWorkDir}' && ${startCommand}`],
    cwd: null,
    mockAgentId: agentId,
    mockDistro: distro,
    mockWorkDir: workDir,
  });
}

export async function writePty(id: number, data: string): Promise<void> {
  await invoke("pty_write", { id, data });
}

export async function takePtyInitialOutput(id: number): Promise<string> {
  return await invoke<string>("pty_take_initial_output", { id });
}

export async function getPtyOutputSnapshot(
  id: number,
): Promise<PtyOutputSnapshot> {
  return await invoke<PtyOutputSnapshot>("pty_get_output_snapshot", { id });
}

export async function resizePty(
  id: number,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("pty_resize", { id, cols, rows });
}

export async function killPty(id: number): Promise<void> {
  await invoke("pty_kill", { id });
}
