import { invoke } from "./tauri/core";

export interface WslEntry {
  name: string;
  path: string;
}

export async function listWslDistros(): Promise<string[]> {
  return await invoke<string[]>("list_wsl_distros");
}

export async function listWslDirectories(
  distro: string,
  path: string,
): Promise<WslEntry[]> {
  return await invoke<WslEntry[]>("list_wsl_directories", { distro, path });
}
