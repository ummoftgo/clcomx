import type { Component } from "svelte";
import InterfaceSettingsSection from "./sections/InterfaceSettingsSection.svelte";
import WorkspaceSettingsSection from "./sections/WorkspaceSettingsSection.svelte";
import TerminalSettingsSection from "./sections/TerminalSettingsSection.svelte";
import StorageSettingsSection from "./sections/StorageSettingsSection.svelte";
import HistorySettingsSection from "./sections/HistorySettingsSection.svelte";

export type SettingsSectionId = "interface" | "workspace" | "terminal" | "storage" | "history";

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  titleKey: string;
  descriptionKey: string;
  component: Component;
}

export const SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "interface",
    titleKey: "settings.sections.interface",
    descriptionKey: "settings.sections.interfaceHint",
    component: InterfaceSettingsSection,
  },
  {
    id: "workspace",
    titleKey: "settings.sections.workspace",
    descriptionKey: "settings.sections.workspaceHint",
    component: WorkspaceSettingsSection,
  },
  {
    id: "terminal",
    titleKey: "settings.sections.terminal",
    descriptionKey: "settings.sections.terminalHint",
    component: TerminalSettingsSection,
  },
  {
    id: "storage",
    titleKey: "settings.sections.storage",
    descriptionKey: "settings.sections.storageHint",
    component: StorageSettingsSection,
  },
  {
    id: "history",
    titleKey: "settings.sections.history",
    descriptionKey: "settings.sections.historyHint",
    component: HistorySettingsSection,
  },
];
