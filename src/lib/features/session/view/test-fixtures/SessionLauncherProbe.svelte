<script lang="ts">
  import type { AgentId } from "../../../../agents";
  import type { TabHistoryEntry } from "../../../../types";

  interface Props {
    visible: boolean;
    embedded?: boolean;
    historyEntries: TabHistoryEntry[];
    onOpenHistory: (entry: TabHistoryEntry) => void;
    onConfirm: (agentId: AgentId, distro: string, workDir: string) => void;
  }

  let {
    visible,
    embedded = false,
    historyEntries,
    onOpenHistory,
    onConfirm,
  }: Props = $props();
</script>

<button
  data-testid="session-launcher-probe"
  data-visible={String(visible)}
  data-embedded={String(embedded)}
  onclick={() => {
    if (historyEntries[0]) {
      onOpenHistory(historyEntries[0]);
      return;
    }

    onConfirm("claude", "Ubuntu", "/workspace/new");
  }}
>
  launcher-probe
</button>
