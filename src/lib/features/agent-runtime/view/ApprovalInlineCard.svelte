<!--
  ApprovalInlineCard — severity:"normal" 인라인 승인 카드(08 §4.4, T5.4).

  ToolCallCard 하단에 인라인으로 표시되는 비차단 승인 UI다. provider가 제시한 options를
  **원본 순서·개수 그대로** 렌더하고(09 §2 표시-선택 일치), label은 i18n 키로 감싸 표시하되
  optionId/kind는 원본을 보존한다. option 선택 시 `ApprovalDecision{outcome:"selected", optionId}`로,
  취소 시 `outcome:"cancelled"`로 onRespond를 호출한다. 응답 후에는 "처리 중" 상태로 잠근다.
  label은 webview text node로만 렌더한다(XSS 방어, 09 §3.1). 문자열은 i18n 키만 쓴다.
-->
<script lang="ts">
  import { t } from "../../../i18n";
  import { TEST_IDS, agentApprovalOptionTestId } from "../../../testids";
  import type { ApprovalDecision, ApprovalRequest } from "../contracts/normalized";

  interface Props {
    /** 승인 요청(options 원본 보존). */
    request: ApprovalRequest;
    /** 결정 응답 콜백(store/controller로 위임). */
    onRespond: (decision: ApprovalDecision) => void;
  }

  let { request, onRespond }: Props = $props();

  // 응답 후 재선택 방지(멱등) — 카드 잠금.
  let locked = $state(false);

  /** option 선택 → selected 결정으로 응답하고 카드를 잠근다. */
  function select(optionId: string): void {
    if (locked) return;
    locked = true;
    onRespond({ requestId: request.id, outcome: "selected", optionId });
  }

  /** "기억되는 승인"(always) 힌트 노출 여부. */
  function alwaysHint(kind: ApprovalRequest["options"][number]["kind"]): string | null {
    if (kind === "allow_always") return $t("agentRuntime.approval.optionAllowAlwaysHint");
    if (kind === "reject_always") return $t("agentRuntime.approval.optionRejectAlwaysHint");
    return null;
  }
</script>

<div
  class="approval-inline-card"
  data-testid={TEST_IDS.agentApprovalInlineCard}
  data-request-id={request.id}
  role="group"
  aria-label={request.title}
>
  <div class="approval-title">{request.title}</div>
  {#if request.body}
    <div class="approval-body">{request.body}</div>
  {/if}

  <div class="approval-options">
    {#each request.options as option (option.id)}
      <button
        type="button"
        class="approval-option kind-{option.kind}"
        data-testid={TEST_IDS.agentApprovalOption}
        data-option-testid={agentApprovalOptionTestId(option.id)}
        data-option-id={option.id}
        data-option-kind={option.kind}
        disabled={locked}
        onclick={() => select(option.id)}
      >
        <span class="option-label">{option.label}</span>
        {#if alwaysHint(option.kind)}
          <span class="option-hint">{alwaysHint(option.kind)}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if locked}
    <div class="approval-processing" aria-live="polite">
      {$t("agentRuntime.approval.processing")}
    </div>
  {/if}
</div>

<style>
  .approval-inline-card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.82rem;
  }
  .approval-title {
    font-weight: 600;
  }
  .approval-body {
    opacity: 0.8;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .approval-options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .approval-option {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.3rem 0.7rem;
    border-radius: 0.4rem;
    border: 1px solid var(--color-border, rgba(127, 127, 127, 0.3));
    background: var(--color-bg, transparent);
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .approval-option:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .approval-option.kind-allow_once,
  .approval-option.kind-allow_always {
    border-color: var(--color-success, #3fb950);
  }
  .approval-option.kind-reject_once,
  .approval-option.kind-reject_always {
    border-color: var(--color-error, #f85149);
  }
  .option-hint {
    font-size: 0.66rem;
    opacity: 0.6;
  }
  .approval-processing {
    font-size: 0.74rem;
    opacity: 0.6;
  }
</style>
