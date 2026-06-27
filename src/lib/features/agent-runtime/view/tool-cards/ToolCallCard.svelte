<!--
  ToolCallCard — tool call 1건 카드(08 §4, T5.3).

  `ToolCallUpdate.kind`(9종)로 collapsed summary와 expanded content를 분기한다(08 §4 정본 표).
  - execute → CommandOutputCard(stdout/stderr embed)
  - edit/delete/move → FileDiffCard(diff)
  - read/search/fetch/think/other → 일반 content(text/json) 렌더
  헤더를 클릭하면 collapsed↔expanded 토글한다. 단, 더 보여줄 내용(content/locations/rawOutput)이
  없으면 expand affordance를 숨긴다(08 §4.1). status(pending/in_progress/...)는 시각적으로 구분한다.
  inline approval 카드는 호출부가 children 슬롯으로 하단에 끼운다(08 §4.4). 문자열은 i18n 키만 쓴다.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { t } from "../../../../i18n";
  import { TEST_IDS, agentTranscriptItemTestId } from "../../../../testids";
  import type {
    AgentContent,
    FileChangeSummary,
    ToolCallUpdate,
  } from "../../contracts/normalized";
  import CommandOutputCard from "./CommandOutputCard.svelte";
  import FileDiffCard from "./FileDiffCard.svelte";

  interface Props {
    /** transcript item id(렌더 키·testid). */
    id: string;
    /** tool call 갱신(kind/status/content/locations 등). */
    update: ToolCallUpdate;
    /** 기본 펼침 여부(store item.expanded 반영). */
    expanded?: boolean;
    /** file_change_updated에서 합쳐진 변경 요약(있으면 diff 우선 표시, 08 §4.2). */
    fileChange?: FileChangeSummary;
    /** 하단 inline approval 슬롯(severity normal일 때 호출부가 끼움). */
    approval?: Snippet;
  }

  let { id, update, expanded = false, fileChange, approval }: Props = $props();

  // 사용자 토글 상태(초기값은 prop expanded). store 모델과 별개의 view-local 토글이다.
  // svelte-ignore state_referenced_locally
  let open = $state(expanded);

  /** kind를 i18n 라벨로 매핑(08 §4 표). */
  const kindLabel = $derived($t(`agentRuntime.toolKind.${update.kind}`));
  /** status를 i18n 라벨로 매핑(시각 구분, 08 §4.1). */
  const statusLabel = $derived($t(`agentRuntime.toolStatus.${update.status}`));

  // collapsed summary 보조 텍스트: 첫 location path 또는 title.
  const firstPath = $derived(update.locations?.[0]?.path ?? fileChange?.path);
  const summary = $derived(
    update.title ?? firstPath ?? $t("agentRuntime.toolCard.noLocation"),
  );

  // content에서 terminal block(execute 출력) 추출.
  const terminal = $derived.by<{ command?: string; output: string } | null>(() => {
    const term = update.content?.find(
      (c): c is Extract<AgentContent, { type: "terminal" }> => c.type === "terminal",
    );
    return term ? { command: term.command, output: term.output } : null;
  });

  // content에서 diff block 추출(execute가 아닌 edit류).
  const diffContent = $derived.by<{ path: string; patch: string } | null>(() => {
    const d = update.content?.find(
      (c): c is Extract<AgentContent, { type: "diff" }> => c.type === "diff",
    );
    return d ? { path: d.path, patch: d.patch } : null;
  });

  // 일반 content(text/json/resource) — diff/terminal 제외.
  const generalContent = $derived(
    (update.content ?? []).filter(
      (c) => c.type !== "diff" && c.type !== "terminal",
    ),
  );

  // expand affordance 노출 조건: 보여줄 게 있는 카드만 클릭 가능(08 §4.1).
  const hasMore = $derived(
    terminal !== null ||
      diffContent !== null ||
      fileChange !== undefined ||
      generalContent.length > 0 ||
      (update.locations?.length ?? 0) > 0 ||
      update.rawOutput !== undefined,
  );

  /** 일반 content 한 블록을 표시 문자열로 변환. */
  function contentText(c: AgentContent): string {
    if (c.type === "text") return c.text;
    if (c.type === "resource") return c.text ?? c.uri;
    if (c.type === "json") return JSON.stringify(c.value, null, 2);
    return $t("agentRuntime.fallback.unsupportedContent");
  }
</script>

<div
  class="tool-call-card status-{update.status}"
  data-testid={TEST_IDS.agentToolCallCard}
  data-item-testid={agentTranscriptItemTestId(id)}
  data-kind={update.kind}
  data-status={update.status}
>
  <button
    type="button"
    class="tool-header"
    class:clickable={hasMore}
    data-testid={TEST_IDS.agentToolCallToggle}
    aria-expanded={hasMore ? open : undefined}
    disabled={!hasMore}
    onclick={() => hasMore && (open = !open)}
  >
    <span class="tool-kind">{kindLabel}</span>
    <span class="tool-summary" title={summary}>{summary}</span>
    <span class="tool-status status-{update.status}">{statusLabel}</span>
    {#if hasMore}
      <span class="tool-toggle" aria-hidden="true">{open ? "▾" : "▸"}</span>
    {/if}
  </button>

  {#if open && hasMore}
    <div class="tool-body">
      {#if terminal}
        <CommandOutputCard command={terminal.command} stdout={terminal.output} />
      {/if}
      {#if fileChange}
        <FileDiffCard
          path={fileChange.path}
          operation={fileChange.operation}
          oldPath={fileChange.oldPath}
          patch={fileChange.diff}
        />
      {:else if diffContent}
        <FileDiffCard path={diffContent.path} operation="update" patch={diffContent.patch} />
      {/if}
      {#each generalContent as c, i (i)}
        <pre class="tool-content">{contentText(c)}</pre>
      {/each}
    </div>
  {/if}

  {#if approval}
    <div class="tool-approval">
      {@render approval()}
    </div>
  {/if}
</div>

<style>
  .tool-call-card {
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.25));
    border-radius: 0.45rem;
    overflow: hidden;
    background: var(--ui-bg-surface, rgba(127, 127, 127, 0.04));
  }
  .tool-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.45rem 0.6rem;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    font-size: var(--ui-font-size-sm);
    text-align: left;
    cursor: default;
  }
  .tool-header.clickable {
    cursor: pointer;
  }
  .tool-kind {
    flex: 0 0 auto;
    font-size: var(--ui-font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.7;
    padding: 0.05rem 0.35rem;
    border-radius: 0.3rem;
    background: var(--ui-bg-elevated, rgba(127, 127, 127, 0.12));
  }
  .tool-summary {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--ui-font-mono-stack, monospace);
  }
  .tool-status {
    flex: 0 0 auto;
    font-size: var(--ui-font-size-xs);
    opacity: 0.7;
  }
  /* pending과 in_progress를 시각적으로 반드시 구분(08 §4.1). */
  .tool-status.status-pending {
    color: var(--ui-warning, #d29922);
  }
  .tool-status.status-in_progress {
    color: var(--ui-accent, #4a90d9);
  }
  .tool-status.status-failed {
    color: var(--ui-danger, #f85149);
  }
  .tool-status.status-completed {
    color: var(--ui-success, #3fb950);
  }
  .tool-toggle {
    flex: 0 0 auto;
    opacity: 0.5;
  }
  .tool-body {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0.6rem;
    border-top: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.2));
  }
  .tool-content {
    margin: 0;
    font-family: var(--ui-font-mono-stack, monospace);
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tool-approval {
    border-top: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.2));
    padding: 0.5rem 0.6rem;
  }
</style>
