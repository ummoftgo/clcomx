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

export interface PtyRuntimeSnapshot {
  data: string;
  seq: number;
  cols: number;
  rows: number;
}

export interface PtyOutputDelta {
  data: string;
  seq: number;
  complete: boolean;
}

function escapeShellSingleQuoted(value: string) {
  return value.replace(/'/g, "'\\''");
}

export async function spawnPty(
  cols: number,
  rows: number,
  agentId: AgentId,
  distro: string,
  workDir: string,
  resumeToken?: string | null,
): Promise<number> {
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
    mockResumeToken: resumeToken,
  });
}

export async function spawnShellPty(
  cols: number,
  rows: number,
  distro: string,
  workDir: string,
): Promise<number> {
  const safeWorkDir = escapeShellSingleQuoted(workDir);
  const auxRcHeredoc = [
    'cat > "$__clcomx_aux_rc" <<\'CLCOMX_AUX_RC\'',
    'rm -f -- "${BASH_SOURCE[0]}"',
    "[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc",
    "[ -r ~/.bashrc ] && . ~/.bashrc",
    "__clcomx_update_cwd() {",
    "  local __clcomx_pwd_b64",
    "  __clcomx_pwd_b64=$(printf '%s' \"$PWD\" | base64 | tr -d '\\r\\n')",
    "  printf '\\033]633;CLCOMX_CWD;%s\\007' \"$__clcomx_pwd_b64\"",
    "}",
    "PROMPT_COMMAND=\"__clcomx_update_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"",
    "CLCOMX_AUX_RC",
  ].join("\n");
  const shellCommand = [
    "__clcomx_aux_rc=$(mktemp /tmp/clcomx-aux-rc.XXXXXX)",
    auxRcHeredoc,
    `if cd '${safeWorkDir}' 2>/dev/null; then exec bash --noprofile --rcfile "$__clcomx_aux_rc" -i; else cd ~ && exec bash --noprofile --rcfile "$__clcomx_aux_rc" -i; fi`,
  ].join("\n");

  return await invoke<number>("pty_spawn", {
    cols,
    rows,
    command: "wsl.exe",
    args: [
      "-d",
      distro,
      "-e",
      "bash",
      "-li",
      "-c",
      shellCommand,
    ],
    cwd: null,
    mockAgentId: "shell",
    mockDistro: distro,
    mockWorkDir: workDir,
    mockResumeToken: null,
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

export async function getPtyRuntimeSnapshot(
  id: number,
): Promise<PtyRuntimeSnapshot> {
  return await invoke<PtyRuntimeSnapshot>("pty_get_runtime_snapshot", { id });
}

export async function getPtyOutputDeltaSince(
  id: number,
  afterSeq: number,
): Promise<PtyOutputDelta> {
  return await invoke<PtyOutputDelta>("pty_get_output_delta_since", {
    id,
    afterSeq,
  });
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
