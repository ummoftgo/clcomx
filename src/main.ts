import { mount } from "svelte";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App.svelte";
import "./app.css";
import { loadBootstrap } from "./lib/bootstrap";
import { getSettings, initializeSettings } from "./lib/stores/settings.svelte";
import { initializeSessionsFromWorkspace } from "./lib/stores/sessions.svelte";
import { initializeTabHistory } from "./lib/stores/tab-history.svelte";
import { initializeWorkspaceSnapshot } from "./lib/stores/workspace.svelte";
import { initializeI18n } from "./lib/i18n";
import { getThemeById, initializeThemes } from "./lib/themes";
import { applyUiPreferenceVariables, applyUiThemeVariables } from "./lib/ui";

function applyInitialTheme() {
  const root = document.documentElement;
  const settings = getSettings();
  const themeDef = getThemeById(settings.interface.theme)?.theme;

  if (themeDef) {
    root.style.setProperty("--app-bg", themeDef.background ?? "#1e1e2e");
    root.style.setProperty("--tab-text", themeDef.foreground ?? "#cdd6f4");
    root.style.setProperty("--tab-bg", themeDef.background ?? "#1e1e2e");
    root.style.setProperty("--tab-active-bg", themeDef.selectionBackground ?? "#313244");
    root.style.setProperty("--tab-border", themeDef.selectionBackground ?? "#45475a");
    applyUiThemeVariables(root, themeDef);
  }

  applyUiPreferenceVariables(root, settings);
}

async function bootstrapApp() {
  const windowLabel = getCurrentWindow().label;
  const bootstrap = await loadBootstrap();
  initializeThemes(bootstrap.themePack);
  initializeSettings(bootstrap.settings);
  initializeI18n(getSettings().language, navigator.language);
  initializeTabHistory(bootstrap.tabHistory);
  initializeWorkspaceSnapshot(bootstrap.workspace, windowLabel);
  initializeSessionsFromWorkspace(bootstrap.workspace, windowLabel);
  applyInitialTheme();

  const app = mount(App, {
    target: document.getElementById("app")!,
  });

  return app;
}

const app = bootstrapApp();

export default app;
