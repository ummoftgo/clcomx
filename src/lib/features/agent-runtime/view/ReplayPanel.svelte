<!--
  ReplayPanel — 격리 scrollback replay 뷰(read-only history inspection, T5.6).

  정본: 10 §4.7, 08 §7.2. evicted-tombstone 구간을 사용자가 명시적으로 열 때만 동작하는 read-only
  조회 패널이다. `runtime-replay.ts`의 ReplayLoader로 격리 scratch 세션을 1회 조회해 **별도 scratch
  TranscriptModel**(live 미병합)을 렌더한다. 조회가 끝나면 loader.dispose로 scratch를 폐기한다.

  **read-only 보장**: sendPrompt/respondApproval/composer를 노출하지 않는다(running 세션 비충돌).
  canLoad가 아니면 "사용 불가" notice만 표시한다. 문자열은 i18n 키만 쓴다.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { t } from "../../../i18n";
  import { TEST_IDS, agentTranscriptItemTestId } from "../../../testids";
  import type { TranscriptItem, TranscriptModel } from "../contracts/transcript";
  import {
    loadReplayTranscript,
    type ReplayLoader,
  } from "../service/runtime-replay";
  import MessageBubble from "./MessageBubble.svelte";
  import PlanBlock from "./PlanBlock.svelte";
  import ToolCallCard from "./tool-cards/ToolCallCard.svelte";
  import FileDiffCard from "./tool-cards/FileDiffCard.svelte";

  interface Props {
    /** 격리 scratch replay loader(read-only). */
    loader: ReplayLoader;
    /** 패널 닫기 콜백(호출부가 unmount). */
    onClose: () => void;
  }

  let { loader, onClose }: Props = $props();

  // 조회 상태: 로딩 → 결과 scratch transcript(또는 사용 불가/빈 결과).
  let loading = $state(true);
  let scratch = $state<TranscriptModel | null>(null);
  let unavailable = $state(false);
  let truncated = $state(false);
  let disposed = false;

  // 진입 시 1회 조회(canLoad면 read-only 격리 조회, 아니면 "사용 불가").
  $effect(() => {
    let cancelled = false;
    if (!loader.canLoad()) {
      unavailable = true;
      loading = false;
      return;
    }
    void loadReplayTranscript(loader)
      .then((result) => {
        if (cancelled) return;
        scratch = result.transcript;
        truncated = result.truncated;
        loading = false;
        disposeScratch();
      })
      .catch(() => {
        if (cancelled) return;
        unavailable = true;
        loading = false;
        disposeScratch();
      });
    return () => {
      cancelled = true;
    };
  });

  // scratch transcript의 표시 item을 read-only로 소싱(live store와 분리).
  const rows = $derived.by<TranscriptItem[]>(() => {
    if (!scratch) return [];
    return scratch.visibleItemIds
      .map((id) => scratch!.itemsById.get(id))
      .filter((it): it is TranscriptItem => it !== undefined);
  });

  /** scratch 세션 폐기를 한 번만 수행해 close 후 unmount의 중복 shutdown을 막는다. */
  function disposeScratch(): void {
    if (disposed) return;
    disposed = true;
    void loader.dispose();
  }

  /** 닫기 → 남은 scratch를 보조 폐기 후 onClose. */
  function close(): void {
    disposeScratch();
    onClose();
  }

  // 컴포넌트 unmount 시에도 scratch 세션을 폐기한다(누수 방지).
  onDestroy(() => {
    disposeScratch();
  });
</script>

<div class="replay-panel" data-testid={TEST_IDS.agentReplayPanel} role="dialog" aria-label={$t("agentRuntime.replay.panelTitle")}>
  <div class="replay-header">
    <span class="replay-title">{$t("agentRuntime.replay.panelTitle")}</span>
    <button
      type="button"
      class="replay-close"
      data-testid={TEST_IDS.agentReplayClose}
      onclick={close}
    >
      {$t("agentRuntime.replay.close")}
    </button>
  </div>

  <div class="replay-notice">{$t("agentRuntime.replay.readOnlyNotice")}</div>
  {#if truncated}
    <div class="replay-notice replay-notice-warning">{$t("agentRuntime.replay.truncated")}</div>
  {/if}

  <div class="replay-body">
    {#if loading}
      <div class="replay-status">{$t("agentRuntime.replay.loading")}</div>
    {:else if unavailable}
      <div class="replay-status">{$t("agentRuntime.replay.unavailable")}</div>
    {:else if rows.length === 0}
      <div class="replay-status">{$t("agentRuntime.replay.empty")}</div>
    {:else}
      {#each rows as item (item.id)}
        {#if item.type === "message"}
          <MessageBubble
            id={item.id}
            role={item.role}
            content={item.content}
            streaming={false}
          />
        {:else if item.type === "plan"}
          <PlanBlock entries={item.entries} />
        {:else if item.type === "tool_call"}
          <ToolCallCard id={item.id} update={item.update} expanded={false} />
        {:else if item.type === "file_change"}
          <div data-item-testid={agentTranscriptItemTestId(item.id)}>
            <FileDiffCard
              path={item.change.path}
              operation={item.change.operation}
              oldPath={item.change.oldPath}
              patch={item.change.diff}
            />
          </div>
        {:else if item.type === "notice"}
          <div class="transcript-notice" data-item-testid={agentTranscriptItemTestId(item.id)}>
            {$t(item.messageKey)}
          </div>
        {/if}
      {/each}
    {/if}
  </div>
</div>

<style>
  .replay-panel {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.3));
    border-radius: 0.5rem;
    background: var(--ui-bg-surface, rgba(127, 127, 127, 0.05));
    max-height: 60vh;
    overflow: hidden;
  }
  .replay-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.7rem;
    border-bottom: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.25));
  }
  .replay-title {
    font-size: var(--ui-font-size-sm);
    font-weight: 600;
  }
  .replay-close {
    font: inherit;
    font-size: var(--ui-font-size-sm);
    padding: 0.25rem 0.7rem;
    border-radius: 0.35rem;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.3));
    background: var(--ui-bg-app, transparent);
    color: inherit;
    cursor: pointer;
  }
  .replay-notice {
    padding: 0.35rem 0.7rem;
    font-size: var(--ui-font-size-xs);
    opacity: 0.6;
    border-bottom: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.15));
  }
  .replay-notice-warning {
    opacity: 0.75;
  }
  .replay-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6rem 0.7rem;
    overflow-y: auto;
  }
  .replay-status {
    opacity: 0.55;
    font-size: var(--ui-font-size-sm);
    text-align: center;
    padding: 1.5rem 0;
  }
  .transcript-notice {
    font-size: var(--ui-font-size-sm);
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    background: var(--ui-bg-surface, rgba(127, 127, 127, 0.06));
  }
</style>
