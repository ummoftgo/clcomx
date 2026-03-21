export const TEST_IDS = {
  appRoot: "app-root",
  tabBar: "tab-bar",
  newTabButton: "new-tab-button",
  settingsButton: "settings-button",
  sessionLauncher: "session-launcher",
  launcherNewSession: "launcher-new-session",
  launcherRecentList: "launcher-recent-list",
  launcherDistroList: "launcher-distro-list",
  launcherDirectoryList: "launcher-directory-list",
  launcherPathInput: "launcher-path-input",
  launcherOpenSelection: "launcher-open-selection",
  launcherOpenHere: "launcher-open-here",
  settingsModal: "settings-modal",
  settingsNav: "settings-nav",
  settingsBody: "settings-body",
  settingsInterfaceUiScaleInput: "settings-interface-ui-scale-input",
  settingsHistoryTabLimitInput: "settings-history-tab-limit-input",
  settingsStorageFiles: "settings-storage-files",
  settingsStorageSize: "settings-storage-size",
  settingsStorageOpenFolder: "settings-storage-open-folder",
  settingsStorageClearCache: "settings-storage-clear-cache",
  terminalShell: "terminal-shell",
  terminalOutput: "terminal-output",
  draftToggle: "terminal-draft-toggle",
  draftTextarea: "terminal-draft-textarea",
  draftInsertButton: "terminal-draft-insert",
  draftSendButton: "terminal-draft-send",
  imagePasteModal: "image-paste-modal",
  imagePasteConfirm: "image-paste-confirm",
  imagePasteCancel: "image-paste-cancel",
  closeTabDialog: "close-tab-dialog",
  closeWindowDialog: "close-window-dialog",
  contextMenu: "context-menu",
} as const;

export function toTestIdSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

export function tabTestId(sessionId: string) {
  return `tab-${sessionId}`;
}

export function tabMenuButtonTestId(sessionId: string) {
  return `tab-menu-${sessionId}`;
}

export function tabCloseButtonTestId(sessionId: string) {
  return `tab-close-${sessionId}`;
}

export function launcherDistroTestId(distro: string) {
  return `launcher-distro-${toTestIdSegment(distro)}`;
}

export function launcherDirectoryTestId(path: string) {
  return `launcher-directory-${toTestIdSegment(path)}`;
}

export function settingsNavSectionTestId(sectionId: string) {
  return `settings-nav-${toTestIdSegment(sectionId)}`;
}

export function contextMenuItemTestId(itemId: string) {
  return `context-menu-item-${toTestIdSegment(itemId)}`;
}
