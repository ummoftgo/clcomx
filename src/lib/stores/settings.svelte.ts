import { invoke } from "@tauri-apps/api/core";
import { type DeepPartial, type Settings, DEFAULT_SETTINGS } from "../types";

let settings = $state<Settings>(cloneDefaults());
let settingsLoaded = false;
let saveQueue: Promise<void> = Promise.resolve();

function cloneDefaults(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    interface: { ...DEFAULT_SETTINGS.interface },
    workspace: {
      ...DEFAULT_SETTINGS.workspace,
      defaultStartPathsByDistro: { ...DEFAULT_SETTINGS.workspace.defaultStartPathsByDistro },
    },
    terminal: {
      ...DEFAULT_SETTINGS.terminal,
      claudeCliFlags: { ...DEFAULT_SETTINGS.terminal.claudeCliFlags },
    },
    history: { ...DEFAULT_SETTINGS.history },
  };
}

function normalizeStringRecord(
  record?: Record<string, string | undefined> | null,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (typeof value === "string") {
      next[key] = value;
    }
  }
  return next;
}

export function normalizeSettings(partial?: DeepPartial<Settings> | null): Settings {
  return {
    ...cloneDefaults(),
    ...(partial ?? {}),
    interface: {
      ...DEFAULT_SETTINGS.interface,
      ...(partial?.interface ?? {}),
    },
    workspace: {
      ...DEFAULT_SETTINGS.workspace,
      ...(partial?.workspace ?? {}),
      defaultStartPathsByDistro: normalizeStringRecord(
        partial?.workspace?.defaultStartPathsByDistro,
      ),
    },
    terminal: {
      ...DEFAULT_SETTINGS.terminal,
      ...(partial?.terminal ?? {}),
      claudeCliFlags: {
        ...DEFAULT_SETTINGS.terminal.claudeCliFlags,
        ...(partial?.terminal?.claudeCliFlags ?? {}),
      },
    },
    history: {
      ...DEFAULT_SETTINGS.history,
      ...(partial?.history ?? {}),
    },
  };
}

export function getSettings(): Settings {
  return settings;
}

export function initializeSettings(persisted?: DeepPartial<Settings> | null) {
  const normalized = normalizeSettings(persisted);
  Object.assign(settings, normalized);
  settingsLoaded = true;
}

export function updateSettings(partial: DeepPartial<Settings>) {
  if (partial.interface) {
    Object.assign(settings.interface, partial.interface);
  }

  if (partial.workspace) {
    if ("defaultDistro" in partial.workspace && partial.workspace.defaultDistro !== undefined) {
      settings.workspace.defaultDistro = partial.workspace.defaultDistro;
    }

    if ("defaultAgentId" in partial.workspace && partial.workspace.defaultAgentId !== undefined) {
      settings.workspace.defaultAgentId = partial.workspace.defaultAgentId;
    }

    if (
      "defaultStartPathsByDistro" in partial.workspace &&
      partial.workspace.defaultStartPathsByDistro !== undefined
    ) {
      for (const key of Object.keys(settings.workspace.defaultStartPathsByDistro)) {
        delete settings.workspace.defaultStartPathsByDistro[key];
      }
      Object.assign(
        settings.workspace.defaultStartPathsByDistro,
        partial.workspace.defaultStartPathsByDistro,
      );
    }
  }

  if (partial.terminal) {
    const { claudeCliFlags, ...terminalRemainder } = partial.terminal;
    if (claudeCliFlags) {
      Object.assign(settings.terminal.claudeCliFlags, claudeCliFlags);
    }
    Object.assign(settings.terminal, terminalRemainder);
  }

  if (partial.history) {
    Object.assign(settings.history, partial.history);
  }

  const remainder = { ...partial };
  delete remainder.interface;
  delete remainder.workspace;
  delete remainder.terminal;
  delete remainder.history;
  Object.assign(settings, remainder);

  if (!settingsLoaded) return;

  const snapshot = normalizeSettings(JSON.parse(JSON.stringify(settings)) as Settings);
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      try {
        await invoke("save_settings", { settings: snapshot });
      } catch (error) {
        console.error("Failed to save settings", error);
      }
    });
}
