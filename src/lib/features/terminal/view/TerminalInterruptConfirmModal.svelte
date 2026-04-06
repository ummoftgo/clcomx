<script lang="ts">
  import { t } from "../../../i18n";
  import { Button, ModalShell } from "../../../ui";

  interface Props {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
  }

  let { open, onClose, onConfirm }: Props = $props();
</script>

<ModalShell {open} size="sm" {onClose}>
  <div class="terminal-interrupt-panel">
    <h2>{$t("terminal.interrupt.title")}</h2>
    <p>{$t("terminal.interrupt.description")}</p>
    <div class="terminal-interrupt-actions">
      <Button variant="danger" onclick={() => void onConfirm()}>
        {$t("terminal.interrupt.confirm")}
      </Button>
      <Button onclick={onClose}>
        {$t("common.actions.cancel")}
      </Button>
    </div>
  </div>
</ModalShell>

<style>
  .terminal-interrupt-panel {
    display: grid;
    gap: 16px;
    padding: 24px;
    color: var(--ui-text-primary, var(--tab-text));
  }

  .terminal-interrupt-panel h2 {
    margin: 0;
    font-size: 19px;
    line-height: 1.2;
    color: var(--ui-text-primary, var(--tab-text));
  }

  .terminal-interrupt-panel p {
    margin: 0;
    font-size: 14px;
    line-height: 1.55;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .terminal-interrupt-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 10px;
  }
</style>
