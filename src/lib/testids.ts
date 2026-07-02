export const TEST_IDS = {
  appRoot: "app-root",
  tabBar: "tab-bar",
  newTabButton: "new-tab-button",
  settingsButton: "settings-button",
  sessionLauncher: "session-launcher",
  launcherNewSession: "launcher-new-session",
  launcherRecentList: "launcher-recent-list",
  launcherHistoryDeleteDialog: "launcher-history-delete-dialog",
  launcherHistoryDeleteConfirm: "launcher-history-delete-confirm",
  launcherHistoryDeleteCancel: "launcher-history-delete-cancel",
  launcherAgentTrigger: "launcher-agent-trigger",
  launcherAgentPicker: "launcher-agent-picker",
  launcherAgentList: "launcher-agent-list",
  launcherDistroTrigger: "launcher-distro-trigger",
  launcherDistroPicker: "launcher-distro-picker",
  launcherDistroList: "launcher-distro-list",
  launcherDirectoryList: "launcher-directory-list",
  launcherPathInput: "launcher-path-input",
  launcherOpenSelection: "launcher-open-selection",
  launcherOpenHere: "launcher-open-here",
  launcherDirectRuntimeToggle: "launcher-direct-runtime-toggle",
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
  auxTerminalShell: "aux-terminal-shell",
  draftToggle: "terminal-draft-toggle",
  auxTerminalToggle: "terminal-aux-toggle",
  draftTextarea: "terminal-draft-textarea",
  draftInsertButton: "terminal-draft-insert",
  draftSendButton: "terminal-draft-send",
  imagePasteModal: "image-paste-modal",
  imagePasteConfirm: "image-paste-confirm",
  imagePasteCancel: "image-paste-cancel",
  closeTabDialog: "close-tab-dialog",
  closeWindowDialog: "close-window-dialog",
  contextMenu: "context-menu",
  editorPickerModal: "editor-picker-modal",
  editorPickerList: "editor-picker-list",
  internalEditorShell: "internal-editor-shell",
  internalEditorTabBar: "internal-editor-tab-bar",
  internalEditorQuickOpenModal: "internal-editor-quick-open-modal",
  internalEditorQuickOpenInput: "internal-editor-quick-open-input",
  internalEditorQuickOpenList: "internal-editor-quick-open-list",
  // Direct Agent Runtime (08 §9.4)
  agentRuntimeShell: "agent-runtime-shell",
  agentRuntimeMetadata: "agent-runtime-metadata",
  agentTranscript: "agent-transcript",
  agentMessageList: "agent-message-list",
  agentMessageBubble: "agent-message-bubble",
  agentReasoningToggle: "agent-reasoning-toggle",
  agentPlanBlock: "agent-plan-block",
  agentComposer: "agent-composer",
  agentComposerInput: "agent-composer-input",
  agentComposerSend: "agent-composer-send",
  agentComposerCommandPalette: "agent-composer-command-palette",
  agentComposerCommandOption: "agent-composer-command-option",
  agentComposerImageButton: "agent-composer-image-button",
  agentComposerImageInput: "agent-composer-image-input",
  agentComposerImageAttachment: "agent-composer-image-attachment",
  agentComposerResourceButton: "agent-composer-resource-button",
  agentComposerResourcePalette: "agent-composer-resource-palette",
  agentComposerResourceOption: "agent-composer-resource-option",
  // Stage 2: tool/command/diff 카드 + approval + replay (08 §4·§7, T5.3·T5.4·T5.6)
  agentToolCallCard: "agent-tool-call-card",
  agentToolCallToggle: "agent-tool-call-toggle",
  agentCommandOutputCard: "agent-command-output-card",
  agentCommandOutput: "agent-command-output",
  agentFileDiffCard: "agent-file-diff-card",
  agentApprovalModal: "approval-modal",
  agentApprovalInlineCard: "approval-inline-card",
  agentApprovalOption: "approval-option",
  agentReplayAffordance: "agent-replay-affordance",
  agentRuntimeFallback: "agent-runtime-fallback",
  agentRuntimeFallbackPty: "agent-runtime-fallback-pty",
  agentRuntimeFallbackRetry: "agent-runtime-fallback-retry",
  agentRuntimeFallbackCancel: "agent-runtime-fallback-cancel",
  agentRestoreUnavailableNotice: "agent-restore-unavailable-notice",
  agentHistoryReadOnlyNotice: "agent-history-read-only-notice",
  legacyPtyPermissionNotice: "legacy-pty-permission-notice",
  agentReplayPanel: "agent-replay-panel",
  agentReplayClose: "agent-replay-close",
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

export function launcherAgentTestId(agentId: string) {
  return `launcher-agent-${toTestIdSegment(agentId)}`;
}

export function launcherDirectoryTestId(path: string) {
  return `launcher-directory-${toTestIdSegment(path)}`;
}

export function launcherHistoryItemTestId(index: number) {
  return `launcher-history-item-${index}`;
}

export function launcherHistoryDeleteButtonTestId(index: number) {
  return `launcher-history-delete-button-${index}`;
}

export function settingsNavSectionTestId(sectionId: string) {
  return `settings-nav-${toTestIdSegment(sectionId)}`;
}

export function contextMenuItemTestId(itemId: string) {
  return `context-menu-item-${toTestIdSegment(itemId)}`;
}

export function editorPickerItemTestId(editorId: string) {
  return `editor-picker-item-${toTestIdSegment(editorId)}`;
}

/** transcript item별 testid(렌더 검증·가상화 디버깅용). */
export function agentTranscriptItemTestId(itemId: string) {
  return `agent-transcript-item-${toTestIdSegment(itemId)}`;
}

/** tool location row별 testid(E2E location open 검증용). */
export function agentToolLocationTestId(itemId: string, index: number) {
  return `agent-tool-location-${toTestIdSegment(itemId)}-${index}`;
}

/** approval option 버튼별 testid(option id 보존, Stage 2 T5.4). */
export function agentApprovalOptionTestId(optionId: string) {
  return `approval-option-${toTestIdSegment(optionId)}`;
}
