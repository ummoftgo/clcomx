<!--
  MessageBubble — transcript message 1건 렌더(08 §3, §6).

  role별 분기: user / agent(response) / reasoning(thought). reasoning은 접이식 thinking 블록으로
  기본 collapsed 렌더한다(08 §6.2). streaming 중이면 끝에 caret(▌)을 붙인다(08 §6.1).
  text/resource/json content를 표시하고, 나머지 content는 명시적 fallback으로 표시한다.
  UI 문자열은 i18n 키만 쓴다(하드코딩 금지).
-->
<script lang="ts">
  import { t } from "../../../i18n";
  import { TEST_IDS, agentTranscriptItemTestId } from "../../../testids";
  import type { AgentContent } from "../contracts/normalized";
  import { redactDisplayText, stringifyRedactedRaw } from "../service/display-redaction";
  import { renderAgentMarkdown } from "../service/markdown-renderer";

  interface Props {
    /** transcript item id(가상화·렌더 키). */
    id: string;
    /** user / agent / reasoning(thought) 구분. */
    role: "user" | "agent" | "reasoning";
    /** 렌더할 content 블록. */
    content: AgentContent[];
    /** streaming 중이면 caret 표시. */
    streaming: boolean;
  }

  let { id, role, content, streaming }: Props = $props();

  // reasoning 블록은 기본 접힘(08 §6.2). 사용자 토글로 펼친다.
  let expanded = $state(false);

  interface DisplayBlock {
    /** inline text는 이어서, md는 sanitize HTML로, pre는 독립 블록으로 렌더한다. */
    kind: "text" | "md" | "pre";
    /** 표시 직전 redaction이 적용된 문자열. */
    text: string;
    /** kind==="md"일 때만: redaction → marked → DOMPurify를 통과한 신뢰 HTML. */
    html?: string;
  }

  /** AgentContent를 transcript 표시용 문자열 블록으로 변환한다. */
  function contentBlockToDisplay(contentBlock: AgentContent): DisplayBlock {
    if (contentBlock.type === "text") {
      return { kind: "text", text: redactDisplayText(contentBlock.text) };
    }
    if (contentBlock.type === "resource") {
      return {
        kind: "pre",
        text: redactDisplayText(contentBlock.text ?? contentBlock.uri),
      };
    }
    if (contentBlock.type === "json") {
      return { kind: "pre", text: stringifyRedactedRaw(contentBlock.value) };
    }
    return { kind: "pre", text: $t("agentRuntime.fallback.unsupportedContent") };
  }

  // 에이전트/reasoning 출력의 text 블록은 item이 **완성된 뒤에만** markdown으로 렌더한다
  // (스트리밍 중 매 delta 파싱 금지 — 완성 시 1회, Slice ③ 합의). user 입력은 평문 유지.
  // redaction이 markdown 파싱보다 먼저다(contentBlockToDisplay에서 이미 적용됨, TB-4).
  const displayBlocks = $derived(
    content.map((contentBlock) => {
      const block = contentBlockToDisplay(contentBlock);
      if (block.kind === "text" && role !== "user" && !streaming) {
        return { ...block, kind: "md" as const, html: renderAgentMarkdown(block.text) };
      }
      return block;
    }),
  );

  const roleLabel = $derived(
    role === "user"
      ? $t("agentRuntime.transcript.userLabel")
      : $t("agentRuntime.transcript.agentLabel"),
  );
</script>

<div
  class="message-bubble role-{role}"
  data-testid={TEST_IDS.agentMessageBubble}
  data-item-testid={agentTranscriptItemTestId(id)}
  data-role={role}
