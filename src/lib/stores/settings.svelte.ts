import { invoke } from "../tauri/core";
import { type DeepPartial, type Settings, DEFAULT_SETTINGS } from "../types";

let settings = $state<Settings>(cloneDefaults());
let settingsLoaded = false;
let saveQueue: Promise<void> = Promise.resolve();
// 마지막 저장 시도(실패 보존). 큐 체인은 실패를 삼켜 계속 진행하지만, 보안 민감 설정의
// flush 호출자(예: Claude 구독 인증 launch 판정)는 이 promise로 실패를 감지해야 한다.
let lastSaveAttempt: Promise<void> | null = null;

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
    editor: {
      ...DEFAULT_SETTINGS.editor,
    },
    agentRuntime: { ...DEFAULT_SETTINGS.agentRuntime },
    history: { ...DEFAULT_SETTINGS.history },
  };
}

/** agentRuntime "상속" 표현 정규화 — 빈 문자열/공백은 null(상속)로 접는다. */
function normalizeInheritableString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** agentRuntime fontSize 정규화 — 유한 숫자만 허용, 그 외는 null(상속). */
function normalizeInheritableFontSize(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  const terminal = {
    ...DEFAULT_SETTINGS.terminal,
    ...(partial?.terminal ?? {}),
    claudeCliFlags: {
      ...DEFAULT_SETTINGS.terminal.claudeCliFlags,
      ...(partial?.terminal?.claudeCliFlags ?? {}),
    },
  };

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
    terminal,
    editor: {
      fontFamily: partial?.editor?.fontFamily ?? terminal.fontFamily,
      fontFamilyFallback: partial?.editor?.fontFamilyFallback ?? terminal.fontFamilyFallback,
      fontSize: partial?.editor?.fontSize ?? terminal.fontSize,
    },
    agentRuntime: {
      fontSize: normalizeInheritableFontSize(partial?.agentRuntime?.fontSize),
      fontFamily: normalizeInheritableString(partial?.agentRuntime?.fontFamily),
      codeFontFamily: normalizeInheritableString(partial?.agentRuntime?.codeFontFamily),
      claudeAllowSubscriptionAuth: partial?.agentRuntime?.claudeAllowSubscriptionAuth === true,
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

/**
 * 지금까지 큐잉된 설정 저장(save_settings)이 디스크에 반영될 때까지 기다린다.
 * backend가 저장 설정을 권위로 읽는 경로(예: Claude 구독 인증 opt-in의 allowlist 판정) 직전에
 * 호출해, in-memory 토글과 디스크 상태의 불일치 레이스를 닫는다.
 * [중요] 마지막 저장 시도가 실패했으면 **reject된다** — 디스크(backend 권위)가 stale일 수
 * 있다는 뜻이므로, 보안 민감 판정을 하는 호출자는 진행을 중단해야 한다(revoke 미반영 방지).
 */
export function flushSettingsSave(): Promise<void> {
  return lastSaveAttempt ?? Promise.resolve();
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

  if (partial.editor) {
    Object.assign(settings.editor, partial.editor);
  }

  if (partial.agentRuntime) {
    Object.assign(settings.agentRuntime, partial.agentRuntime);
  }

  if (partial.history) {
    Object.assign(settings.history, partial.history);
  }

  const remainder = { ...partial };
  delete remainder.interface;
  delete remainder.workspace;
  delete remainder.terminal;
  delete remainder.editor;
  delete remainder.agentRuntime;
  delete remainder.history;
  Object.assign(settings, remainder);

  if (!settingsLoaded) return;

  const snapshot = normalizeSettings(JSON.parse(JSON.stringify(settings)) as Settings);
  const attempt = saveQueue
    .catch(() => {})
    .then(() => invoke("save_settings", { settings: snapshot }))
    .then(() => {});
  // flush용으로 실패를 보존하고(위 lastSaveAttempt 주석), 큐 체인은 실패를 로깅 후 계속 진행한다.
  lastSaveAttempt = attempt;
  saveQueue = attempt.catch((error) => {
    console.error("Failed to save settings", error);
  });
}
