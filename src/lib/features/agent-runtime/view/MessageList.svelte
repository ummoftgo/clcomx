<!--
  MessageList — transcript item을 순서대로 렌더(08 §3, §7.2).

  visibleItemIds(반응형 표면, 순서·표시 대상)로 윈도잉하고 각 id의 body를 store.getItem(id)
  (plain Map, 비반응형)에서 소싱한다. delta는 itemVersions bump으로 반응을 트리거하므로,
  렌더 키에 itemVersions[id]를 섞어 streaming 시 점진 갱신이 반영되게 한다(08 §5).

  Stage 2: tool_call → ToolCallCard, file_change → FileDiffCard, inline approval(severity normal)을
  해당 tool 카드 하단에 렌더한다(08 §4). tool_call diff와 file_change_updated는 같은 base id로
  상관되므로(reducer: file_change:${toolCallId}), tool 카드에 매칭 file_change를 합쳐 한 카드로 보인다.
-->
<script lang="ts">
  import { TEST_IDS, agentTranscriptItemTestId } from "../../../testids";
  import { t } from "../../../i18n";
  import type { AgentRuntimeStore } from "../state/agent-runtime-store.svelte";
  import type { TranscriptItem } from "../contracts/transcript";
  import type { ApprovalDecision, ApprovalRequest } from "../contracts/normalized";
  import MessageBubble from "./MessageBubble.svelte";
  import PlanBlock from "./PlanBlock.svelte";
  import ToolCallCard from "./tool-cards/ToolCallCard.svelte";
  import FileDiffCard from "./tool-cards/FileDiffCard.svelte";
  import ApprovalInlineCard from "./ApprovalInlineCard.svelte";

  interface Props {
    /** 세션 store(반응형 표면 visibleItemIds/itemVersions + body 조회 getItem). */
    store: AgentRuntimeStore;
    /** inline approval 응답 콜백(controller.approve로 위임). 미지정 시 승인 UI 비활성. */
    onRespondApproval?: (decision: ApprovalDecision) => void;
  }

  let { store, onRespondApproval }: Props = $props();

  // 표면에 노출된 pending inline approval(severity normal)을 requestId/toolCallId로 매핑한다.
  // tool 카드 하단에 해당 toolCallId의 approval만 인라인으로 끼우기 위함(08 §4.4).
  const inlineApprovals = $derived<ApprovalRequest[]>(store.pendingApprovals);

  /** 주어진 tool_call id에 매칭되는 inline approval을 찾는다(toolCallId 기준). */
  function approvalForTool(toolId: string): ApprovalRequest | undefined {
    return inlineApprovals.find((a) => a.toolCallId === toolId);
  }

  /** file_change item을 별도 카드로 렌더할지 — 매칭 tool_call이 이미 흡수하면 숨긴다(08 §4.2 단일 카드). */
  function fileChangeAbsorbed(fileItemId: string): boolean {
    // file_change item id 형식: "file_change:<toolCallId|path>". toolCallId가 있으면 같은 tool 카드가 흡수.
    const base = fileItemId.startsWith("file_change:")
      ? fileItemId.slice("file_change:".length)
      : fileItemId;
    return store.getItem(base)?.type === "tool_call";
  }

  /** 렌더 row: id + version + body 스냅샷. ids/itemVersions 변화에 모두 반응해 재계산된다(08 §5). */
  interface Row {
    id: string;
    version: number;
    item: TranscriptItem | undefined;
  }

  // visibleItemIds(순서)와 itemVersions(streaming bump)를 모두 의존성으로 잡아,
  // 새 item·delta append 양쪽에서 row를 재계산한다. body는 plain Map에서 소싱한다.
  const rows = $derived.by<Row[]>(() => {
    const ids = store.visibleItemIds;
    const versions = store.itemVersions;
    return ids.map((id) => ({
      id,
      version: versions[id] ?? 0,
      item: store.getItem(id),
    }));
  });
</script>

<div class="message-list" data-testid={TEST_IDS.agentMessageList}>
  {#if rows.length === 0}
    <div class="transcript-empty">{$t("agentRuntime.transcript.empty")}</div>
  {/if}
  {#each rows as row (row.id)}
    {@const item = row.item}
    {#if item}
      {#key row.version}
        {#if item.type === "message"}
          <MessageBubble
            id={item.id}
            role={item.role}
            content={item.content}
            streaming={item.streaming}
          />
        {:else if item.type === "plan"}
          <PlanBlock entries={item.entries} />
        {:else if item.type === "notice"}
          <div
            class="transcript-notice level-{item.level}"
            data-item-testid={agentTranscriptItemTestId(item.id)}
          >
            {$t(item.messageKey)}
          </div>
        {:else if item.type === "tool_call"}
          {@const fileChangeItem = store.getItem(`file_change:${item.id}`)}
          {@const fileChange =
            fileChangeItem?.type === "file_change" ? fileChangeItem.change : undefined}
          {@const pendingApproval = approvalForTool(item.id)}
          {#if pendingApproval && onRespondApproval}
            <ToolCallCard
              id={item.id}
              update={item.update}
              expanded={item.expanded}
              {fileChange}
            >
              {#snippet approval()}
                <ApprovalInlineCard
                  request={pendingApproval}
                  onRespond={onRespondApproval}
                />
              {/snippet}
            </ToolCallCard>
          {:else}
            <ToolCallCard
              id={item.id}
              update={item.update}
              expanded={item.expanded}
              {fileChange}
            />
          {/if}
        {:else if item.type === "file_change"}
          {#if !fileChangeAbsorbed(item.id)}
            <div data-item-testid={agentTranscriptItemTestId(item.id)}>
              <FileDiffCard
                path={item.change.path}
                operation={item.change.operation}
                oldPath={item.change.oldPath}
                patch={item.change.diff}
              />
            </div>
          {/if}
        {/if}
      {/key}
    {/if}
  {/each}
</div>

<style>
  .message-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.75rem;
  }
  .transcript-empty {
    opacity: 0.5;
    font-size: 0.85rem;
    text-align: center;
    padding: 2rem 0;
  }
  .transcript-notice {
    font-size: 0.82rem;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    background: var(--color-surface, rgba(127, 127, 127, 0.06));
  }
  .level-error {
    color: var(--color-error, #f85149);
  }
  .level-warning {
    color: var(--color-warning, #d29922);
  }
</style>
