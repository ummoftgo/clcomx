<!--
  AgentComposer — 입력 박스 + send/stop(08 §6).

  Stage 1 범위: multiline text 입력 + Enter 전송(Shift+Enter 개행) + status별 send↔stop 전환.
  image/mention/capability gating은 후속 stage. UI 문자열은 i18n 키만 쓴다(하드코딩 금지).
  status가 running이면 stop, requires_action이면 입력 비활성+승인 대기 안내, starting/failed/exited면 비활성.
-->
<script lang="ts">
  import { t } from "../../../i18n";
  import { TEST_IDS } from "../../../testids";
  import type { AgentContent, AgentSessionStatus } from "../contracts/normalized";

  interface Props {
    /** 세션 상태(입력 활성/버튼 전환 게이팅). */
    status: AgentSessionStatus;
    /** provider 식별자(중립 라벨, 브랜딩 제약 09). */
    providerLabel: string;
    /** 텍스트 전송 콜백. */
    onSend: (content: AgentContent[]) => void;
    /** 진행 turn 취소 콜백. */
    onStop: () => void;
  }

  let { status, providerLabel, onSend, onStop }: Props = $props();

  let draft = $state("");

  // turn 진행 중이면 stop 버튼.
  const isRunning = $derived(status === "running");
  // 입력 활성 조건: ready/idle/running만 입력 가능(승인 대기·시작·종료는 비활성).
  const inputEnabled = $derived(
    status === "ready" || status === "idle" || status === "running",
  );
  const placeholder = $derived(
    status === "requires_action"
      ? $t("agentRuntime.status.requiresAction")
      : inputEnabled
        ? $t("agentRuntime.composer.placeholder")
        : $t("agentRuntime.composer.disabled"),
  );

  /** 입력을 전송하고 draft를 비운다(빈 입력은 무시). */
  function send(): void {
    const text = draft.trim();
    if (text.length === 0 || !inputEnabled) return;
    onSend([{ type: "text", text }]);
    draft = "";
  }

  /** Enter=전송, Shift+Enter=개행(08 §6.1 권장 기본). */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="agent-composer" data-testid={TEST_IDS.agentComposer}>
  <textarea
    class="composer-input"
    data-testid={TEST_IDS.agentComposerInput}
    bind:value={draft}
    placeholder={placeholder}
    rows="2"
    disabled={!inputEnabled}
    onkeydown={onKeydown}
  ></textarea>
  <div class="composer-footer">
    <span class="provider-label" title={providerLabel}>{providerLabel}</span>
    {#if isRunning}
      <button
        type="button"
        class="composer-action stop"
        data-testid={TEST_IDS.agentComposerSend}
        onclick={onStop}
      >
        {$t("agentRuntime.composer.stop")}
      </button>
    {:else}
      <button
        type="button"
        class="composer-action send"
        data-testid={TEST_IDS.agentComposerSend}
        disabled={!inputEnabled || draft.trim().length === 0}
        onclick={send}
      >
        {$t("agentRuntime.composer.send")}
      </button>
    {/if}
  </div>
</div>

<style>
  .agent-composer {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.6rem 0.75rem;
    border-top: 1px solid var(--color-border, rgba(127, 127, 127, 0.25));
    background: var(--color-surface, rgba(127, 127, 127, 0.04));
  }
  .composer-input {
    width: 100%;
    resize: vertical;
    min-height: 2.5rem;
    font: inherit;
    padding: 0.45rem 0.55rem;
    border-radius: 0.45rem;
    border: 1px solid var(--color-border, rgba(127, 127, 127, 0.3));
    background: var(--color-bg, transparent);
    color: inherit;
    box-sizing: border-box;
  }
  .composer-input:disabled {
    opacity: 0.5;
  }
  .composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .provider-label {
    font-size: 0.72rem;
    opacity: 0.55;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .composer-action {
    font: inherit;
    font-size: 0.82rem;
    padding: 0.35rem 0.85rem;
    border-radius: 0.4rem;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .composer-action.send {
    background: var(--color-accent, #4a90d9);
    color: var(--color-on-accent, #fff);
  }
  .composer-action.send:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .composer-action.stop {
    background: var(--color-error, #f85149);
    color: var(--color-on-accent, #fff);
  }
</style>
