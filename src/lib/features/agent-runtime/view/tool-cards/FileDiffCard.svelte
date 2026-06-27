<!--
  FileDiffCard — 파일 변경 diff 렌더(08 §4.2, T5.3).

  edit/delete/move tool call의 diff 또는 file_change_updated 요약을 한 카드로 표시한다.
  입력 출처는 두 가지(15 §4 `AgentContent{type:"diff"}` / 15 §5 `FileChangeSummary`)이며,
  호출부(MessageList)가 tool_call diff와 file_change_updated를 합쳐 단일 path 키로 이 카드를 렌더한다.
  diffstat(+N/-M)을 헤더에 표시하고 patch 본문을 read-only로 렌더한다. CLCOMX는 자체적으로 변경을
  적용하지 않으므로 hunk accept/reject는 노출하지 않는다(08 §4.2). 모든 문자열은 i18n 키만 쓴다.
-->
<script lang="ts">
  import { t } from "../../../../i18n";
  import { TEST_IDS } from "../../../../testids";
  import type { FileChangeSummary } from "../../contracts/normalized";

  interface Props {
    /** 변경 경로. */
    path: string;
    /** 변경 종류(없으면 update로 간주). */
    operation?: FileChangeSummary["operation"];
    /** move일 때 이전 경로. */
    oldPath?: string;
    /** 정규화된 unified diff patch(adapter가 patch로 정규화, 08 §4.2). */
    patch?: string;
  }

  let { path, operation = "update", oldPath, patch }: Props = $props();

  /** operation을 i18n 라벨로 매핑. */
  const opLabel = $derived(
    operation === "create"
      ? $t("agentRuntime.diff.created")
      : operation === "delete"
        ? $t("agentRuntime.diff.deleted")
        : operation === "move"
          ? $t("agentRuntime.diff.moved")
          : $t("agentRuntime.diff.updated"),
  );

  // diffstat: patch에서 추가(+)/삭제(-) 라인 수를 센다(헤더 hunk 라인 @@ 제외).
  const diffstat = $derived.by<{ added: number; removed: number }>(() => {
    if (!patch) return { added: 0, removed: 0 };
    let added = 0;
    let removed = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    return { added, removed };
  });
</script>

<div class="file-diff-card" data-testid={TEST_IDS.agentFileDiffCard}>
  <div class="diff-header">
    <span class="diff-op" data-op={operation}>{opLabel}</span>
    <span class="diff-path" title={path}>{path}</span>
    <span class="diff-stat" aria-hidden="true">
      <span class="added">+{diffstat.added}</span>
      <span class="removed">-{diffstat.removed}</span>
    </span>
  </div>
  {#if oldPath}
    <div class="diff-rename">{$t("agentRuntime.diff.renamedFrom", { values: { oldPath } })}</div>
  {/if}
  {#if patch && patch.length > 0}
    <pre class="diff-body"><code>{#each patch.split("\n") as line, i (i)}<span
            class="diff-line"
            class:add={line.startsWith("+") && !line.startsWith("+++")}
            class:del={line.startsWith("-") && !line.startsWith("---")}
            class:meta={line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")}
          >{line}
</span>{/each}</code></pre>
  {:else}
    <div class="diff-empty">{$t("agentRuntime.diff.empty")}</div>
  {/if}
</div>

<style>
  .file-diff-card {
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.25));
    border-radius: 0.45rem;
    overflow: hidden;
    font-size: var(--ui-font-size-sm);
  }
  .diff-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    background: var(--ui-bg-surface, rgba(127, 127, 127, 0.06));
  }
  .diff-op {
    font-size: var(--ui-font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.7;
  }
  .diff-path {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--ui-font-mono-stack, monospace);
  }
  .diff-stat {
    display: flex;
    gap: 0.4rem;
    flex: 0 0 auto;
    font-family: var(--ui-font-mono-stack, monospace);
    font-size: var(--ui-font-size-xs);
  }
  .diff-stat .added {
    color: var(--ui-success, #3fb950);
  }
  .diff-stat .removed {
    color: var(--ui-danger, #f85149);
  }
  .diff-rename {
    padding: 0.3rem 0.6rem;
    font-size: var(--ui-font-size-xs);
    opacity: 0.65;
  }
  .diff-body {
    margin: 0;
    padding: 0.5rem 0.6rem;
    overflow-x: auto;
    font-family: var(--ui-font-mono-stack, monospace);
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
    background: var(--ui-bg-app, transparent);
  }
  .diff-line {
    display: block;
    white-space: pre;
  }
  .diff-line.add {
    background: rgba(63, 185, 80, 0.12);
    color: var(--ui-success, #3fb950);
  }
  .diff-line.del {
    background: rgba(248, 81, 73, 0.12);
    color: var(--ui-danger, #f85149);
  }
  .diff-line.meta {
    opacity: 0.55;
  }
  .diff-empty {
    padding: 0.5rem 0.6rem;
    opacity: 0.5;
    font-size: var(--ui-font-size-sm);
  }
</style>
