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
  import { searchSessionFiles } from "../../../editors";
  import { t } from "../../../i18n";
  import { TEST_IDS } from "../../../testids";
  import type { AgentRuntimeHostProps } from "../contracts/metadata";
  import type { AgentRuntimeMetadata, SessionRuntimeKind } from "../contracts/metadata";
  import type {
    AgentEvent,
    AgentProvider,
    AgentRuntimeMetadataUpdate,
    AgentSessionStatus,
    FileLocation,
  } from "../contracts/normalized";
  import { createAgentRuntimeStore, type AgentRuntimeStore } from "../state/agent-runtime-store.svelte";
  import {
    createAgentRuntimeController,
    type AgentRuntimeController,
  } from "../controller/agent-runtime-controller";
  import { createDefaultPortFactory } from "../service/runtime-port-factory";
  import { saveResumeKeys } from "../service/resume-store";
  import { saveTranscriptCache, serializeTranscript } from "../service/transcript-cache";
  import type { AgentRuntimePort, SessionStartResult } from "../contracts/runtime-port";
  import MessageList from "./MessageList.svelte";
  import AgentComposer from "./AgentComposer.svelte";
  import ApprovalModal from "./ApprovalModal.svelte";
  import RuntimeFallbackPanel from "./RuntimeFallbackPanel.svelte";
  import ReplayPanel from "./ReplayPanel.svelte";
  import {
    createDefaultReplayLoader,
    createPortReplayLoader,
    type ReplayLoader,
  } from "../service/runtime-replay";
  import {
    createRuntimeFallbackController,
    type RuntimeFallbackContext,
    type RuntimeFallbackController,
  } from "../controller/runtime-fallback-controller";
  import type { ApprovalDecision } from "../contracts/normalized";

  interface ResourceMentionSuggestion {
    label: string;
    uri: string;
    detail?: string;
    mimeType?: string;
    resourceKind?: "file" | "skill";
    text?: string;
  }

  interface Props extends AgentRuntimeHostProps {
    /** 테스트용 port 팩토리 주입(미지정 시 프로덕션 transport 팩토리). */
    createPort?: (kind: SessionRuntimeKind) => AgentRuntimePort;
    /** 앱 버전(initialize clientInfo). 미지정 시 기본값. */
    appVersion?: string;
    /** 테스트용 replay loader 팩토리 주입(미지정 시 provider port 기반 scratch replay loader). */
    createReplayLoader?: () => ReplayLoader;
    /**
     * direct runtime spawn/initialize 실패 시 legacy PTY 새 세션으로 전환하는 콜백(10 §4.6).
     * 미지정이면 fallback 패널의 "터미널로 열기" 선택지가 no-op(graceful 에러만 표시).
     */
    onFallbackToPty?: (context: RuntimeFallbackContext) => void | Promise<void>;
    /** tool location click을 session/editor integration 소유자에게 위임한다(08 §4.3). */
    onOpenLocation?: (location: FileLocation) => void;
  }

  let props: Props = $props();

  // 세션 인스턴스 단위 setup은 mount 1회만 의미가 있으므로(runtimeKind/sessionId는 인스턴스 고정),
  // props를 1회 캡처한다. 이 host는 SessionShell의 useDirectRuntime 분기에서만 마운트되므로 direct-*가 보장된다.
  // svelte-ignore state_referenced_locally
  const runtimeKind: SessionRuntimeKind = props.runtimeKind ?? "direct-codex";
  const provider: AgentProvider = runtimeKind === "direct-claude" ? "claude" : "codex";
  type RuntimeMetadataAttemptId = number;
  type RuntimeStartStoreDispatchMode = "queue" | "live";

  /** 저장된 provider id가 현재 direct provider와 맞으면 resume 설정을 만든다. */
  function buildResumeConfig(
    metadata: AgentRuntimeMetadata | undefined,
  ): { providerSessionId?: string; providerThreadId?: string; replay: boolean } | undefined {
    if (!metadata || metadata.provider !== provider) return undefined;
    if (provider === "codex" && !metadata.providerThreadId) return undefined;
    if (provider === "claude" && !metadata.providerSessionId) return undefined;
    if (metadata.canResume === false && metadata.canLoad !== true) return undefined;
    return {
      providerSessionId: metadata.providerSessionId,
      providerThreadId: metadata.providerThreadId,
      replay: metadata.canLoad === true,
    };
  }

  /** 저장 metadata는 있으나 scrub/미지원으로 이전 대화를 이어갈 수 없는 cold restore 상태인지 판정한다. */
  function isRestoreUnavailable(metadata: AgentRuntimeMetadata | undefined): boolean {
    if (!metadata || metadata.provider !== provider) return false;
    const hasProviderKey =
      provider === "codex"
        ? Boolean(metadata.providerThreadId)
        : Boolean(metadata.providerSessionId);
    const canRestore = metadata.canLoad === true || metadata.canResume !== false;
    return !hasProviderKey || !canRestore;
  }

  /** WSL absolute path를 file URI로 바꿔 provider resource content 경계에 넘긴다. */
  function toFileUri(wslPath: string): string {
    const path = wslPath.startsWith("/") ? wslPath : `/${wslPath}`;
    // URI path segment만 인코딩해 slash 구분자는 유지하고 fragment/query 오해를 막는다.
    return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** composer @mention query를 현재 세션 workspace 파일 후보로 변환한다(OQ-56). */
  async function searchResourceMentions(query: string): Promise<ResourceMentionSuggestion[]> {
    const q = query.trim();
    try {
      const providerResults = await controller?.searchResources(q, 8);
      if (providerResults && providerResults.length > 0) return providerResults;
    } catch {
      // provider-backed search 실패는 composer 입력 실패로 승격하지 않고 workspace fallback을 시도한다.
    }
    const result = await searchSessionFiles(props.sessionId, props.workDir, q, 8);
    return result.results.map((entry) => ({
      label: entry.relativePath || entry.basename || entry.wslPath,
      uri: toFileUri(entry.wslPath),
      detail: entry.wslPath,
    }));
  }

  /** adapter 시작 결과를 persistence용 metadata로 축약한다. */
  function buildAgentRuntimeMetadata(result: SessionStartResult): AgentRuntimeMetadata {
    const metadata: AgentRuntimeMetadata = {
      sessionRuntimeKind: runtimeKind,
      provider: result.ref.provider,
      providerSessionId: result.ref.sessionId,
      providerThreadId: result.ref.threadId,
      lastTurnId: result.ref.turnId,
      protocolVersion: result.protocolVersion,
      adapterVersion: result.adapterVersion,
      providerVersion: result.providerVersion,
      canResume: result.canResume,
      canLoad: result.canLoad,
    };
    if (result.sandbox !== undefined) metadata.sandbox = result.sandbox;
    if (result.approvalPolicy !== undefined) metadata.approvalPolicy = result.approvalPolicy;
    if (result.approvalsReviewer !== undefined) metadata.approvalsReviewer = result.approvalsReviewer;
    if (result.permissionMode !== undefined) metadata.permissionMode = result.permissionMode;
    if (result.sessionMode !== undefined) metadata.sessionMode = result.sessionMode;
    return metadata;
  }

  /** 09 §8.3의 provider 고위험 모드/샌드박스 값을 metadata badge에서 경고로 표시한다. */
  function isHighRiskRuntimeMetadataValue(value: string | undefined): boolean {
    if (!value) return false;
    const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (
      compact === "bypasspermissions" ||
      compact === "dangerfullaccess" ||
      compact === "agentfullaccess" ||
      compact === "fullaccess"
    );
  }

  /** composer footer에 표시할 현재 provider mode 값을 고른다(08 §6.5). */
  function composerModeLabel(metadata: AgentRuntimeMetadata | undefined): string | undefined {
    return firstNonBlank(metadata?.permissionMode, metadata?.sessionMode, metadata?.sandbox);
  }

  /** 빈 문자열 metadata가 footer에 남지 않도록 첫 non-blank 값만 반환한다. */
  function firstNonBlank(...values: Array<string | undefined>): string | undefined {
    for (const value of values) {
      const trimmed = value?.trim();
      if (trimmed) return trimmed;
    }
    return undefined;
  }

  /** session metadata를 live session persistence에 저장한다. 실패해도 runtime은 유지한다. */
  async function persistAgentRuntimeMetadata(metadata: AgentRuntimeMetadata): Promise<void> {
    try {
      await props.onAgentRuntimeMetadataChange?.(metadata);
    } catch {
      // metadata 저장 실패는 runtime 자체 실패가 아니므로 fallback 패널로 전환하지 않는다.
    }
    // OQ-16: 재개 id는 workspace.json이 아닌 암호화 저장소로 별도 저장한다(보안 경계).
    if (metadata.providerThreadId || metadata.providerSessionId) {
      void saveResumeKeys(props.sessionId, {
        providerThreadId: metadata.providerThreadId,
        providerSessionId: metadata.providerSessionId,
        canResume: metadata.canResume ?? false,
        canLoad: metadata.canLoad ?? false,
      });
    }
    // bounded transcript 캐시 저장(scrub·redaction은 serialize 내부). 둘 다 best-effort — 실패해도 runtime 유지.
    void saveTranscriptCache(props.sessionId, serializeTranscript(store.getTranscript()));
  }

  /** provider title을 live session title에 저장한다. 실패해도 runtime은 유지한다. */
  async function persistSessionTitleChange(title: string | null): Promise<void> {
    try {
      await props.onSessionTitleChange?.(title);
    } catch {
      // title 저장 실패는 runtime lifecycle 실패로 승격하지 않는다.
    }
  }

  /** direct runtime store status를 tab/session badge callback에 중복 없이 전달한다. */
  function publishAgentRuntimeStatus(status: AgentSessionStatus): void {
    if (status === lastPublishedStatus) return;
    lastPublishedStatus = status;
    void Promise.resolve(props.onAgentRuntimeStatusChange?.(status)).catch(() => {
      // status badge 반영 실패는 direct runtime lifecycle 실패로 승격하지 않는다.
    });
  }

  /** 세션 시작 후 provider id/capability를 live session에 반영한다. */
  async function publishAgentRuntimeMetadata(
    result: SessionStartResult | null,
    attemptId: RuntimeMetadataAttemptId,
  ): Promise<void> {
    if (!isCurrentRuntimeMetadataAttempt(attemptId)) return;
    if (!result) {
      discardRuntimeMetadataAttempt(attemptId);
      return;
    }
    let metadata = buildAgentRuntimeMetadata(result);
    if (pendingRuntimeMetadataPatch) {
      metadata = { ...metadata, ...pendingRuntimeMetadataPatch };
      pendingRuntimeMetadataPatch = null;
    }
    runtimeStartPending = false;
    runtimeMetadataPatchBlocked = false;
    runtimeMetadata = metadata;
    const pendingStoreEvents = pendingRuntimeStoreEvents;
    pendingRuntimeStoreEvents = [];
    for (const event of pendingStoreEvents) {
      store.dispatch(event);
    }
    publishAgentRuntimeStatus(store.status);
    await persistAgentRuntimeMetadata(metadata);
    const pendingTitleChange = pendingRuntimeTitleChange;
    pendingRuntimeTitleChange = null;
    if (pendingTitleChange) {
      await persistSessionTitleChange(pendingTitleChange.title);
    }
  }

  /** adapter notification에서 온 non-secret runtime metadata patch를 병합한다. */
  async function publishAgentRuntimeMetadataPatch(
    patch: AgentRuntimeMetadataUpdate,
    attemptId: RuntimeMetadataAttemptId,
  ): Promise<void> {
    if (!isCurrentRuntimeMetadataAttempt(attemptId) || runtimeMetadataPatchBlocked) return;
    if (runtimeStartPending || !runtimeMetadata) {
      pendingRuntimeMetadataPatch = { ...(pendingRuntimeMetadataPatch ?? {}), ...patch };
      return;
    }
    const metadata: AgentRuntimeMetadata = { ...runtimeMetadata, ...patch };
    runtimeMetadata = metadata;
    await persistAgentRuntimeMetadata(metadata);
  }

  /** 성공한 현재 attempt에서 온 provider title만 live session title로 전달한다. */
  async function publishSessionTitleChange(
    title: string | null,
    attemptId: RuntimeMetadataAttemptId,
  ): Promise<void> {
    if (!isCurrentRuntimeMetadataAttempt(attemptId) || runtimeMetadataPatchBlocked) return;
    if (runtimeStartPending) {
      pendingRuntimeTitleChange = { title };
      return;
    }
    await persistSessionTitleChange(title);
  }

  /** start/resume attempt 단위 metadata patch 버퍼를 시작한다. */
  function beginRuntimeMetadataAttempt(options?: {
    storeDispatchMode?: RuntimeStartStoreDispatchMode;
  }): RuntimeMetadataAttemptId {
    pendingRuntimeMetadataPatch = null;
    pendingRuntimeTitleChange = null;
    pendingRuntimeStoreEvents = [];
    runtimeStartPending = true;
    runtimeStartStoreDispatchMode = options?.storeDispatchMode ?? "queue";
    runtimeMetadataPatchBlocked = false;
    runtimeMetadataAttemptSeq += 1;
    activeRuntimeMetadataAttemptId = runtimeMetadataAttemptSeq;
    return activeRuntimeMetadataAttemptId;
  }

  /** 실패하거나 무효화된 start/resume attempt의 metadata patch를 폐기한다. */
  function discardRuntimeMetadataAttempt(attemptId: RuntimeMetadataAttemptId): void {
    if (!isCurrentRuntimeMetadataAttempt(attemptId)) return;
    pendingRuntimeMetadataPatch = null;
    pendingRuntimeTitleChange = null;
    pendingRuntimeStoreEvents = [];
    runtimeStartPending = false;
    runtimeStartStoreDispatchMode = "queue";
    runtimeMetadataPatchBlocked = true;
  }

  /** 현재 controller attempt에서 온 metadata event인지 확인해 늦은 실패 event를 차단한다. */
  function isCurrentRuntimeMetadataAttempt(attemptId: RuntimeMetadataAttemptId): boolean {
    return activeRuntimeMetadataAttemptId === attemptId;
  }

  /** controller별 store dispatch를 attempt에 묶어 실패 후 늦은 event가 live store를 오염하지 않게 한다. */
  function createAttemptScopedStore(attemptId: RuntimeMetadataAttemptId): AgentRuntimeStore {
    return new Proxy(store, {
      get(target, prop) {
        if (prop === "dispatch") {
          return (event: AgentEvent) => {
            if (!isCurrentRuntimeMetadataAttempt(attemptId) || runtimeMetadataPatchBlocked) return;
            if (runtimeStartPending && runtimeStartStoreDispatchMode === "queue") {
              pendingRuntimeStoreEvents.push(event);
              return;
            }
            target.dispatch(event);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentRuntimeStore;
  }

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
  // replay 가능 여부는 tombstone 존재와 별개다. provider/session capability가 false면 조회를 시도하지 않는다(FE-28).
  let replayCanLoad = $state<boolean | undefined>(undefined);
  // debug 표시용 metadata는 scrub 대상 provider id를 렌더하지 않는 비밀 제외 표면이다(FE-3).
  let runtimeMetadata = $state<AgentRuntimeMetadata | undefined>(undefined);
  let pendingRuntimeMetadataPatch: AgentRuntimeMetadataUpdate | null = null;
  let pendingRuntimeTitleChange: { title: string | null } | null = null;
  let pendingRuntimeStoreEvents: AgentEvent[] = [];
  let runtimeStartPending = false;
  let runtimeStartStoreDispatchMode: RuntimeStartStoreDispatchMode = "queue";
  let runtimeMetadataPatchBlocked = false;
  let runtimeMetadataAttemptSeq = 0;
  let activeRuntimeMetadataAttemptId = 0;
  let lastPublishedStatus: AgentSessionStatus | null = null;
  // session/load replay는 protocol 초기화와 구분해 사용자에게 "복원 중"으로 표시한다(08 §6.6).
  let resumeReplayPending = $state(false);
  let restoreUnavailable = $state(false);

  $effect(() => {
    if (props.agentRuntime?.canLoad !== undefined) {
      replayCanLoad = props.agentRuntime.canLoad;
    }
    if (props.agentRuntime) {
      runtimeMetadata = props.agentRuntime;
    }
  });

  $effect(() => {
    const status = store.status;
    if (runtimeStartPending) return;
    publishAgentRuntimeStatus(status);
  });

  /** fresh direct runtime 세션을 시작하고 metadata를 반영한다. */
  async function startFreshRuntime(): Promise<void> {
    // 이전 실패 시도에서 start result 전에 들어온 metadata patch는 새 세션에 섞지 않는다.
    const attemptId = beginRuntimeMetadataAttempt();
    const fresh = createAgentRuntimeController({
      createPort,
      store: createAttemptScopedStore(attemptId),
      onRuntimeMetadataChange: (metadata) => publishAgentRuntimeMetadataPatch(metadata, attemptId),
      onSessionTitleChange: (title) => publishSessionTitleChange(title, attemptId),
    });
    controller = fresh;
    try {
      const result = await fresh.start({
        sessionHandle: props.sessionId,
        runtimeKind,
        distro: props.distro,
        workDir: props.workDir,
      });
      replayCanLoad = result?.canLoad;
      await publishAgentRuntimeMetadata(result, attemptId);
    } catch (error) {
      discardRuntimeMetadataAttempt(attemptId);
      throw error;
    }
  }

  /** direct runtime 세션 시작. 실패하면 fallback 패널을 띄운다(10 §4.6 — 자동 폴백 금지). */
  async function startRuntime(): Promise<void> {
    // retry/새 시도 시작 시 이전 실패 시도의 pre-start metadata patch를 폐기한다.
    const resume = buildResumeConfig(props.agentRuntime);
    const attemptId = beginRuntimeMetadataAttempt({
      // session/load replay event는 load 응답 전에 transcript를 재구성해야 하므로 live로 통과시킨다(10 §4.2).
      storeDispatchMode: resume?.replay === true ? "live" : "queue",
    });
    const next = createAgentRuntimeController({
      createPort,
      store: createAttemptScopedStore(attemptId),
      onRuntimeMetadataChange: (metadata) => publishAgentRuntimeMetadataPatch(metadata, attemptId),
      onSessionTitleChange: (title) => publishSessionTitleChange(title, attemptId),
    });
    controller = next;
    restoreUnavailable = isRestoreUnavailable(props.agentRuntime);
    resumeReplayPending = resume?.replay === true;
    try {
      const result = await next.start({
        sessionHandle: props.sessionId,
        runtimeKind,
        distro: props.distro,
        workDir: props.workDir,
        resume,
      });
      replayCanLoad = result?.canLoad;
      await publishAgentRuntimeMetadata(result, attemptId);
    } catch (error) {
      if (resume) {
        // cold restore의 replay/resume 실패는 복원 불가 notice를 남기고 새 direct 세션으로 낮춘다(10 §4.4).
        await next.dispose();
        if (controller === next) controller = null;
        discardRuntimeMetadataAttempt(attemptId);
        restoreUnavailable = true;
        resumeReplayPending = false;
        try {
          await startFreshRuntime();
          return;
        } catch (freshStartError) {
          // 새 runtime spawn/initialize까지 실패한 경우에만 fallback 선택지를 표시한다(10 §4.6).
          fallback.markFailed(freshStartError);
          return;
        }
      }
      // spawn/initialize 거부 — 자동 폴백하지 않고 선택지를 표시한다.
      discardRuntimeMetadataAttempt(attemptId);
      fallback.markFailed(error);
    } finally {
      resumeReplayPending = false;
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
      resumeToken: props.resumeToken ?? null,
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
  let surfaceDisposed = false;

  /** host teardown 공통 경계: tab close, component destroy, webview reload 모두 같은 shutdown을 탄다. */
  function disposeSurfaceRuntime(): void {
    if (surfaceDisposed) return;
    surfaceDisposed = true;
    if (sealTimer !== null) {
      clearInterval(sealTimer);
      sealTimer = null;
    }
    void controller?.dispose();
  }

  /** webview reload/pagehide에서는 Svelte destroy 전에 backend shutdown을 best-effort로 시작한다. */
  function onPageTeardown(): void {
    disposeSurfaceRuntime();
  }

  onMount(() => {
    void startRuntime().finally(syncFallback);
    sealTimer = setInterval(() => store.flushSealAndEvict(), 1000);
    window.addEventListener("pagehide", onPageTeardown);
    window.addEventListener("beforeunload", onPageTeardown);
  });

  onDestroy(() => {
    window.removeEventListener("pagehide", onPageTeardown);
    window.removeEventListener("beforeunload", onPageTeardown);
    disposeSurfaceRuntime();
  });

  /** "터미널로 열기" — legacy PTY 새 세션으로 전환(10 §4.6). */
  function onFallbackPty(): void {
    void (async () => {
      // 기존 실패 controller의 shutdown/registry 정리를 끝낸 뒤 legacy PTY 세션으로 넘긴다.
      const failedController = controller;
      await failedController?.dispose();
      if (controller === failedController) controller = null;
      await fallback.chooseLegacyPty();
    })().finally(syncFallback);
  }

  /** "재시도" — 같은 direct runtime을 다시 기동. */
  function onFallbackRetry(): void {
    void (async () => {
      // 기존 실패 controller의 shutdown/registry 정리를 끝낸 뒤 새 runtime을 시작한다.
      const failedController = controller;
      await failedController?.dispose();
      if (controller === failedController) controller = null;
      await fallback.chooseRetry();
    })().finally(syncFallback);
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
    const metadata = runtimeMetadata ?? props.agentRuntime;
    replayLoader =
      props.createReplayLoader?.() ??
      (metadata
        ? createPortReplayLoader({
            canLoad: replayCanLoad === true,
            createPort,
            runtimeKind,
            sessionHandle: props.sessionId,
            distro: props.distro,
            workDir: props.workDir,
            metadata,
          })
        : createDefaultReplayLoader({ canLoad: false }));
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
    {#if resumeReplayPending || store.status === "starting"}
      <div class="surface-status">
        {resumeReplayPending ? $t("agentRuntime.status.restoring") : $t("agentRuntime.status.starting")}
      </div>
    {/if}

    {#if restoreUnavailable}
      <div
        class="restore-unavailable-notice"
        role="status"
        data-testid={TEST_IDS.agentRestoreUnavailableNotice}
      >
        {$t("agentRuntime.transcript.restoreUnavailable")}
      </div>
    {/if}

    {#if runtimeMetadata}
      <dl
        class="runtime-metadata"
        aria-label={$t("agentRuntime.metadata.title")}
        data-testid={TEST_IDS.agentRuntimeMetadata}
      >
        <div class="metadata-item">
          <dt>{$t("agentRuntime.metadata.provider")}</dt>
          <dd>{runtimeMetadata.provider}</dd>
        </div>
        {#if runtimeMetadata.protocolVersion}
          <div class="metadata-item">
            <dt>{$t("agentRuntime.metadata.protocol")}</dt>
            <dd>{runtimeMetadata.protocolVersion}</dd>
          </div>
        {/if}
        {#if runtimeMetadata.adapterVersion}
          <div class="metadata-item">
            <dt>{$t("agentRuntime.metadata.adapter")}</dt>
            <dd>{runtimeMetadata.adapterVersion}</dd>
          </div>
        {/if}
        {#if runtimeMetadata.providerVersion}
          <div class="metadata-item">
            <dt>{$t("agentRuntime.metadata.version")}</dt>
            <dd>{runtimeMetadata.providerVersion}</dd>
          </div>
        {/if}
        {#if runtimeMetadata.sandbox}
          <div
            class="metadata-item"
            class:metadata-item--warning={isHighRiskRuntimeMetadataValue(runtimeMetadata.sandbox)}
            data-risk={isHighRiskRuntimeMetadataValue(runtimeMetadata.sandbox) ? "high" : undefined}
          >
            <dt>{$t("agentRuntime.metadata.sandbox")}</dt>
            <dd>
              <span>{runtimeMetadata.sandbox}</span>
              {#if isHighRiskRuntimeMetadataValue(runtimeMetadata.sandbox)}
                <span class="metadata-risk-label">{$t("agentRuntime.metadata.highRisk")}</span>
              {/if}
            </dd>
          </div>
        {/if}
        {#if runtimeMetadata.approvalPolicy}
          <div class="metadata-item">
            <dt>{$t("agentRuntime.metadata.approval")}</dt>
            <dd>{runtimeMetadata.approvalPolicy}</dd>
          </div>
        {/if}
        {#if runtimeMetadata.approvalsReviewer}
          <div class="metadata-item">
            <dt>{$t("agentRuntime.metadata.reviewer")}</dt>
            <dd>{runtimeMetadata.approvalsReviewer}</dd>
          </div>
        {/if}
        {#if runtimeMetadata.permissionMode}
          <div
            class="metadata-item"
            class:metadata-item--warning={isHighRiskRuntimeMetadataValue(runtimeMetadata.permissionMode)}
            data-risk={isHighRiskRuntimeMetadataValue(runtimeMetadata.permissionMode) ? "high" : undefined}
          >
            <dt>{$t("agentRuntime.metadata.permissionMode")}</dt>
            <dd>
              <span>{runtimeMetadata.permissionMode}</span>
              {#if isHighRiskRuntimeMetadataValue(runtimeMetadata.permissionMode)}
                <span class="metadata-risk-label">{$t("agentRuntime.metadata.highRisk")}</span>
              {/if}
            </dd>
          </div>
        {/if}
        {#if runtimeMetadata.sessionMode}
          <div
            class="metadata-item"
            class:metadata-item--warning={isHighRiskRuntimeMetadataValue(runtimeMetadata.sessionMode)}
            data-risk={isHighRiskRuntimeMetadataValue(runtimeMetadata.sessionMode) ? "high" : undefined}
          >
            <dt>{$t("agentRuntime.metadata.sessionMode")}</dt>
            <dd>
              <span>{runtimeMetadata.sessionMode}</span>
              {#if isHighRiskRuntimeMetadataValue(runtimeMetadata.sessionMode)}
                <span class="metadata-risk-label">{$t("agentRuntime.metadata.highRisk")}</span>
              {/if}
            </dd>
          </div>
        {/if}
        {#if runtimeMetadata.canResume === true || runtimeMetadata.canLoad === true}
          <div class="metadata-item metadata-capabilities">
            <dt>{$t("agentRuntime.metadata.capabilities")}</dt>
            <dd>
              {#if runtimeMetadata.canResume === true}
                <span>{$t("agentRuntime.metadata.resume")}</span>
              {/if}
              {#if runtimeMetadata.canLoad === true}
                <span>{$t("agentRuntime.metadata.load")}</span>
              {/if}
            </dd>
          </div>
        {/if}
      </dl>
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

    <MessageList {store} {onRespondApproval} onOpenLocation={props.onOpenLocation} />
  </div>

  <AgentComposer
    status={store.status}
    providerLabel={store.providerLabel}
    modeLabel={composerModeLabel(runtimeMetadata)}
    availableCommands={store.availableCommands}
    capabilities={store.capabilities}
    resourceSearch={searchResourceMentions}
    restoring={resumeReplayPending}
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
  .restore-unavailable-notice {
    margin: 0.45rem 0.75rem 0.25rem;
    padding: 0.45rem 0.55rem;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.25));
    border-radius: 0.35rem;
    background: var(--ui-bg-surface, rgba(127, 127, 127, 0.06));
    color: var(--ui-text-secondary, currentColor);
    font-size: var(--ui-font-size-sm);
  }
  .runtime-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.5rem;
    margin: 0.45rem 0.75rem 0.25rem;
    padding: 0;
    color: var(--ui-text-secondary, rgba(127, 127, 127, 0.82));
    font-size: var(--ui-font-size-xs, 0.75rem);
  }
  .metadata-item {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.25));
    border-radius: 0.35rem;
    background: var(--ui-bg-surface, rgba(127, 127, 127, 0.06));
  }
  .metadata-item dt,
  .metadata-item dd {
    min-width: 0;
    margin: 0;
    padding: 0.16rem 0.35rem;
    white-space: nowrap;
  }
  .metadata-item dt {
    border-right: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.25));
    color: var(--ui-text-muted, currentColor);
  }
  .metadata-item dd {
    overflow: hidden;
    max-width: min(22rem, 52vw);
    text-overflow: ellipsis;
  }
  .metadata-item--warning {
    border-color: color-mix(in srgb, var(--ui-danger, #c2410c) 55%, transparent);
    background: color-mix(in srgb, var(--ui-danger, #c2410c) 10%, transparent);
    color: var(--ui-text-primary);
  }
  .metadata-item--warning dt {
    border-right-color: color-mix(in srgb, var(--ui-danger, #c2410c) 45%, transparent);
    color: var(--ui-danger, #c2410c);
  }
  .metadata-item--warning dd {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .metadata-risk-label {
    flex: 0 0 auto;
    border-radius: 0.25rem;
    background: var(--ui-danger, #c2410c);
    color: var(--ui-danger-contrast, #fff);
    font-size: var(--ui-font-size-xs, 0.75rem);
    line-height: 1;
    padding: 0.12rem 0.25rem;
  }
  .metadata-capabilities dd {
    display: inline-flex;
    gap: 0.35rem;
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
