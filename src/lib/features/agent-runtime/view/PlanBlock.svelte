<!--
  PlanBlock — 실행 계획(plan) 목록 렌더(08 §3, replace-only 04 §3.3).

  plan_updated event는 entries 전체를 교체하므로 이 컴포넌트는 entries를 그대로 받아 렌더만 한다.
  status별 라벨은 i18n 키로(하드코딩 금지).
-->
<script lang="ts">
  import { t } from "../../../i18n";
  import { TEST_IDS } from "../../../testids";
  import type { AgentPlanEntry } from "../contracts/normalized";

  interface Props {
    /** plan 항목(생성 순서 보존). */
    entries: AgentPlanEntry[];
  }

  let { entries }: Props = $props();

  /** plan entry status를 i18n 라벨로 매핑한다. */
  function statusLabel(status: AgentPlanEntry["status"]): string {
    switch (status) {
      case "in_progress":
        return $t("agentRuntime.plan.statusInProgress");
      case "completed":
        return $t("agentRuntime.plan.statusCompleted");
      default:
        return $t("agentRuntime.plan.statusPending");
    }
  }
</script>

<div class="plan-block" data-testid={TEST_IDS.agentPlanBlock}>
  <div class="plan-title">{$t("agentRuntime.plan.title")}</div>
  <ul class="plan-list">
    {#each entries as entry, i (entry.id ?? i)}
      <li class="plan-entry status-{entry.status}">
        <span class="plan-status" aria-hidden="true"></span>
        <span class="plan-content">{entry.content}</span>
        <span class="plan-status-label">{statusLabel(entry.status)}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .plan-block {
    border: 1px solid var(--color-border, rgba(127, 127, 127, 0.25));
    border-radius: 0.5rem;
    padding: 0.6rem 0.75rem;
  }
  .plan-title {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    margin-bottom: 0.4rem;
  }
  .plan-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .plan-entry {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .plan-status {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex: 0 0 auto;
    background: var(--color-border, rgba(127, 127, 127, 0.4));
  }
  .status-in_progress .plan-status {
    background: var(--color-accent, #4a90d9);
  }
  .status-completed .plan-status {
    background: var(--color-success, #3fb950);
  }
  .plan-content {
    flex: 1 1 auto;
  }
  .status-completed .plan-content {
    opacity: 0.6;
    text-decoration: line-through;
  }
  .plan-status-label {
    font-size: 0.7rem;
    opacity: 0.55;
    flex: 0 0 auto;
  }
</style>
