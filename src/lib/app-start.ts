import { mount } from "svelte";
import { loadBootstrap } from "./bootstrap";
import { loadCustomCss } from "./custom-css";
import { initializeI18n } from "./i18n";
import { getCurrentWindow } from "./tauri/window";
import { initializeSettings, getSettings } from "./stores/settings.svelte";
import { initializeSessionsFromWorkspace } from "./stores/sessions.svelte";
import { initializeTabHistory } from "./stores/tab-history.svelte";
import { initializeWorkspaceSnapshot } from "./stores/workspace.svelte";
import { getThemeById, initializeThemes } from "./themes";
import { applyCustomCssLayer, applyRuntimeStyleLayer } from "./ui";

export function applyCurrentAppStyles() {
  const settings = getSettings();
  const theme = getThemeById(settings.interface.theme)?.theme;
  applyRuntimeStyleLayer(document, settings, theme);
}

export async function startApp() {
  const windowLabel = getCurrentWindow().label;
  const [bootstrap, customCssText] = await Promise.all([loadBootstrap(), loadCustomCss()]);
  initializeThemes(bootstrap.themePack);
  initializeSettings(bootstrap.settings);
  initializeI18n(getSettings().language, navigator.language);
  initializeTabHistory(bootstrap.tabHistory);
  initializeWorkspaceSnapshot(bootstrap.workspace, windowLabel);
  initializeSessionsFromWorkspace(bootstrap.workspace, windowLabel);
  applyCurrentAppStyles();
  applyCustomCssLayer(document, customCssText);

  const { default: App } = await import("../App.svelte");
  return mount(App, {
    target: document.getElementById("app")!,
  });
}
