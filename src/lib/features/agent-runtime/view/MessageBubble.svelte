<!--
  MessageBubble — transcript message 1건 렌더(08 §3, §6).

  role별 분기: user / agent(response) / reasoning(thought). reasoning은 접이식 thinking 블록으로
  기본 collapsed 렌더한다(08 §6.2). streaming 중이면 끝에 caret(▌)을 붙인다(08 §6.1).
  텍스트는 AgentContent{type:"text"}만 누적해 표시한다. UI 문자열은 i18n 키만 쓴다(하드코딩 금지).
-->
<script lang="ts">
  import { t } from "../../../i18n";
  import { TEST_IDS, agentTranscriptItemTestId } from "../../../testids";
  import type { AgentContent } from "../contracts/normalized";

  interface Props {
    /** transcript item id(가상화·렌더 키). */
    id: string;
    /** user / agent / reasoning(thought) 구분. */
    role: "user" | "agent" | "reasoning";
    /** 렌더할 content 블록(현재 text만 표시, 그 외는 무시). */
    content: AgentContent[];
    /** streaming 중이면 caret 표시. */
    streaming: boolean;
  }

  let { id, role, content, streaming }: Props = $props();

  // reasoning 블록은 기본 접힘(08 §6.2). 사용자 토글로 펼친다.
  let expanded = $state(false);

  // text content만 이어붙여 표시 문자열을 만든다(diff/image 등은 후속 stage 카드).
  const text = $derived(
    content
      .filter((c): c is Extract<AgentContent, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join(""),
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
        {text}{#if streaming}<span class="caret" aria-hidden="true">▌</span>{/if}
      </div>
    {/if}
  {:else}
    <div class="message-role" aria-hidden="true">{roleLabel}</div>
    <div class="message-body">
      {text}{#if streaming}<span class="caret" aria-hidden="true">▌</span>{/if}
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
    font-size: var(--ui-font-size-base);
    line-height: 1.5;
  }
  .reasoning-body {
    font-style: italic;
    opacity: 0.85;
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
