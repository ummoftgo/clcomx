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
  import { onMount, onDestroy, tick } from "svelte";
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
  import RuntimeFallbackPanel from "./RuntimeFallbackPanel.svelte";
  import ReplayPanel from "./ReplayPanel.svelte";
  import { createDefaultReplayLoader, type ReplayLoader } from "../service/runtime-replay";
  import {
    createRuntimeFallbackController,
    type RuntimeFallbackContext,
    type RuntimeFallbackController,
  } from "../controller/runtime-fallback-controller";
  import type { ApprovalDecision } from "../contracts/normalized";

  interface Props extends AgentRuntimeHostProps {
    /** 테스트용 port 팩토리 주입(미지정 시 프로덕션 transport 팩토리). */
    createPort?: (kind: SessionRuntimeKind) => AgentRuntimePort;
    /** 앱 버전(initialize clientInfo). 미지정 시 기본값. */
    appVersion?: string;
    /** 테스트용 replay loader 팩토리 주입(미지정 시 기본 read-only loader, OQ-54 전 최소 구현). */
    createReplayLoader?: () => ReplayLoader;
    /**
     * direct runtime spawn/initialize 실패 시 legacy PTY 새 세션으로 전환하는 콜백(10 §4.6).
     * 미지정이면 fallback 패널의 "터미널로 열기" 선택지가 no-op(graceful 에러만 표시).
     */
    onFallbackToPty?: (context: RuntimeFallbackContext) => void | Promise<void>;
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
  const createPort =
    props.createPort ??
    createDefaultPortFactory({ appVersion: props.appVersion ?? "0.0.0" });

  // controller는 retry 시 새 인스턴스로 교체되므로 가변으로 보유한다(start 가드가 재시작을 막기 때문).
  let controller: AgentRuntimeController | null = null;

  /** direct runtime 세션 시작. 실패하면 fallback 패널을 띄운다(10 §4.6 — 자동 폴백 금지). */
  async function startRuntime(): Promise<void> {
    const next = createAgentRuntimeController({ createPort, store });
    controller = next;
    try {
      await next.start({
        sessionHandle: props.sessionId,
        runtimeKind,
        distro: props.distro,
        workDir: props.workDir,
      });
    } catch (error) {
      // spawn/initialize 거부 — 자동 폴백하지 않고 선택지를 표시한다.
      fallback.markFailed(error);
    }
  }

  // fallback 컨트롤러: start 실패 시 "터미널로 열기 / 재시도 / 취소" 선택지를 노출(10 §4.6).
  // svelte-ignore state_referenced_locally
  const fallback: RuntimeFallbackController = createRuntimeFallbackController({
    context: {
      sessionId: props.sessionId,
      agentId: props.agentId,
      distro: props.distro,
      workDir: props.workDir,
    },
    onFallbackToPty: (context) => props.onFallbackToPty?.(context),
    onRetry: () => startRuntime(),
  });

  // fallback 패널의 reactive 표면(컨트롤러 state는 plain — view에서 룬으로 미러).
  let fallbackVisible = $state(false);
  let fallbackMessage = $state<string | null>(null);
  /** 컨트롤러 plain state를 reactive 미러에 반영한다(markFailed/선택 후 호출). */
  function syncFallback(): void {
    fallbackVisible = fallback.state.visible;
    fallbackMessage = fallback.state.message;
  }

  // grace 경과 후 seal/eviction을 주기적으로 트리거(reducer는 동기라 외부가 grace를 친다, 04 §3.7).
  let sealTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    void startRuntime().finally(syncFallback);
    sealTimer = setInterval(() => store.flushSealAndEvict(), 1000);
  });

  onDestroy(() => {
    if (sealTimer !== null) clearInterval(sealTimer);
    void controller?.dispose();
  });

  /** "터미널로 열기" — legacy PTY 새 세션으로 전환(10 §4.6). */
  function onFallbackPty(): void {
    void Promise.resolve(fallback.chooseLegacyPty()).finally(syncFallback);
  }

  /** "재시도" — 같은 direct runtime을 다시 기동. */
  function onFallbackRetry(): void {
    // 기존 실패 controller는 정리하고 새로 시작한다.
    void controller?.dispose();
    void Promise.resolve(fallback.chooseRetry()).finally(syncFallback);
  }

  /** "취소" — 빈 탭 유지(패널만 닫음). */
  function onFallbackDismiss(): void {
    fallback.dismiss();
    syncFallback();
  }

  /** composer 전송 → controller.submit. */
  function onSend(content: import("../contracts/normalized").AgentContent[]): void {
    void controller?.submit(content);
  }

  /** stop → 진행 turn 취소. */
  function onStop(): void {
    void controller?.cancel();
  }

  /** approval 응답(inline/modal 공통) → controller.approve(store 멱등 기록 + wire 전송). */
  function onRespondApproval(decision: ApprovalDecision): void {
    void controller?.approve(decision);
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

  // ── 자동 아래 스크롤(auto-follow, 08 §7.1). store.autoFollow 상태만으로는 실제 스크롤이 일어나지
  //    않으므로 view가 scroll 컨테이너를 직접 제어한다.
  let scrollEl = $state<HTMLDivElement | null>(null);
  const NEAR_BOTTOM_PX = 32;
  const atBottom = (): boolean =>
    !scrollEl ||
    scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= NEAR_BOTTOM_PX;

  /** 사용자가 위로 스크롤하면 추종 정지, 바닥 복귀 시 재개. */
  function onTranscriptScroll(): void {
    if (!scrollEl) return;
    const wantFollow = atBottom();
    if (wantFollow !== store.autoFollow) store.setAutoFollow(wantFollow);
  }

  // 새 content(transcript 변경) 도착 시 autoFollow면 바닥으로. 고빈도 delta는 tick()로 1회 합친다.
  let scrollScheduled = false;
  $effect(() => {
    // 반응 트리거: 보이는 item 수 + item version(streaming delta 감지). 둘 다 store가 갱신마다 재할당.
    void store.visibleItemIds.length;
    void store.itemVersions;
    if (!store.autoFollow) return;
    if (scrollScheduled) return;
    scrollScheduled = true;
    void tick().then(() => {
      scrollScheduled = false;
      if (scrollEl && store.autoFollow) scrollEl.scrollTop = scrollEl.scrollHeight;
    });
  });

  // pending approval 발생 시 항상 view로(08 §4.4·§7.1).
  $effect(() => {
    const has = store.pendingApprovals.length > 0 || !!store.escalationApproval;
    if (!has) return;
    void tick().then(() => {
      scrollEl
        ?.querySelector<HTMLElement>("[data-approval-anchor]")
        ?.scrollIntoView({ block: "nearest" });
    });
  });
</script>

<div
  class="agent-runtime-shell"
  class:hidden={!props.visible}
  data-testid={TEST_IDS.agentRuntimeShell}
>
  <div
    class="transcript-region"
    data-testid={TEST_IDS.agentTranscript}
    bind:this={scrollEl}
    onscroll={onTranscriptScroll}
  >
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
    availableCommands={store.availableCommands}
    {onSend}
    {onStop}
  />
</div>

<!-- escalation 승인은 blocking modal(severity:"escalation"만, 08 §4.4·09 §8.3). -->
{#if store.escalationApproval}
  <ApprovalModal request={store.escalationApproval} onRespond={onRespondApproval} />
{/if}

<!-- direct runtime spawn/initialize 실패 시 fallback 선택지(10 §4.6 — 자동 폴백 금지). -->
{#if fallbackVisible}
  <RuntimeFallbackPanel
    message={fallbackMessage}
    canRetry={fallback.canRetry}
    onOpenPty={onFallbackPty}
    onRetry={onFallbackRetry}
    onCancel={onFallbackDismiss}
  />
{/if}

<style>
  .agent-runtime-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    /* host baseline: UI 글꼴/크기 토큰을 명시 상속(테마·uiScale·uiFont 자동 반영, 08 §설정). */
    font-family: var(--ui-font-stack);
    font-size: var(--ui-font-size-base);
    color: var(--ui-text-primary);
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
    font-size: var(--ui-font-size-sm);
    opacity: 0.6;
    padding: 0.5rem 0.75rem;
  }
  .replay-affordance {
    display: block;
    width: calc(100% - 1.5rem);
    margin: 0.5rem 0.75rem;
    padding: 0.4rem 0.6rem;
    font: inherit;
    font-size: var(--ui-font-size-sm);
    text-align: center;
    border: 1px dashed var(--ui-border-subtle, rgba(127, 127, 127, 0.4));
    border-radius: 0.4rem;
    background: var(--ui-bg-surface, rgba(127, 127, 127, 0.04));
    color: inherit;
    cursor: pointer;
    opacity: 0.8;
  }
  .replay-affordance:hover {
    opacity: 1;
  }
</style>
