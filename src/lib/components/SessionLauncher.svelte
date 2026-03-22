<script lang="ts">
  import { _ as translate } from "svelte-i18n";
  import { listWslDistros, listWslDirectories, type WslEntry } from "../wsl";
  import type { TabHistoryEntry } from "../types";
  import { getSettings } from "../stores/settings.svelte";
  import { getBuiltinAgents, getAgentDefinition, getAgentLabel, summarizeResumeToken, type AgentId } from "../agents";
  import AgentIcon from "./AgentIcon.svelte";
  import {
    TEST_IDS,
    launcherAgentTestId,
    launcherDirectoryTestId,
    launcherDistroTestId,
    launcherHistoryItemTestId,
  } from "../testids";

  type TranslationOptions = {
    default?: string;
    values?: Record<string, string | number | boolean | Date | null | undefined>;
    locale?: string;
    format?: string;
  };

  interface Props {
    visible: boolean;
    embedded?: boolean;
    historyEntries: TabHistoryEntry[];
    onOpenHistory: (entry: TabHistoryEntry) => void;
    onConfirm: (agentId: AgentId, distro: string, workDir: string) => void;
    onCancel?: () => void;
  }

  let {
    visible,
    embedded = false,
    historyEntries,
    onOpenHistory,
    onConfirm,
    onCancel = () => {},
  }: Props = $props();

  let step = $state<"home" | "browser">("home");
  let distros = $state<string[]>([]);
  const builtinAgents = getBuiltinAgents();
  const settings = getSettings();
  const t = (key: string, options?: TranslationOptions) => $translate(key, options);
  let selectedDistro = $state("");
  let selectedAgentId = $state<AgentId>(settings.workspace.defaultAgentId || "claude");
  let currentPath = $state("/home");
  let selectedPath = $state("/home");
  let directories = $state<WslEntry[]>([]);
  let loading = $state(false);
  let agentPickerOpen = $state(false);
  let distroPickerOpen = $state(false);
  let pathInput = $state("/home");
  let error = $state("");
  let navigationHistory = $state<string[]>(["/home"]);
  let navigationIndex = $state(0);

  $effect(() => {
    const availableAgentIds = new Set(builtinAgents.map((agent) => agent.id));
    const preferredAgentId = settings.workspace.defaultAgentId || "claude";
    if (!selectedAgentId || !availableAgentIds.has(selectedAgentId)) {
      selectedAgentId = availableAgentIds.has(preferredAgentId) ? preferredAgentId : "claude";
    }
  });

  async function ensureDistrosLoaded() {
    if (distros.length > 0) return distros;
    if (loading) return distros;

    loading = true;
    error = "";
    try {
      distros = await listWslDistros();
      if (!selectedDistro && settings.workspace.defaultDistro && distros.includes(settings.workspace.defaultDistro)) {
        selectedDistro = settings.workspace.defaultDistro;
      }
      if (distros.length === 0) {
        error = t("launcher.error.noDistros");
      }
    } catch (e) {
      error = `${t("launcher.error.loadDistros")}: ${e}`;
    } finally {
      loading = false;
    }
    return distros;
  }

  function resetToHome() {
    step = "home";
    selectedDistro = "";
    selectedAgentId = settings.workspace.defaultAgentId || "claude";
    currentPath = "/home";
    selectedPath = "/home";
    pathInput = "/home";
    directories = [];
    navigationHistory = ["/home"];
    navigationIndex = 0;
    agentPickerOpen = false;
    distroPickerOpen = false;
    error = "";
    loading = false;
  }

  function getDefaultPathForDistro(distro: string) {
    return settings.workspace.defaultStartPathsByDistro[distro]?.trim() || "/home";
  }

  async function selectDistro(distro: string) {
    selectedDistro = distro;
    await navigateTo(getDefaultPathForDistro(distro));
  }

  async function beginNewSession() {
    step = "browser";
    selectedAgentId = selectedAgentId || settings.workspace.defaultAgentId || "claude";
    const loadedDistros = await ensureDistrosLoaded();
    const preferredDistro =
      (settings.workspace.defaultDistro.trim() && loadedDistros.includes(settings.workspace.defaultDistro.trim())
        ? settings.workspace.defaultDistro.trim()
        : "") ||
      loadedDistros[0] ||
      "";

    if (preferredDistro) {
      await selectDistro(preferredDistro);
    }
  }

  function selectHistory(entry: TabHistoryEntry) {
    onOpenHistory(entry);
    if (!embedded) {
      resetToHome();
    }
  }

  function recordNavigation(path: string) {
    if (navigationHistory[navigationIndex] === path) return;
    navigationHistory = [...navigationHistory.slice(0, navigationIndex + 1), path];
    navigationIndex = navigationHistory.length - 1;
  }

  async function navigateTo(path: string, options: { recordHistory?: boolean } = {}) {
    currentPath = path;
    selectedPath = path;
    pathInput = path;
    if (options.recordHistory !== false) {
      recordNavigation(path);
    }
    loading = true;
    error = "";
    try {
      directories = await listWslDirectories(selectedDistro, path);
    } catch (e) {
      error = `${t("launcher.error.loadDirectories")}: ${e}`;
      directories = [];
    } finally {
      loading = false;
    }
  }

  function goUp() {
    const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
    void navigateTo(parent);
  }

  function goBackHistory() {
    if (navigationIndex <= 0) return;
    navigationIndex -= 1;
    void navigateTo(navigationHistory[navigationIndex], { recordHistory: false });
  }

  function goForwardHistory() {
    if (navigationIndex >= navigationHistory.length - 1) return;
    navigationIndex += 1;
    void navigateTo(navigationHistory[navigationIndex], { recordHistory: false });
  }

  function openSelectedDirectory() {
    void navigateTo(pathInput.trim() || selectedPath || currentPath);
  }

  function confirmDirectory() {
    onConfirm(selectedAgentId, selectedDistro, pathInput.trim() || selectedPath || currentPath);
    resetToHome();
  }

  function handlePathKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      void navigateTo(pathInput);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!visible) return;
    if (e.key !== "Escape") return;

    if (agentPickerOpen) {
      agentPickerOpen = false;
      return;
    }

    if (distroPickerOpen) {
      distroPickerOpen = false;
      return;
    }

    if (step !== "home") {
      resetToHome();
      return;
    }

    if (!embedded) {
      onCancel();
    }
  }

  function handleMouseHistory(e: MouseEvent) {
    if (!visible || step !== "browser") return;
    if (e.button === 3) {
      e.preventDefault();
      goBackHistory();
    } else if (e.button === 4) {
      e.preventDefault();
      goForwardHistory();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} onmouseup={handleMouseHistory} />

<div
  class:overlay={!embedded}
  class:browser-overlay={!embedded && step === "browser"}
  class:embedded-shell={embedded}
  data-testid={TEST_IDS.sessionLauncher}
  style:display={visible ? (embedded ? "block" : "flex") : "none"}
>
  <div class:panel={embedded} class:dialog={!embedded} class:browser-dialog={!embedded && step === "browser"}>
    {#if step === "home"}
      <div class="launcher-shell">
        <header class="hero">
          <div class="hero-copy">
            <p class="eyebrow">{t("launcher.home.eyebrow")}</p>
            <h1>{t("launcher.home.title")}</h1>
            <p class="hero-description">{t("launcher.home.description")}</p>
          </div>

          <div class="hero-actions">
            <button
              class="primary-action"
              data-testid={TEST_IDS.launcherNewSession}
              onclick={beginNewSession}
            >
              <span class="primary-plus" aria-hidden="true">+</span>
              <span>{t("launcher.home.newSession")}</span>
            </button>
            <p class="shortcut">
              {t("launcher.home.shortcutPrefix")}
              <kbd>Ctrl</kbd>+<kbd>T</kbd>
            </p>
          </div>
        </header>

        <section class="surface recent-surface">
          <div class="section-header">
            <div>
              <p class="section-kicker">{t("launcher.recent.eyebrow")}</p>
              <h2>{t("launcher.recent.title")}</h2>
            </div>
            <span class="section-count">{historyEntries.length}</span>
          </div>

          {#if historyEntries.length === 0}
            <div class="empty-state">
              <div>
                <strong>{t("launcher.recent.emptyTitle")}</strong>
                <p>{t("launcher.recent.emptyDescription")}</p>
              </div>
              <button class="ghost-action" onclick={beginNewSession}>
                {t("launcher.home.newSession")}
              </button>
            </div>
          {:else}
            <div class="recent-list" data-testid={TEST_IDS.launcherRecentList}>
              {#each historyEntries as entry, index (((entry.resumeToken ?? "path") + "::" + (entry.agentId ?? "claude") + "::" + entry.distro + "::" + entry.workDir + "::" + entry.lastOpenedAt))}
                <button
                  class="recent-item"
                  data-testid={launcherHistoryItemTestId(index)}
                  onclick={() => selectHistory(entry)}
                >
                  <div class="recent-header">
                    <span class="recent-title-row">
                      <AgentIcon agentId={entry.agentId ?? "claude"} />
                      <span class="recent-title">{entry.title}</span>
                    </span>
                    <span class="recent-meta">{getAgentLabel(entry.agentId ?? "claude")} · {entry.distro}</span>
                  </div>
                  <span class="recent-path" title={entry.workDir}>{entry.workDir}</span>
                  {#if entry.resumeToken}
                    <span class="recent-token" title={entry.resumeToken}>
                      {getAgentLabel(entry.agentId ?? "claude")} · {getAgentDefinition(entry.agentId ?? "claude").resumeTokenLabel} · {summarizeResumeToken(entry.resumeToken)}
                    </span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {:else}
      <div class="browser-shell">
        <div class="surface browser-header">
          <div>
            <p class="section-kicker">{t("launcher.home.eyebrow")}</p>
            <h2>{t("launcher.home.newSession")}</h2>
            <p class="browser-description">{t("launcher.home.description")}</p>
          </div>
          <button class="ghost-action" onclick={resetToHome}>
            {t("launcher.nav.back")}
          </button>
        </div>

        <div class="browser-grid">
          <section class="surface browser-panel browser-main">
            <div class="panel-header">
              <div>
                <p class="section-kicker">{t("launcher.directory.eyebrow")}</p>
                <h3>{t("launcher.directory.title")}</h3>
              </div>
              <div class="header-controls">
                <button
                  class="picker-badge agent-trigger"
                  data-testid={TEST_IDS.launcherAgentTrigger}
                  onclick={() => { agentPickerOpen = true; }}
                >
                  <AgentIcon agentId={selectedAgentId} size="sm" />
                  <span>{getAgentLabel(selectedAgentId)}</span>
                </button>
                <button
                  class="picker-badge distro-trigger"
                  data-testid={TEST_IDS.launcherDistroTrigger}
                  onclick={() => { distroPickerOpen = true; }}
                >
                  {selectedDistro}
                </button>
              </div>
            </div>

            <div class="workspace-meta inset-surface">
              <div class="workspace-toolbar">
                <div class="path-bar">
                  <button class="path-btn" onclick={goUp} title={t("launcher.directory.goUp")}>↑</button>
                  <input
                    class="path-input"
                    data-testid={TEST_IDS.launcherPathInput}
                    type="text"
                    bind:value={pathInput}
                    onkeydown={handlePathKeydown}
                  />
                  <button class="path-btn primary" onclick={openSelectedDirectory}>
                    {t("launcher.directory.go")}
                  </button>
                </div>

                <div class="selection-actions">
                  <button
                    class="ghost-action secondary-action"
                    data-testid={TEST_IDS.launcherOpenSelection}
                    onclick={openSelectedDirectory}
                    disabled={!selectedDistro}
                  >
                    {t("launcher.directory.openSelected")}
                  </button>
                  <button
                    class="primary-action compact"
                    data-testid={TEST_IDS.launcherOpenHere}
                    onclick={confirmDirectory}
                    disabled={!selectedDistro}
                  >
                    {t("launcher.directory.openHere")}
                  </button>
                </div>
              </div>
            </div>

            {#if loading}
              <div class="status-card">{t("launcher.directory.loading")}</div>
            {:else if error}
              <div class="status-card error">{error}</div>
            {:else}
              <div class="inset-surface list-frame">
                <div class="list directory-list" data-testid={TEST_IDS.launcherDirectoryList}>
                  {#if currentPath !== "/"}
                    <button
                      class="list-item directory-item parent-item"
                      data-testid={launcherDirectoryTestId(`${currentPath.replace(/\/[^/]+\/?$/, "") || "/"}`)}
                      ondblclick={goUp}
                      onclick={() => {
                        const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
                        selectedPath = parent;
                        pathInput = parent;
                      }}
                    >
                      <span class="icon" aria-hidden="true">↰</span>
                      <span class="list-title">..</span>
                      <span class="list-hint">{currentPath.replace(/\/[^/]+\/?$/, "") || "/"}</span>
                    </button>
                  {/if}
                  {#each directories as dir}
                    <button
                      class="list-item directory-item"
                      class:selected={dir.path === (pathInput.trim() || selectedPath)}
                      data-testid={launcherDirectoryTestId(dir.path)}
                      ondblclick={() => {
                        selectedPath = dir.path;
                        pathInput = dir.path;
                        openSelectedDirectory();
                      }}
                      onclick={() => {
                        selectedPath = dir.path;
                        pathInput = dir.path;
                      }}
                    >
                      <span class="icon" aria-hidden="true">⌁</span>
                      <span class="list-title">{dir.name}</span>
                      <span class="list-hint" title={dir.path}>{dir.path}</span>
                    </button>
                  {/each}
                  {#if directories.length === 0}
                    <div class="empty-state compact">{t("launcher.directory.empty")}</div>
                  {/if}
                </div>
              </div>
            {/if}
          </section>
        </div>
      </div>
    {/if}
  </div>
</div>

{#if visible && step === "browser" && agentPickerOpen}
  <div
    class="picker-overlay"
    role="presentation"
    tabindex="-1"
  >
    <div
    class="picker-dialog surface"
      data-testid={TEST_IDS.launcherAgentPicker}
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onpointerdown={(e) => e.stopPropagation()}
    >
      <div class="panel-header">
        <div>
          <p class="section-kicker">{t("launcher.agent.eyebrow")}</p>
          <h3>{t("launcher.agent.title")}</h3>
        </div>
        <button class="ghost-action" onclick={() => { agentPickerOpen = false; }}>
          {t("common.actions.close")}
        </button>
      </div>

      <div class="inset-surface list-frame picker-list-frame">
        <div class="list agent-list" data-testid={TEST_IDS.launcherAgentList}>
          {#each builtinAgents as agent}
            <button
              class="list-item agent-picker-item"
              class:selected={agent.id === selectedAgentId}
              data-testid={launcherAgentTestId(agent.id)}
              onclick={() => {
                selectedAgentId = agent.id;
                agentPickerOpen = false;
              }}
            >
              <AgentIcon agentId={agent.id} size="md" />
              <span class="list-copy">
                <span class="list-title">{agent.label}</span>
                <span class="list-hint">{t("launcher.agent.selectHint")}</span>
              </span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

{#if visible && step === "browser" && distroPickerOpen}
  <div
    class="picker-overlay"
    role="presentation"
    tabindex="-1"
  >
    <div
      class="picker-dialog surface"
      data-testid={TEST_IDS.launcherDistroPicker}
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onpointerdown={(e) => e.stopPropagation()}
    >
      <div class="panel-header">
        <div>
          <p class="section-kicker">{t("launcher.distro.eyebrow")}</p>
          <h3>{t("launcher.distro.title")}</h3>
        </div>
        <button class="ghost-action" onclick={() => { distroPickerOpen = false; }}>
          {t("common.actions.close")}
        </button>
      </div>

      {#if loading && distros.length === 0}
        <div class="status-card">{t("launcher.distro.loading")}</div>
      {:else if error && distros.length === 0}
        <div class="status-card error">{error}</div>
      {:else}
        <div class="inset-surface list-frame picker-list-frame">
          <div class="list distro-list" data-testid={TEST_IDS.launcherDistroList}>
            {#each distros as distro}
              <button
                class="list-item distro-item"
                class:selected={distro === selectedDistro}
                data-testid={launcherDistroTestId(distro)}
                onclick={() => {
                  void selectDistro(distro);
                  distroPickerOpen = false;
                }}
              >
                <span class="icon" aria-hidden="true">⌘</span>
                <span class="list-copy">
                  <span class="list-title">{distro}</span>
                  <span class="list-hint">{t("launcher.distro.selectHint")}</span>
                </span>
                {#if distro === settings.workspace.defaultDistro}
                  <span class="item-badge">{t("launcher.distro.defaultBadge")}</span>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    padding: calc(28px * var(--ui-scale));
    background:
      linear-gradient(180deg, rgba(2, 6, 23, 0.48), rgba(2, 6, 23, 0.68)),
      color-mix(in srgb, var(--app-bg) 80%, black 20%);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    backdrop-filter: blur(18px) saturate(120%);
  }

  .browser-overlay {
    align-items: flex-start;
  }

  .embedded-shell {
    width: 100%;
    height: 100%;
    padding: calc(24px * var(--ui-scale));
    box-sizing: border-box;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  .dialog,
  .panel {
    color: var(--tab-text);
  }

  .dialog {
    width: min(980px, calc(100vw - 32px));
    max-height: min(820px, calc(100vh - 32px));
    padding: 0;
    display: flex;
    align-items: stretch;
    animation: launcher-in 160ms ease-out;
    overflow: hidden;
  }

  .dialog.browser-dialog {
    height: min(820px, calc(100vh - 32px));
  }

  .dialog > .launcher-shell {
    width: 100%;
    min-height: 0;
  }

  .dialog > .browser-shell,
  .panel > .browser-shell {
    width: 100%;
    flex: 1;
    min-height: 0;
  }

  .panel {
    width: min(1080px, 100%);
    height: 100%;
    flex: 1;
    margin: 0 auto;
    border: none;
    background: transparent;
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-5);
    overflow: hidden;
    min-height: 0;
  }

  .launcher-shell,
  .browser-shell {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-4);
    width: 100%;
    min-height: 0;
  }

  .launcher-shell {
    padding: calc(26px * var(--ui-scale));
    border-radius: var(--ui-radius-xl);
    border: 1px solid color-mix(in srgb, var(--tab-border) 78%, white 22%);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--tab-bg) 92%, white 8%), var(--tab-bg)),
      radial-gradient(circle at top right, rgba(137, 180, 250, 0.08), transparent 32%),
      radial-gradient(circle at bottom left, rgba(148, 163, 184, 0.06), transparent 28%);
    box-shadow: 0 24px 48px rgba(2, 6, 23, 0.38);
  }

  .browser-shell {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    flex: 1;
    height: 100%;
    padding: var(--ui-space-2) 2px 0;
    overflow: hidden;
  }

  .picker-overlay {
    position: fixed;
    inset: 0;
    z-index: 140;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: calc(28px * var(--ui-scale));
    background: linear-gradient(180deg, rgba(2, 6, 23, 0.22), rgba(2, 6, 23, 0.38));
    backdrop-filter: blur(10px) saturate(120%);
  }

  .picker-dialog {
    width: min(460px, calc(100vw - 48px));
    max-height: min(620px, calc(100vh - 56px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 24px 48px rgba(2, 6, 23, 0.28);
  }

  .hero,
  .path-bar,
  .workspace-meta,
  .workspace-toolbar {
    display: flex;
    align-items: center;
    gap: var(--ui-space-3);
  }

  .hero {
    justify-content: space-between;
  }

  .browser-header,
  .browser-grid,
  .browser-panel,
  .panel-header,
  .selection-actions,
  .recent-title-row {
    display: flex;
    gap: var(--ui-space-3);
  }

  .browser-header,
  .panel-header {
    justify-content: space-between;
    align-items: center;
  }

  .recent-title-row {
    align-items: center;
    min-width: 0;
  }

  .recent-token {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ui-text-muted);
    font-size: 12px;
    margin-top: 4px;
  }

  .browser-header {
    padding: calc(18px * var(--ui-scale)) calc(22px * var(--ui-scale));
  }

  .browser-grid {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }

  .browser-main {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas:
      "header"
      "meta"
      "body";
    align-items: stretch;
    row-gap: var(--ui-space-3);
    min-width: 0;
    min-height: 0;
    flex: 1;
  }

  .browser-panel {
    min-height: 0;
    overflow: hidden;
  }

  .panel-header {
    padding: calc(18px * var(--ui-scale)) calc(20px * var(--ui-scale));
    border-bottom: 1px solid color-mix(in srgb, var(--tab-border) 76%, white 24%);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--tab-bg) 94%, white 6%),
      color-mix(in srgb, var(--tab-bg) 88%, white 12%)
    );
  }

  .browser-main > .panel-header {
    grid-area: header;
  }

  .header-controls {
    display: inline-flex;
    align-items: center;
    gap: var(--ui-space-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .panel-header h3 {
    margin: 0;
    font-size: calc(var(--ui-font-size-lg) * 1.08);
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .browser-header h2 {
    margin: 0;
    font-size: clamp(calc(22px * var(--ui-scale)), 2.4vw, calc(30px * var(--ui-scale)));
    line-height: 1.15;
    letter-spacing: -0.03em;
  }

  .browser-description {
    margin: 10px 0 0;
    opacity: 0.78;
    font-size: calc(var(--ui-font-size-base) * 1.02);
    line-height: 1.6;
  }

  .hero {
    align-items: end;
    gap: var(--ui-space-6);
    flex-wrap: wrap;
  }

  .hero-copy {
    max-width: 640px;
  }

  .eyebrow,
  .section-kicker {
    margin: 0 0 6px;
    font-size: calc(var(--ui-font-size-xs) * 1.06);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    opacity: 0.68;
  }

  .hero h1,
  .section-header h2 {
    margin: 0;
    color: var(--tab-text);
  }

  .hero h1 {
    font-size: clamp(calc(28px * var(--ui-scale)), 4vw, calc(42px * var(--ui-scale)));
    font-weight: 600;
    letter-spacing: -0.03em;
    margin-bottom: var(--ui-space-3);
  }

  .hero-description,
  .shortcut,
  .recent-meta,
  .recent-path,
  .list-hint {
    opacity: 0.72;
  }

  .hero-description {
    max-width: 58ch;
    margin: 0;
    font-size: var(--ui-font-size-base);
    line-height: 1.6;
  }

  .hero-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--ui-space-3);
    margin-left: auto;
  }

  .primary-action {
    display: inline-flex;
    align-items: center;
    gap: var(--ui-space-3);
    padding: var(--ui-space-3) calc(18px * var(--ui-scale));
    border: 1px solid color-mix(in srgb, var(--tab-border) 70%, white 30%);
    border-radius: var(--ui-radius-lg);
    cursor: pointer;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--tab-active-bg) 92%, white 8%), var(--tab-active-bg));
    color: var(--tab-text);
    font-size: var(--ui-font-size-base);
    font-weight: 600;
    box-shadow: 0 10px 22px rgba(2, 6, 23, 0.18);
  }

  .primary-action.compact {
    padding-inline: 16px;
  }

  .primary-plus {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    transform: translateY(-1px);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
  }

  .ghost-action,
  .path-btn {
    border: 1px solid var(--tab-border);
    border-radius: var(--ui-radius-md);
    cursor: pointer;
    background: transparent;
    color: var(--tab-text);
  }

  .ghost-action {
    padding: calc(10px * var(--ui-scale)) var(--ui-space-3);
    opacity: 0.82;
  }

  .secondary-action {
    background: color-mix(in srgb, var(--tab-active-bg) 70%, white 30%);
    border-color: color-mix(in srgb, var(--tab-border) 52%, white 48%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
    opacity: 1;
    font-weight: 600;
  }

  .primary-action:hover,
  .ghost-action:hover,
  .path-btn:hover,
  .list-item:hover,
  .recent-item:hover {
    background: color-mix(in srgb, var(--tab-active-bg) 88%, white 12%);
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
  }

  .recent-surface .section-header {
    padding: var(--ui-space-4) calc(18px * var(--ui-scale)) var(--ui-space-3);
  }

  .section-header h2 {
    font-size: calc(var(--ui-font-size-lg) * 1.04);
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .section-count {
    min-width: 32px;
    padding: var(--ui-space-1) var(--ui-space-3);
    border-radius: 999px;
    background: color-mix(in srgb, var(--tab-active-bg) 78%, white 22%);
    text-align: center;
    font-size: var(--ui-font-size-sm);
    opacity: 0.88;
  }

  .surface {
    border: 1px solid color-mix(in srgb, var(--tab-border) 80%, white 20%);
    border-radius: var(--ui-radius-xl);
    overflow: hidden;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--tab-bg) 88%, white 12%), var(--tab-bg));
    box-shadow: 0 16px 34px rgba(2, 6, 23, 0.16);
    min-height: 0;
  }

  .recent-surface {
    display: flex;
    flex-direction: column;
    gap: 0;
    overflow: hidden;
  }

  .recent-list,
  .list {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    max-height: min(460px, 52vh);
    scrollbar-gutter: stable;
  }

  .browser-main .list {
    flex: 1;
    max-height: none;
  }

  .recent-item,
  .list-item {
    width: 100%;
    padding: calc(14px * var(--ui-scale)) calc(16px * var(--ui-scale));
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--tab-border);
    text-align: left;
    color: var(--tab-text);
    cursor: pointer;
  }

  .list-item.selected {
    border-color: color-mix(in srgb, var(--ui-accent) 40%, var(--ui-border-strong));
    background: color-mix(in srgb, var(--ui-accent-soft) 68%, var(--ui-bg-surface));
  }

  .list-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .recent-item:last-child,
  .list-item:last-child {
    border-bottom: none;
  }

  .recent-item {
    display: grid;
    gap: 6px;
  }

  .recent-title {
    font-size: var(--ui-font-size-md);
    font-weight: 500;
  }

  .recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .recent-meta,
  .recent-path,
  .shortcut,
  .list-hint {
    font-size: var(--ui-font-size-sm);
  }

  .recent-path,
  .list-hint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .list-item {
    display: flex;
    align-items: center;
    gap: var(--ui-space-3);
    font-size: calc(var(--ui-font-size-base) * 1.02);
  }

  .distro-item {
    align-items: flex-start;
  }

  .item-badge {
    align-self: center;
    margin-left: auto;
    padding: 4px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-accent-soft) 82%, var(--ui-bg-surface));
    color: var(--ui-text-secondary);
    font-size: var(--ui-font-size-xs);
    white-space: nowrap;
  }

  .icon {
    flex-shrink: 0;
    width: 24px;
    text-align: center;
    opacity: 0.82;
  }

  .workspace-meta {
    grid-area: meta;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    padding: calc(12px * var(--ui-scale)) calc(14px * var(--ui-scale));
    margin: 0 0 var(--ui-space-3);
    min-width: 0;
    align-self: start;
  }

  .workspace-toolbar {
    justify-content: space-between;
    align-items: center;
    gap: var(--ui-space-3);
    flex-wrap: wrap;
  }

  .inset-surface {
    border: 1px solid color-mix(in srgb, var(--tab-border) 84%, white 16%);
    border-radius: var(--ui-radius-lg);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--tab-active-bg) 52%, var(--tab-bg)),
      color-mix(in srgb, var(--tab-bg) 90%, black 10%)
    );
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .path-bar {
    display: flex;
    gap: var(--ui-space-2);
    align-items: center;
    flex: 1 1 auto;
    min-width: min(100%, 360px);
  }

  .path-input {
    flex: 1;
    min-width: 0;
    padding: calc(10px * var(--ui-scale)) var(--ui-space-3);
    border-radius: var(--ui-radius-md);
    border: 1px solid var(--tab-border);
    background: color-mix(in srgb, var(--tab-active-bg) 82%, black 18%);
    color: var(--tab-text);
    font-family: monospace;
  }

  .path-btn {
    padding: calc(10px * var(--ui-scale)) calc(13px * var(--ui-scale));
    background: transparent;
    color: var(--tab-text);
  }

  .path-btn.primary {
    background: color-mix(in srgb, var(--tab-active-bg) 88%, white 12%);
  }

  .selection-actions {
    margin-left: auto;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .picker-dialog .panel-header {
    padding-bottom: calc(16px * var(--ui-scale));
  }

  .picker-list-frame {
    margin: 0 calc(14px * var(--ui-scale)) calc(14px * var(--ui-scale));
  }

  .agent-list,
  .distro-list {
    gap: 0;
  }

  .agent-picker-item,
  .distro-item {
    align-items: center;
    padding-block: calc(13px * var(--ui-scale));
  }

  .empty-state,
  .error {
    padding: calc(18px * var(--ui-scale)) calc(20px * var(--ui-scale));
    font-size: var(--ui-font-size-base);
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-4);
  }

  .empty-state p {
    margin-top: 6px;
    opacity: 0.74;
  }

  .compact {
    padding: var(--ui-space-3) var(--ui-space-4);
  }

  .status-card {
    padding: var(--ui-space-4) calc(18px * var(--ui-scale));
    border-radius: var(--ui-radius-lg);
    border: 1px solid var(--tab-border);
    background: color-mix(in srgb, var(--tab-bg) 84%, white 16%);
    opacity: 0.9;
  }

  .browser-main > .status-card {
    grid-area: body;
    margin: 0;
  }

  .error {
    color: #f38ba8;
  }

  .directory-item {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    grid-template-rows: auto auto;
    column-gap: var(--ui-space-3);
    row-gap: var(--ui-space-1);
  }

  .directory-item .list-title {
    grid-column: 2;
  }

  .directory-item .list-hint {
    grid-column: 2;
  }

  .list-frame {
    grid-area: body;
    margin: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: 100%;
    min-height: 0;
  }

  .browser-main > .list-frame {
    min-height: 0;
  }

  .directory-list {
    max-height: none;
    min-height: 100%;
    flex: 1;
    height: 100%;
  }

  .directory-list .list-item {
    padding-block: calc(11px * var(--ui-scale));
  }

  .distro-list {
    flex: 1;
    min-height: 0;
    max-height: none;
    height: auto;
  }

  .agent-list {
    flex: 1;
    min-height: 0;
    max-height: none;
    height: auto;
  }

  .parent-item {
    background: color-mix(in srgb, var(--tab-active-bg) 36%, var(--tab-bg));
  }

  .picker-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--ui-space-2);
    align-self: flex-start;
    min-height: calc(36px * var(--ui-scale));
    padding: calc(7px * var(--ui-scale)) var(--ui-space-3);
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--tab-border) 72%, white 28%);
    background: color-mix(in srgb, var(--tab-active-bg) 82%, white 18%);
    color: var(--tab-text);
    font-size: calc(var(--ui-font-size-sm) * 1.02);
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease,
      transform 120ms ease;
  }

  .picker-badge:hover {
    background: color-mix(in srgb, var(--tab-active-bg) 90%, white 10%);
    border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--tab-border));
    box-shadow: 0 6px 16px rgba(2, 6, 23, 0.12);
  }

  .picker-badge:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--ui-accent-soft) 70%, transparent),
      0 6px 16px rgba(2, 6, 23, 0.12);
  }

  .picker-badge :global(.agent-icon) {
    flex-shrink: 0;
  }

  .distro-trigger {
    font-family: inherit;
  }

  .picker-list-frame {
    margin: 0 calc(14px * var(--ui-scale)) calc(14px * var(--ui-scale));
    grid-area: auto;
  }

  @media (max-width: 920px) {
    .browser-grid {
      display: flex;
      flex-direction: column;
    }

    .browser-main {
      display: grid;
      grid-template-columns: 1fr;
      grid-template-rows: auto auto auto minmax(0, 1fr);
      grid-template-areas:
        "header"
        "meta"
        "status"
        "body";
    }

    .browser-main > .status-card {
      grid-area: status;
    }

    .browser-main > .panel-header {
      grid-area: header;
    }

    .workspace-meta {
      grid-area: meta;
    }

    .list-frame {
      grid-area: body;
    }

    .selection-actions {
      width: 100%;
      justify-content: stretch;
      margin-left: 0;
    }

    .selection-actions :global(button) {
      flex: 1;
    }
  }

  @keyframes launcher-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.99);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
</style>
