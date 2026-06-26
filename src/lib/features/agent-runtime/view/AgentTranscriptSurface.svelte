<!--
  AgentTranscriptSurface — direct runtime host shell(08 §2.2, T5.1).

  SessionHostProps 동형(AgentRuntimeHostProps) props를 받아 store + 조립 controller를 만들고,
  transcript(MessageList) + composer(AgentComposer)를 렌더한다. lifecycle:
  - onMount: controller.start(runtimeKind로 adapter 선택 + subscribeEvents → store.dispatch).
  - onDestroy: controller.dispose(unsubscribe + shutdown + registry/store 정리).
  `visible` prop만으로 .hidden CSS 토글하며 unmount하지 않는다(비활성 탭에서도 구독 유지, FE §3.3/OQ-17).

  PTY 전제 콜백(onPtyId/onAuxStateChange/onExit/onResumeFallback)은 direct에서 호출하지 않는다(no-op, 08 §9.2).
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { t } from "../../../i18n";
  import { TEST_IDS } from "../../../testids";
  import type { AgentRuntimeHostProps } from "../contracts/metadata";
  import type { SessionRuntimeKind } from "../contracts/metadata";
  import type { AgentProvider } from "../contracts/normalized";
  import { createAgentRuntimeStore, type AgentRuntimeStore } from "../state/agent-runtime-store.svelte";
  import {
    createAgentRuntimeController,
    type AgentRuntimeController,
  } from "../controller/agent-runtime-controller";
  import { createDefaultPortFactory } from "../service/runtime-port-factory";
  import type { AgentRuntimePort } from "../contracts/runtime-port";
  import MessageList from "./MessageList.svelte";
  import AgentComposer from "./AgentComposer.svelte";
  import ApprovalModal from "./ApprovalModal.svelte";
  import ReplayPanel from "./ReplayPanel.svelte";
  import { createDefaultReplayLoader, type ReplayLoader } from "../service/runtime-replay";
  import type { ApprovalDecision } from "../contracts/normalized";

  interface Props extends AgentRuntimeHostProps {
    /** 테스트용 port 팩토리 주입(미지정 시 프로덕션 transport 팩토리). */
    createPort?: (kind: SessionRuntimeKind) => AgentRuntimePort;
    /** 앱 버전(initialize clientInfo). 미지정 시 기본값. */
    appVersion?: string;
    /** 테스트용 replay loader 팩토리 주입(미지정 시 기본 read-only loader, OQ-54 전 최소 구현). */
    createReplayLoader?: () => ReplayLoader;
  }

  let props: Props = $props();

  // 세션 인스턴스 단위 setup은 mount 1회만 의미가 있으므로(runtimeKind/sessionId는 인스턴스 고정),
  // props를 1회 캡처한다. 이 host는 SessionShell의 useDirectRuntime 분기에서만 마운트되므로 direct-*가 보장된다.
  // svelte-ignore state_referenced_locally
  const runtimeKind: SessionRuntimeKind = props.runtimeKind ?? "direct-codex";
  const provider: AgentProvider = runtimeKind === "direct-claude" ? "claude" : "codex";

  // 세션 단위 store(룬 class). 반응형 표면 visibleItemIds/itemVersions/status 등.
  // svelte-ignore state_referenced_locally
  const store: AgentRuntimeStore = createAgentRuntimeStore({
    sessionHandle: props.sessionId,
    provider,
    providerLabel: provider,
  });

  // svelte-ignore state_referenced_locally
  const controller: AgentRuntimeController = createAgentRuntimeController({
    createPort:
      props.createPort ??
      createDefaultPortFactory({ appVersion: props.appVersion ?? "0.0.0" }),
    store,
  });

  // grace 경과 후 seal/eviction을 주기적으로 트리거(reducer는 동기라 외부가 grace를 친다, 04 §3.7).
  let sealTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    void controller.start({
      sessionHandle: props.sessionId,
      runtimeKind,
      distro: props.distro,
      workDir: props.workDir,
    });
    sealTimer = setInterval(() => store.flushSealAndEvict(), 1000);
  });

  onDestroy(() => {
    if (sealTimer !== null) clearInterval(sealTimer);
    void controller.dispose();
  });

  /** composer 전송 → controller.submit. */
  function onSend(content: import("../contracts/normalized").AgentContent[]): void {
    void controller.submit(content);
  }

  /** stop → 진행 turn 취소. */
  function onStop(): void {
    void controller.cancel();
  }

  /** approval 응답(inline/modal 공통) → controller.approve(store 멱등 기록 + wire 전송). */
  function onRespondApproval(decision: ApprovalDecision): void {
    void controller.approve(decision);
  }

  // evicted-tombstone 구간 존재 여부 — replay affordance 노출 게이트(08 §7.2).
  // visibleItemIds를 의존성으로 잡아 transcript 변화(seal/evict)에 재평가한다.
  const hasEvictedHistory = $derived.by<boolean>(() => {
    void store.visibleItemIds;
    return store.hasEvictedHistory();
  });

  // 격리 replay 패널 표시 상태 + 현재 loader. 닫으면 loader.dispose로 scratch 폐기(ReplayPanel 내부).
  let replayOpen = $state(false);
  let replayLoader = $state<ReplayLoader | null>(null);

  /** "이전 기록 불러오기" → 격리 read-only replay 패널 진입(live store 미병합, T5.6). */
  function openReplay(): void {
    replayLoader =
      props.createReplayLoader?.() ??
      // OQ-54 미결: 실제 session/load·thread/read 경유 loader로 교체될 자리. canLoad는 evicted 존재로 게이트.
      createDefaultReplayLoader({ canLoad: store.hasEvictedHistory() });
    replayOpen = true;
  }

  /** replay 패널 닫기 → 폐기(ReplayPanel이 loader.dispose 수행). */
  function closeReplay(): void {
    replayOpen = false;
    replayLoader = null;
  }
