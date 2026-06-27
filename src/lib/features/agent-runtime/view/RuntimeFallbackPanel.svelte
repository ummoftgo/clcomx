<!--
  RuntimeFallbackPanel — direct runtime spawn/initialize 실패 시 fallback 선택지(10 §4.6, 08 §9).

  자동 폴백을 하지 않고(사용자 의도 보존) "터미널로 열기 / 재시도 / 취소"를 blocking modal로 표시한다.
  - 터미널로 열기: 같은 agent를 legacy PTY 새 세션으로 전환(onOpenPty).
  - 재시도: 같은 direct runtime을 다시 기동(onRetry, canRetry일 때만 노출).
  - 취소: 빈 탭 유지(onCancel). Escape도 동일.
  문자열은 i18n 키만 쓴다(en/ko 동시). message는 진단용 사유(비밀 비포함).
-->
<script lang="ts">
  import { t } from "../../../i18n";
  import { TEST_IDS } from "../../../testids";

  interface Props {
    /** 실패 사유 문구(진단 표시용, 비밀 비포함). null이면 표시 생략. */
    message: string | null;
    /** 재시도 선택지 노출 여부. */
    canRetry: boolean;
    /** "터미널로 열기" — legacy PTY 새 세션 전환. */
    onOpenPty: () => void;
    /** "재시도" — direct runtime 재기동. */
    onRetry: () => void;
    /** "취소" — 빈 탭 유지. */
    onCancel: () => void;
  }

  let { message, canRetry, onOpenPty, onRetry, onCancel }: Props = $props();

  /** Escape는 취소로 처리한다(조용히 닫지 않음). */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="fallback-backdrop" role="presentation">
  <div
    class="fallback-modal"
    data-testid={TEST_IDS.agentRuntimeFallback}
    role="alertdialog"
    aria-modal="true"
    aria-label={$t("agentRuntime.fallback.title")}
  >
    <div class="fallback-title">{$t("agentRuntime.fallback.title")}</div>
    <div class="fallback-body">{$t("agentRuntime.fallback.description")}</div>

    {#if message}
      <div class="fallback-reason">{message}</div>
    {/if}

    <div class="fallback-actions">
      <button
        type="button"
        class="fallback-action primary"
        data-testid={TEST_IDS.agentRuntimeFallbackPty}
        onclick={onOpenPty}
      >
        {$t("agentRuntime.fallback.openPty")}
      </button>
      {#if canRetry}
        <button
          type="button"
          class="fallback-action"
          data-testid={TEST_IDS.agentRuntimeFallbackRetry}
          onclick={onRetry}
        >
          {$t("agentRuntime.fallback.retry")}
        </button>
      {/if}
      <button
        type="button"
        class="fallback-action"
        data-testid={TEST_IDS.agentRuntimeFallbackCancel}
        onclick={onCancel}
      >
        {$t("agentRuntime.fallback.cancel")}
      </button>
    </div>
  </div>
</div>

<style>
  .fallback-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .fallback-modal {
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
  .fallback-title {
    font-size: var(--ui-font-size-base);
    font-weight: 600;
  }
  .fallback-body {
    font-size: var(--ui-font-size-sm);
    opacity: 0.85;
  }
  .fallback-reason {
    font-size: var(--ui-font-size-sm);
    opacity: 0.7;
    white-space: pre-wrap;
    word-break: break-word;
    padding: 0.4rem 0.5rem;
    border-radius: 0.4rem;
    background: var(--ui-bg-app, rgba(127, 127, 127, 0.08));
  }
  .fallback-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.3rem;
  }
  .fallback-action {
    padding: 0.4rem 0.85rem;
    border-radius: 0.4rem;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.3));
    background: var(--ui-bg-app, transparent);
    color: inherit;
    font: inherit;
    font-size: var(--ui-font-size-sm);
    cursor: pointer;
  }
  .fallback-action.primary {
    border-color: var(--ui-accent, #58a6ff);
  }
</style>