>
  {#if role === "reasoning"}
    <button
      type="button"
      class="reasoning-toggle"
      data-testid={TEST_IDS.agentReasoningToggle}
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      <span class="reasoning-label">{$t("agentRuntime.transcript.reasoning")}</span>
      <span class="reasoning-action">
        {expanded
          ? $t("agentRuntime.transcript.reasoningHide")
          : $t("agentRuntime.transcript.reasoningShow")}
      </span>
    </button>
    {#if expanded}
      <div class="message-body reasoning-body">
        {#each displayBlocks as block, i (i)}
          {#if block.kind === "md"}
            <div class="message-markdown">{@html block.html}</div>
          {:else if block.kind === "text"}
            {block.text}
          {:else}
            <pre class="message-content-block">{block.text}</pre>
          {/if}
        {/each}
        {#if streaming}<span class="caret" aria-hidden="true">▌</span>{/if}
      </div>
    {/if}
  {:else}
    <div class="message-role" aria-hidden="true">{roleLabel}</div>
    <div class="message-body">
      {#each displayBlocks as block, i (i)}
        {#if block.kind === "md"}
          <div class="message-markdown">{@html block.html}</div>
        {:else if block.kind === "text"}
          {block.text}
        {:else}
          <pre class="message-content-block">{block.text}</pre>
        {/if}
      {/each}
      {#if streaming}<span class="caret" aria-hidden="true">▌</span>{/if}
    </div>
  {/if}
</div>

<style>
  .message-bubble {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.6rem 0.75rem;
    border-radius: 0.5rem;
    max-width: 100%;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .role-user {
    background: var(--ui-bg-elevated, rgba(127, 127, 127, 0.12));
    align-self: flex-end;
  }
  .role-agent {
    background: var(--ui-bg-surface, rgba(127, 127, 127, 0.06));
  }
  .role-reasoning {
    background: transparent;
    border: 1px dashed var(--ui-border-subtle, rgba(127, 127, 127, 0.3));
    opacity: 0.85;
  }
  .message-role {
    font-size: var(--ui-font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
  }
  .message-body {
    /* agentRuntime 설정(--agent-transcript-*)이 있으면 우선, 없으면 UI 토큰 상속(FE-25 후속). */
    font-size: var(--agent-transcript-font-size, var(--ui-font-size-base));
    line-height: 1.5;
  }
  .message-content-block {
    margin: 0.35rem 0 0;
    padding: 0.45rem 0.55rem;
    border-radius: 0.35rem;
    background: var(--ui-bg-code, rgba(127, 127, 127, 0.08));
    font-family: var(
      --agent-transcript-code-font-stack,
      var(--ui-font-mono-stack, ui-monospace, SFMono-Regular, Menlo, monospace)
    );
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .reasoning-body {
    font-style: italic;
    opacity: 0.85;
  }
  /* markdown 렌더 컨테이너 — {@html}은 DOMPurify를 통과한 신뢰 HTML만 받는다(markdown-renderer). */
  .message-markdown {
    /* bubble의 pre-wrap을 해제해야 markdown 블록 사이 공백이 이중으로 벌어지지 않는다. */
    white-space: normal;
    word-break: break-word;
  }
  .message-markdown :global(p) {
    margin: 0.35rem 0;
  }
  .message-markdown :global(p:first-child),
  .message-markdown :global(ul:first-child),
  .message-markdown :global(ol:first-child),
  .message-markdown :global(pre:first-child) {
    margin-top: 0;
  }
  .message-markdown :global(p:last-child),
  .message-markdown :global(ul:last-child),
  .message-markdown :global(ol:last-child),
  .message-markdown :global(pre:last-child) {
    margin-bottom: 0;
  }
  .message-markdown :global(ul),
  .message-markdown :global(ol) {
    margin: 0.35rem 0;
    padding-left: 1.4rem;
  }
  .message-markdown :global(li) {
    margin: 0.15rem 0;
  }
  .message-markdown :global(code) {
    font-family: var(
      --agent-transcript-code-font-stack,
      var(--ui-font-mono-stack, ui-monospace, SFMono-Regular, Menlo, monospace)
    );
    font-size: 0.92em;
    background: var(--ui-bg-code, rgba(127, 127, 127, 0.08));
    padding: 0.08em 0.35em;
    border-radius: 0.25rem;
  }
  .message-markdown :global(pre) {
    margin: 0.35rem 0;
    padding: 0.45rem 0.55rem;
    border-radius: 0.35rem;
    background: var(--ui-bg-code, rgba(127, 127, 127, 0.08));
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .message-markdown :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: var(--ui-font-size-sm);
  }
  .message-markdown :global(h1),
  .message-markdown :global(h2),
  .message-markdown :global(h3),
  .message-markdown :global(h4),
  .message-markdown :global(h5),
  .message-markdown :global(h6) {
    margin: 0.6rem 0 0.3rem;
    line-height: 1.3;
  }
  .message-markdown :global(h1) {
    font-size: 1.25em;
  }
  .message-markdown :global(h2) {
    font-size: 1.15em;
  }
  .message-markdown :global(h3) {
    font-size: 1.05em;
  }
  .message-markdown :global(h4),
  .message-markdown :global(h5),
  .message-markdown :global(h6) {
    font-size: 1em;
  }
  .message-markdown :global(blockquote) {
    margin: 0.35rem 0;
    padding: 0.1rem 0 0.1rem 0.6rem;
    border-left: 3px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.35));
    opacity: 0.85;
  }
  .message-markdown :global(hr) {
    border: none;
    border-top: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.3));
    margin: 0.6rem 0;
  }
  .message-markdown :global(table) {
    border-collapse: collapse;
    margin: 0.35rem 0;
    display: block;
    overflow-x: auto;
    max-width: 100%;
  }
  .message-markdown :global(th),
  .message-markdown :global(td) {
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.35));
    padding: 0.25rem 0.5rem;
    font-size: var(--ui-font-size-sm);
  }
  .message-markdown :global(a) {
    color: var(--ui-accent, #6ea8fe);
    text-decoration: underline;
  }
  .reasoning-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font-size: var(--ui-font-size-sm);
    text-align: left;
  }
  .reasoning-action {
    opacity: 0.6;
  }
  .caret {
    display: inline-block;
    animation: caret-blink 1s step-end infinite;
  }
  @keyframes caret-blink {
    50% {
      opacity: 0;
    }
  }
</style>