</script>

<div
  class="agent-runtime-shell"
  class:hidden={!props.visible}
  data-testid={TEST_IDS.agentRuntimeShell}
>
  <div class="transcript-region" data-testid={TEST_IDS.agentTranscript}>
    {#if store.status === "starting"}
      <div class="surface-status">{$t("agentRuntime.status.starting")}</div>
    {/if}

    {#if hasEvictedHistory}
      <!-- evicted-tombstone 구간: "이전 기록 불러오기" affordance(read-only 격리 replay 진입, 08 §7.2). -->
      <button
        type="button"
        class="replay-affordance"
        data-testid={TEST_IDS.agentReplayAffordance}
        onclick={openReplay}
      >
        {$t("agentRuntime.replay.affordance")}
      </button>
    {/if}

    {#if replayOpen && replayLoader}
      <ReplayPanel loader={replayLoader} onClose={closeReplay} />
    {/if}

    <MessageList {store} {onRespondApproval} />
  </div>

  <AgentComposer
    status={store.status}
    providerLabel={store.providerLabel}
    {onSend}
    {onStop}
  />
</div>

<!-- escalation 승인은 blocking modal(severity:"escalation"만, 08 §4.4·09 §8.3). -->
{#if store.escalationApproval}
  <ApprovalModal request={store.escalationApproval} onRespond={onRespondApproval} />
{/if}

<style>
  .agent-runtime-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  /* 비활성 탭: unmount하지 않고 off-screen으로 숨긴다(구독·store 유지). */
  .agent-runtime-shell.hidden {
    position: absolute;
    left: -99999px;
    width: 1px;
    height: 1px;
    overflow: hidden;
    pointer-events: none;
  }
  .transcript-region {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .surface-status {
    font-size: 0.78rem;
    opacity: 0.6;
    padding: 0.5rem 0.75rem;
  }
  .replay-affordance {
    display: block;
    width: calc(100% - 1.5rem);
    margin: 0.5rem 0.75rem;
    padding: 0.4rem 0.6rem;
    font: inherit;
    font-size: 0.78rem;
    text-align: center;
    border: 1px dashed var(--color-border, rgba(127, 127, 127, 0.4));
    border-radius: 0.4rem;
    background: var(--color-surface, rgba(127, 127, 127, 0.04));
    color: inherit;
    cursor: pointer;
    opacity: 0.8;
  }
  .replay-affordance:hover {
    opacity: 1;
  }
</style>
