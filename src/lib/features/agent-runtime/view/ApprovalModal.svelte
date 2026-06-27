<!--
  ApprovalModal — severity:"escalation" 차단 승인 모달(08 §4.4·§10.3, 09 §8.3, T5.4).

  sandbox 우회·bypassPermissions 등 고위험 결정(09 §8.3, OQ-47)을 blocking modal로 표시한다.
  inline 카드와 동일하게 provider options를 원본 순서·개수로 렌더하고 label만 i18n으로 감싼다.
  **escape 회귀 보호(08 §10.3)**: Escape는 승인을 미해결로 두고 닫지 않는다 — cancelled 결정으로 응답한다.
  backdrop 클릭도 마찬가지로 무시(명시적 option/취소 버튼만 결정). 문자열은 i18n 키만 쓴다.
-->
<script lang="ts">
  import { t } from "../../../i18n";
  import { TEST_IDS, agentApprovalOptionTestId } from "../../../testids";
  import type { ApprovalDecision, ApprovalRequest } from "../contracts/normalized";

  interface Props {
    /** escalation 승인 요청. */
    request: ApprovalRequest;
    /** 결정 응답 콜백. */
    onRespond: (decision: ApprovalDecision) => void;
  }

  let { request, onRespond }: Props = $props();

  let locked = $state(false);

  /** option 선택 → selected 응답. */
  function select(optionId: string): void {
    if (locked) return;
    locked = true;
    onRespond({ requestId: request.id, outcome: "selected", optionId });
  }

  /** 취소(명시 버튼/Escape) → cancelled 응답. 미해결 종료를 막는다(08 §10.3). */
  function cancel(): void {
    if (locked) return;
    locked = true;
    onRespond({ requestId: request.id, outcome: "cancelled" });
  }

  /** Escape 회귀 보호: 조용히 닫지 않고 cancelled로 명시 응답. */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="approval-modal-backdrop" role="presentation">
  <div
    class="approval-modal"
    data-testid={TEST_IDS.agentApprovalModal}
    data-request-id={request.id}
    role="alertdialog"
    aria-modal="true"
    aria-label={request.title}
  >
    <div class="modal-badge">{$t("agentRuntime.approval.escalationBadge")}</div>
    <div class="modal-title">{request.title}</div>
    <div class="modal-body">
      {request.body ?? $t("agentRuntime.approval.bodyFallback")}
    </div>

    <div class="modal-options">
      {#each request.options as option (option.id)}
        <button
          type="button"
          class="modal-option kind-{option.kind}"
          data-testid={TEST_IDS.agentApprovalOption}
          data-option-testid={agentApprovalOptionTestId(option.id)}
          data-option-id={option.id}
          data-option-kind={option.kind}
          disabled={locked}
          onclick={() => select(option.id)}
        >
          {option.label}
        </button>
      {/each}
      <button
        type="button"
        class="modal-option kind-cancel"
        disabled={locked}
        onclick={cancel}
      >
        {$t("agentRuntime.approval.cancel")}
      </button>
    </div>

    {#if locked}
      <div class="modal-processing" aria-live="polite">
        {$t("agentRuntime.approval.processing")}
      </div>
    {/if}
  </div>
</div>

<style>
  .approval-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .approval-modal {
    max-width: 32rem;
    width: calc(100% - 3rem);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem 1.1rem;
    border-radius: 0.6rem;
    border: 1px solid var(--ui-danger, #f85149);
    background: var(--ui-bg-elevated, var(--ui-bg-app, #1c1c1c));
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
  }
  .modal-badge {
    align-self: flex-start;
    font-size: var(--ui-font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ui-danger, #f85149);
    border: 1px solid var(--ui-danger, #f85149);
    border-radius: 0.3rem;
    padding: 0.1rem 0.4rem;
  }
  .modal-title {
    font-size: var(--ui-font-size-base);
    font-weight: 600;
  }
  .modal-body {
    font-size: var(--ui-font-size-sm);
    opacity: 0.85;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .modal-options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.3rem;
  }
  .modal-option {
    padding: 0.4rem 0.85rem;
    border-radius: 0.4rem;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.3));
    background: var(--ui-bg-app, transparent);
    color: inherit;
    font: inherit;
    font-size: var(--ui-font-size-sm);
    cursor: pointer;
  }
  .modal-option:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .modal-option.kind-allow_once,
  .modal-option.kind-allow_always {
    border-color: var(--ui-success, #3fb950);
  }
  .modal-option.kind-reject_once,
  .modal-option.kind-reject_always {
    border-color: var(--ui-danger, #f85149);
  }
  .modal-processing {
    font-size: var(--ui-font-size-sm);
    opacity: 0.6;
  }
</style>
