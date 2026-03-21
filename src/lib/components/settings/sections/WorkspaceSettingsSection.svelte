<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import Button from "../../../ui/components/Button.svelte";
  import { getBuiltinAgents } from "../../../agents";
  import { listWslDistros } from "../../../wsl";
  import { getSettings, updateSettings } from "../../../stores/settings.svelte";

  const settings = getSettings();
  const builtinAgents = getBuiltinAgents();

  let distros = $state<string[]>([]);
  let loading = $state(false);
  let error = $state("");
  let editorDistro = $state("");

  const availableDistros = $derived.by(() => {
    const values = new Set<string>();
    for (const distro of distros) values.add(distro);
    if (settings.workspace.defaultDistro) values.add(settings.workspace.defaultDistro);
    for (const distro of Object.keys(settings.workspace.defaultStartPathsByDistro)) {
      values.add(distro);
    }
    return Array.from(values);
  });

  $effect(() => {
    if (distros.length > 0 || loading) return;
    loading = true;
    error = "";
    void listWslDistros()
      .then((items) => {
        distros = items;
      })
      .catch((reason) => {
        error = `${$t("launcher.error.loadDistros")}: ${reason}`;
      })
      .finally(() => {
        loading = false;
      });
  });

  $effect(() => {
    const preferred = settings.workspace.defaultDistro || availableDistros[0] || "";
    if (!editorDistro && preferred) {
      editorDistro = preferred;
    }
    if (editorDistro && !availableDistros.includes(editorDistro)) {
      editorDistro = preferred;
    }
  });

  function updateDefaultDistro(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    updateSettings({
      workspace: {
        defaultDistro: value,
      },
    });
    if (!editorDistro) {
      editorDistro = value;
    }
  }

  function updateDefaultAgent(event: Event) {
    updateSettings({
      workspace: {
        defaultAgentId: (event.target as HTMLSelectElement).value,
      },
    });
  }

  function updateEditorDistro(event: Event) {
    editorDistro = (event.target as HTMLSelectElement).value;
  }

  function updateStartPath(value: string) {
    if (!editorDistro) return;
    const next = { ...settings.workspace.defaultStartPathsByDistro };
    const normalized = value.trim();
    if (normalized) {
      next[editorDistro] = normalized;
    } else {
      delete next[editorDistro];
    }
    updateSettings({
      workspace: {
        defaultStartPathsByDistro: next,
      },
    });
  }
</script>

<div class="settings-fields">
  <div class="field">
    <label for="workspace-default-agent">{$t("settings.fields.defaultAgent")}</label>
    <select
      id="workspace-default-agent"
      class="number-input"
      value={settings.workspace.defaultAgentId}
      onchange={updateDefaultAgent}
    >
      {#each builtinAgents as agent}
        <option value={agent.id}>{agent.label}</option>
      {/each}
    </select>
    <p class="field-message">{$t("settings.fields.defaultAgentHint")}</p>
  </div>

  <div class="field">
    <label for="workspace-default-distro">{$t("settings.fields.defaultDistro")}</label>
    <select
      id="workspace-default-distro"
      class="number-input"
      value={settings.workspace.defaultDistro}
      onchange={updateDefaultDistro}
    >
      <option value="">{$t("settings.workspace.none")}</option>
      {#each availableDistros as distro}
        <option value={distro}>{distro}</option>
      {/each}
    </select>
    <p class="field-message">{$t("settings.fields.defaultDistroHint")}</p>
  </div>

  <div class="field-block">
    <div class="field-head">
      <h4>{$t("settings.fields.defaultStartPath")}</h4>
      <p>{$t("settings.fields.defaultStartPathHint")}</p>
    </div>

    <div class="field-grid">
      <div class="field">
        <label for="workspace-path-distro">{$t("settings.fields.pathPresetDistro")}</label>
        <select
          id="workspace-path-distro"
          class="number-input"
          value={editorDistro}
          onchange={updateEditorDistro}
          disabled={availableDistros.length === 0}
        >
          {#if availableDistros.length === 0}
            <option value="">{$t("settings.workspace.none")}</option>
          {:else}
            {#each availableDistros as distro}
              <option value={distro}>{distro}</option>
            {/each}
          {/if}
        </select>
      </div>

      <div class="field path-field">
        <label for="workspace-default-path">{$t("settings.fields.defaultStartPathValue")}</label>
        <div class="path-row">
          <input
            id="workspace-default-path"
            class="number-input path-input"
            type="text"
            disabled={!editorDistro}
            value={editorDistro ? (settings.workspace.defaultStartPathsByDistro[editorDistro] ?? "") : ""}
            oninput={(event) => updateStartPath((event.target as HTMLInputElement).value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!editorDistro || !settings.workspace.defaultStartPathsByDistro[editorDistro]}
            onclick={() => updateStartPath("")}
          >
            {$t("settings.workspace.clearPath")}
          </Button>
        </div>
      </div>
    </div>

    {#if loading}
      <p class="field-message">{$t("launcher.distro.loading")}</p>
    {:else if error}
      <p class="field-message">{error}</p>
    {/if}
  </div>
</div>

<style>
  .path-field {
    grid-column: span 2;
  }

  .path-row {
    display: flex;
    align-items: center;
    gap: var(--ui-space-3);
  }

  .path-input {
    flex: 1;
    min-width: 0;
  }
</style>
