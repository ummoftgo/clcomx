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
  import {
    CODEX_APPROVAL_POLICIES,
    APPROVAL_DEFAULT_SELECTION,
    isHighRiskApprovalPolicy,
  } from "../contracts/normalized";
  import { createAgentRuntimeStore, type AgentRuntimeStore } from "../state/agent-runtime-store.svelte";
  import {
    createAgentRuntimeController,
    type AgentRuntimeController,
  } from "../controller/agent-runtime-controller";
  import { createDefaultPortFactory } from "../service/runtime-port-factory";
  import { saveResumeKeys, loadResumeKeys, type ResumeKeys } from "../service/resume-store";
  import {
    saveTranscriptCache,
    serializeTranscript,
    loadTranscriptCache,
    deserializeTranscript,
  } from "../service/transcript-cache";
  import type { AgentRuntimePort, SessionStartResult } from "../contracts/runtime-port";
  import type { TranscriptModel } from "../contracts/transcript";
  import { getSettings } from "../../../stores/settings.svelte";
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
    if (result.availableModes !== undefined) metadata.availableModes = result.availableModes;
    if (result.model !== undefined) metadata.model = result.model;
    if (result.effort !== undefined) metadata.effort = result.effort;
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
    // OQ-16: 재개 id는 workspace.json이 아닌 암호화 저장소로 별도 저장한다(보안 경계). 값이 싸므로 즉시 저장.
    if (metadata.providerThreadId || metadata.providerSessionId) {
      void saveResumeKeys(props.sessionId, {
        providerThreadId: metadata.providerThreadId,
        providerSessionId: metadata.providerSessionId,
        canResume: metadata.canResume ?? false,
        canLoad: metadata.canLoad ?? false,
      });
    }
    // bounded transcript 캐시 저장(scrub·redaction은 serialize 내부)은 매번 전체 transcript를 재직렬화하므로
    // 디바운스로 묶어 고빈도 metadata patch에서의 IO 경합을 완화한다(best-effort — 실패해도 runtime 유지).
    scheduleTranscriptCacheSave();
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
    // ②-B: 세션이 준비되면 모델 목록을 채운다(Codex만; best-effort — 실패해도 세션은 유지).
    void refreshAvailableModels().catch(() => {});
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
    // sentinel 해소는 **null override가 커밋된 뒤**(prompt 전송) 도착한 권위 approval echo에서만 한다 —
    // prompt 전 도착한 echo는 revert 이전 정책이라 해소에 쓰면 다음 turn의 provider-default 위험(never 가능)을
    // 숨긴다. 커밋 후 echo만 revert 결과를 확정하므로 그때 권위값으로 표시/위험을 재계산한다(Codex medium 12차).
    if (
      patch.approvalPolicy !== undefined &&
      approvalSelection === APPROVAL_DEFAULT_SELECTION &&
      approvalSentinelCommitted
    ) {
      approvalSelection = undefined;
      approvalSentinelCommitted = false;
    }
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
  // OQ-16 Task 10: resume 소스가 없어(id 없음/미지원) 이어갈 수 없지만 캐시 히스토리가 있는 경우,
  // 캐시를 read-only로 유지하며 "이전 대화는 읽기 전용, 이 새 세션에서 이어감" affordance를 표시한다.
  // 이때 restoreUnavailable(빈 새 세션 notice)는 세우지 않는다 — historyReadOnly가 대신한다.
  let historyReadOnly = $state(false);

  // ②-B: Codex 모델/effort 셀렉터 상태(세션 메모리 범위). 세션 시작 후 model/list로 채운다.
  let availableModels = $state<import("../contracts/normalized").AgentModelOption[]>([]);
  let selectedModel = $state<string | undefined>(undefined);
  let selectedEffort = $state<string | undefined>(undefined);
  const selectedModelEfforts = $derived(
    availableModels.find((m) => m.id === selectedModel)?.efforts ?? [],
  );

  /** 세션 시작 후 사용 가능한 모델 목록을 조회해 셀렉터를 채운다(Codex만; 미지원이면 빈 배열). */
  async function refreshAvailableModels(): Promise<void> {
    let models = (await controller?.listModels()) ?? [];
    // 세션의 실제 current model이 catalog에 없으면(예: hidden/구버전 모델로 resume) 표시가 어긋나지
    // 않도록 합성 옵션을 추가한다 — 화면이 항상 실제 실행 모델을 보여주게 한다(Codex 리뷰).
    const authoritativeModelId = runtimeMetadata?.model;
    if (authoritativeModelId && !models.some((m) => m.id === authoritativeModelId)) {
      const effortId = runtimeMetadata?.effort;
      models = [
        {
          id: authoritativeModelId,
          label: authoritativeModelId,
          efforts: effortId ? [{ id: effortId }] : [],
          ...(effortId ? { defaultEffort: effortId } : {}),
        },
        ...models,
      ];
    }
    availableModels = models;
    if (models.length === 0) return;
    if (selectedModel !== undefined) return;
    // 초기 선택은 **세션의 실제 current model이 알려진 경우에만** 자동 확정한다. 이 값은 override 없이도
    // wire와 일치하므로 setTurnOptions를 호출하지 않는다. 실제 model을 모르는 경로(replay resume —
    // thread/read는 model/effort를 안 준다)에서는 catalog default를 잘못 표시하지 않도록 미선택으로
    // 두고, composer가 placeholder를 보여준다. 사용자가 명시적으로 고르면 그때 override를 건다(Codex 리뷰).
    const authoritative = authoritativeModelId
      ? models.find((m) => m.id === authoritativeModelId)
      : undefined;
    if (!authoritative) return;
    selectedModel = authoritative.id;
    // 실제 current effort가 이 모델의 후보에 있으면 그 값, 없으면 모델 기본값.
    const authoritativeEffort = runtimeMetadata?.effort;
    selectedEffort =
      authoritativeEffort && authoritative.efforts.some((e) => e.id === authoritativeEffort)
        ? authoritativeEffort
        : (authoritative.defaultEffort ?? authoritative.efforts[0]?.id);
  }

  function onModelChange(modelId: string): void {
    selectedModel = modelId;
    const model = availableModels.find((m) => m.id === modelId);
    // 모델이 바뀌면 effort를 그 모델의 기본값으로 맞춘다(이전 effort가 새 모델에 없을 수 있음).
    const nextEffort = model?.efforts.some((e) => e.id === selectedEffort)
      ? selectedEffort
      : (model?.defaultEffort ?? model?.efforts[0]?.id);
    selectedEffort = nextEffort;
    controller?.setTurnOptions({ model: modelId, effort: nextEffort ?? null });
  }

  function onEffortChange(effortId: string): void {
    selectedEffort = effortId;
    controller?.setTurnOptions({ effort: effortId });
  }

  // ②-C: Codex approval policy override(세션 메모리 범위). scalar AskForApproval 후보는 프로토콜 상수라
  // list 조회 없이 정적으로 노출한다(granular 객체 variant는 제외). Codex 세션에서만 셀렉터를 켠다.
  const availableApprovalPolicies = $derived<readonly string[]>(
    provider === "codex" ? CODEX_APPROVAL_POLICIES : [],
  );
  // base(세션 시작 권위값)가 scalar 후보인지 — granular/미상이면 셀렉터 표시값을 base로 잡지 않고 placeholder.
  const approvalBaseIsScalar = $derived<boolean>(
    provider === "codex" &&
      !!runtimeMetadata?.approvalPolicy &&
      CODEX_APPROVAL_POLICIES.includes(runtimeMetadata.approvalPolicy as (typeof CODEX_APPROVAL_POLICIES)[number]),
  );
  // 사용자의 명시적 선택(3-state): undefined=미설정→base 사용, APPROVAL_DEFAULT_SELECTION=provider 기본값(null),
  // scalar=override 값. base가 granular/미상이어도 default sentinel로 항상 provider default로 되돌릴 수 있다(Codex 리뷰).
  let approvalSelection = $state<string | undefined>(undefined);
  // sentinel(provider 기본값)의 null override는 다음 turn/start에서야 적용된다 — prompt가 전송돼 null이
  // wire에 도달한 뒤 도착한 settings echo만 그 결과를 권위로 확정한다. prompt 전 도착한 echo는 revert 이전
  // 정책이라 sentinel 해소에 쓰면 다음 turn 위험(never 가능)을 숨긴다(Codex medium 12차). 이 플래그는
  // sentinel 선택 후 prompt가 전송(null 커밋)됐는지를 추적한다.
  let approvalSentinelCommitted = $state(false);
  // 셀렉터 표시값: 사용자가 고른 값(sentinel 포함) 우선, 없으면 base가 scalar일 때만 그 값(아니면 placeholder).
  const selectedApprovalPolicy = $derived<string | undefined>(
    approvalSelection ?? (approvalBaseIsScalar ? runtimeMetadata?.approvalPolicy : undefined),
  );
  // 다음 turn에 적용될 실효 정책(위험 판정 권위):
  //  - scalar override → 그 값(base가 never여도 은닉 없이 표시, Codex high 1차).
  //  - provider 기본값 sentinel → provider/server default로 revert하는데 그 결과 정책을 client가 알 수 없다
  //    (start metadata와 다를 수 있음) → undefined(미상)로 둬 fail-closed(Codex high 4차).
  //  - 미설정(사용자 미선택) → base(thread 시작 정책; replay면 undefined).
  const effectiveApprovalPolicy = $derived<string | undefined>(
    approvalSelection === APPROVAL_DEFAULT_SELECTION
      ? undefined
      : (approvalSelection ?? runtimeMetadata?.approvalPolicy),
  );
  // 실효 정책이 우리가 판정 가능한 scalar 후보인지(never 포함). granular(experimental) 객체나 replay로
  // 미상(undefined)이면 안전 여부를 확인할 수 없다.
  const approvalEffectiveIsKnownScalar = $derived<boolean>(
    effectiveApprovalPolicy !== undefined &&
      CODEX_APPROVAL_POLICIES.includes(effectiveApprovalPolicy as (typeof CODEX_APPROVAL_POLICIES)[number]),
  );
  // replay resume(thread/read)는 approvalPolicy를 주지 않고, granular는 우리가 파싱하지 않는다 — 실제 정책이
  // never여도 알 수 없다. 세션이 성립했는데(codex) 실효 정책을 known scalar로 확인하지 못하면 안전한 상태로
  // 보이지 않게 fail-closed로 고위험 취급한다(Codex high 재지적). 사용자가 명시 scalar를 고르면 미상이 해소된다.
  const approvalPolicyUnknown = $derived<boolean>(
    provider === "codex" && !!runtimeMetadata && !approvalEffectiveIsKnownScalar,
  );
  const approvalHighRisk = $derived<boolean>(
    isHighRiskApprovalPolicy(effectiveApprovalPolicy) || approvalPolicyUnknown,
  );
  // override chip: 사용자가 base와 실제로 다른 정책으로 바꿔 "다음 turn 정책"이 base badge와 어긋나는 경우에만.
  const approvalOverrideActive = $derived<string | undefined>(
    approvalSelection !== undefined &&
      approvalSelection !== APPROVAL_DEFAULT_SELECTION &&
      approvalSelection !== runtimeMetadata?.approvalPolicy
      ? approvalSelection
      : undefined,
  );

  function onApprovalPolicyChange(policyId: string): void {
    if (policyId === APPROVAL_DEFAULT_SELECTION) {
      // provider 기본값으로 override 해제 — base가 granular/미상이어도 항상 도달 가능한 revert 경로.
      approvalSelection = APPROVAL_DEFAULT_SELECTION;
      approvalSentinelCommitted = false; // 아직 prompt 전송 전 — null 미커밋.
      controller?.setTurnOptions({ approvalPolicy: null });
      return;
    }
    // granular/미지원 값은 무시(정적 scalar 후보 밖).
    if (!availableApprovalPolicies.includes(policyId)) return;
    approvalSelection = policyId;
    approvalSentinelCommitted = false; // sentinel을 떠나므로 커밋 추적 해제.
    // 명시 scalar는 base와 같아도 그대로 전송한다. runtimeMetadata.approvalPolicy는 start/resume 시점 값이라
    // 이후 turn/start override로 실제 thread 정책이 바뀌어도 갱신되지 않는다 — base-equality로 null(provider
    // default revert)을 보내면 UI 표시(scalar)와 wire(provider default)가 분리돼 위험을 숨길 수 있다(Codex high).
    // null revert는 오직 "provider 기본값" sentinel에서만 보낸다.
    controller?.setTurnOptions({ approvalPolicy: policyId });
  }

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
    // OQ-16 Task 9: cold restart resume 소스는 암호화 저장소(loadedResumeKeys)다. props.agentRuntime의
    // provider id는 scrub(undefined)되므로, 로드된 키가 있으면 그 값으로 병합해 resume 판정/설정을 만든다.
    const restoreMeta: AgentRuntimeMetadata | undefined = loadedResumeKeys
      ? {
          ...(props.agentRuntime ?? { sessionRuntimeKind: runtimeKind, provider }),
          provider,
          providerThreadId: loadedResumeKeys.providerThreadId,
          providerSessionId: loadedResumeKeys.providerSessionId,
          canResume: loadedResumeKeys.canResume,
          canLoad: loadedResumeKeys.canLoad,
        }
      : props.agentRuntime;
    const resume = buildResumeConfig(restoreMeta);
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
    // OQ-16 Task 10: resume 소스가 없고(id 없음/미지원) 캐시 히스토리가 있으면 캐시를 read-only로
    // 유지하며 historyReadOnly affordance를 세운다(restoreUnavailable 대신). 캐시가 없던 미지원 케이스는
    // 기존 restoreUnavailable 경로 그대로 둔다.
    if (!resume && store.isReadOnlyHydrated) {
      historyReadOnly = true;
      restoreUnavailable = false;
    } else {
      historyReadOnly = false;
      restoreUnavailable = isRestoreUnavailable(restoreMeta);
    }
    resumeReplayPending = resume?.replay === true;
    // OQ-16 후속: resume 실패 시 read-only 히스토리로 복귀할 수 있게 캐시 모델을 보관한다.
    // 아래 discard뿐 아니라 실패 catch의 next.dispose()도 transcript를 통째로 비우므로
    // (unregisterSession → store.dispose()), replay 유무와 무관하게 start 전에 잡아둬야 한다.
    // discard/dispose는 모델을 교체할 뿐 변형하지 않으므로 보관한 참조는 안전하다.
    const stashedHistory: TranscriptModel | null = store.isReadOnlyHydrated
      ? store.getTranscript()
      : null;
    // OQ-16 Task 10: 권위 replay가 도착 예정(resume.replay)이면 start 직전에 read-only 캐시를 비워
    // replay가 transcript를 처음부터 재구성하게 한다(같은 provider item id의 중복 렌더 방지). replay가
    // 없는 재개(resume.replay===false)는 provider가 히스토리를 재방출하지 않으므로 캐시를 유지한다.
    if (resume?.replay === true && store.isReadOnlyHydrated) {
      store.discardReadOnlyHydration();
    }
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
        // cold restore의 replay/resume 실패: 캐시가 있었으면 read-only 히스토리로 복귀하고(10 §4.4a),
        // 없으면 복원 불가 notice를 남긴다(10 §4.4). 어느 쪽이든 새 direct 세션으로 낮춘다.
        await next.dispose();
        if (controller === next) controller = null;
        discardRuntimeMetadataAttempt(attemptId);
        // 재주입은 반드시 dispose 이후 — dispose가 unregisterSession → store.dispose()로
        // transcript(부분 replay item 포함)를 통째로 비우므로, 먼저 넣으면 다시 지워진다.
        // 두 notice는 독립 {#if}라 동시 렌더될 수 있으니 반드시 한쪽만 세운다.
        if (stashedHistory) {
          store.hydrateReadOnly(stashedHistory);
          historyReadOnly = true;
          restoreUnavailable = false;
        } else {
          historyReadOnly = false;
          restoreUnavailable = true;
        }
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

  // OQ-16: transcript 캐시 저장(전체 재직렬화)을 디바운스로 묶는 타이머. 재개 id 저장(saveResumeKeys)은
  // 값이 싸므로 즉시 저장하고, 이 타이머는 transcript 캐시 저장에만 적용한다.
  let cacheSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // OQ-16 Task 9: cold restart resume 소스. workspace.json의 provider id는 scrub(undefined)되므로,
  // 암호화 저장소(loadResumeKeys)에서 로드한 값을 buildResumeConfig/isRestoreUnavailable의 소스로 병합한다.
  // fresh 세션(props.agentRuntime 없음)에선 로드하지 않으므로 null로 남는다.
  let loadedResumeKeys: ResumeKeys | null = null;
  // OQ-16 Task 9: 실제 process spawn(start/resume)을 탭이 처음 보일 때(props.visible 최초 true)로 지연하는
  // 1회 가드. 앱 재시작 시 복원된 여러 direct 탭이 boot에서 동시에 프로세스를 띄워 AppHang 나는 것을 막는다.
  // fresh 세션은 생성 시 visible=true라 즉시 시작된다.
  let runtimeStartTriggered = false;
  // OQ-16 Task 9: 캐시 hydrate + resume-key 로드는 spawn과 무관하므로 mount 즉시 1회 시작하고, 지연된
  // start가 이 promise를 await한 뒤 spawn한다(hydrate가 spawn보다 먼저 끝나도록 순서 보장).
  let coldRestartHydration: Promise<void> | null = null;

  /** 짧은 시간 내 반복되는 metadata persist를 마지막 1건으로 합쳐 transcript 캐시 저장 IO 빈도를 완화한다. */
  function scheduleTranscriptCacheSave(): void {
    if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(() => {
      cacheSaveTimer = null;
      void saveTranscriptCache(props.sessionId, serializeTranscript(store.getTranscript()));
    }, 1000);
  }

  /** host teardown 공통 경계: tab close, component destroy, webview reload 모두 같은 shutdown을 탄다. */
  function disposeSurfaceRuntime(): void {
    if (surfaceDisposed) return;
    surfaceDisposed = true;
    if (sealTimer !== null) {
      clearInterval(sealTimer);
      sealTimer = null;
    }
    // pending transcript 캐시 저장은 unmount 시 유실돼도 무방하다(best-effort, 권위는 provider replay).
    if (cacheSaveTimer !== null) {
      clearTimeout(cacheSaveTimer);
      cacheSaveTimer = null;
    }
    void controller?.dispose();
  }

  /** webview reload/pagehide에서는 Svelte destroy 전에 backend shutdown을 best-effort로 시작한다. */
  function onPageTeardown(): void {
    disposeSurfaceRuntime();
  }

  /**
   * OQ-16 Task 8: cold restart(props.agentRuntime 존재) 시 provider resume가 시작되기 전에
   * 캐시된 지난 대화를 즉시 read-only로 렌더한다(process spawn 없음). 캐시가 없거나 스키마가
   * 안 맞으면 조용히 건너뛰고 기존 startRuntime 흐름(빈 화면에서 시작)으로 진행한다.
   * IO 실패(예: 캐시 파일 read 오류)도 같은 이유로 무시한다 — 캐시는 best-effort 즉시표시용이고
   * 권위 히스토리는 뒤이은 provider replay이므로 실패가 startRuntime 진행을 막으면 안 된다.
   * dedup/대체(캐시 item ↔ provider replay item)는 이 task 범위 밖이다(Task 10).
   */
  async function hydrateFromCacheIfColdRestart(): Promise<void> {
    if (!props.agentRuntime) return;
    // OQ-16 Task 9: cold restart resume 소스는 암호화 저장소다. process spawn을 탭 포커스로 지연해도
    // 키 로드는 spawn과 무관하므로 hydrate 단계에서 미리 로드해 startRuntime이 곧바로 쓸 수 있게 둔다.
    try {
      loadedResumeKeys = await loadResumeKeys(props.sessionId);
    } catch {
      // best-effort — 키 로드 실패 시 props.agentRuntime(대개 scrub) 기준으로 진행한다(복원 불가 notice).
      loadedResumeKeys = null;
    }
    try {
      const cached = await loadTranscriptCache(props.sessionId);
      const model = cached && deserializeTranscript(cached);
      if (model) store.hydrateReadOnly(model);
    } catch {
      // best-effort — 캐시 로드 실패는 무시하고 기존 startRuntime 흐름으로 진행한다.
    }
  }

  /**
   * OQ-16 Task 9: 지연된 실제 runtime 시작(process spawn). 탭이 처음 보일 때 1회만 호출된다.
   * 캐시 hydrate/resume-key 로드(coldRestartHydration)를 먼저 await해 hydrate가 spawn보다 앞서게 한다.
   */
  function triggerRuntimeStart(): void {
    if (runtimeStartTriggered) return;
    runtimeStartTriggered = true;
    // onMount와 이 $effect의 실행 순서에 의존하지 않도록, 아직 시작 안 됐으면 여기서 hydration을 킥한다.
    if (!coldRestartHydration) coldRestartHydration = hydrateFromCacheIfColdRestart();
    void coldRestartHydration.finally(() => {
      void startRuntime().finally(syncFallback);
    });
  }

  onMount(() => {
    // 캐시 hydrate/resume-key 로드는 process spawn과 무관하므로 지연 없이 mount 즉시 시작한다(브리프).
    // 지연 게이트($effect)가 아직 안 보이는 탭이면 spawn은 미뤄지지만 hydrate는 여기서 곧바로 진행된다.
    if (!coldRestartHydration) coldRestartHydration = hydrateFromCacheIfColdRestart();
    sealTimer = setInterval(() => store.flushSealAndEvict(), 1000);
    window.addEventListener("pagehide", onPageTeardown);
    window.addEventListener("beforeunload", onPageTeardown);
  });

  // OQ-16 Task 9: 실제 process spawn을 탭이 처음 보일 때(props.visible 최초 true)로 지연한다.
  // 앱 재시작 시 복원된 여러 direct 탭이 boot에서 동시에 spawn해 AppHang 나는 것을 막는다(§5, 예약된
  // 다중 세션 복원 작업과 동일 원칙). mount 시 이미 visible이면 즉시, 아니면 true가 되는 순간 1회만 시작한다.
  // fresh 세션은 생성 시 visible=true라 즉시 시작된다.
  $effect(() => {
    if (props.visible && !runtimeStartTriggered) {
      triggerRuntimeStart();
    }
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
    // sentinel 활성 중 prompt를 보내면 null override가 이 turn/start로 wire에 도달한다 — 이후 도착하는
    // settings echo가 revert 결과를 권위로 확정할 수 있게 커밋으로 표시한다(Codex medium 12차).
    if (approvalSelection === APPROVAL_DEFAULT_SELECTION) approvalSentinelCommitted = true;
    void controller?.submit(content);
  }

  /** stop → 진행 turn 취소. */
  function onStop(): void {
    void controller?.cancel();
  }

  /** 세션 모드 셀렉터 → controller.setSessionMode(지원 provider만). 거부 시 composer가
   *  권위 값으로 롤백하도록 promise를 그대로 전달한다(실패를 삼키지 않는다). */
  function onModeChange(modeId: string): Promise<void> {
    return controller?.setSessionMode(modeId) ?? Promise.resolve();
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

  // FE-25 후속: agentRuntime 설정을 scoped CSS 변수로만 주입한다(--ui-* 전역 토큰과 분리).
  // null(상속)은 변수 자체를 내보내지 않아 CSS fallback(var(--agent-…, var(--ui-…)))이 동작한다.
  const appSettings = getSettings();
  const agentTranscriptStyleVars = $derived.by(() => {
    const s = appSettings.agentRuntime;
    const vars: string[] = [];
    if (s.fontSize !== null) vars.push(`--agent-transcript-font-size: ${s.fontSize}px`);
    if (s.fontFamily !== null) vars.push(`--agent-transcript-font-stack: ${s.fontFamily}`);
    if (s.codeFontFamily !== null) {
      vars.push(`--agent-transcript-code-font-stack: ${s.codeFontFamily}`);
    }
    return vars.join("; ");
  });
</script>

<div
  class="agent-runtime-shell"
  class:hidden={!props.visible}
  data-testid={TEST_IDS.agentRuntimeShell}
  style={agentTranscriptStyleVars}
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

    {#if historyReadOnly}
      <!-- OQ-16 Task 10: resume 불가(id 없음/미지원) + 캐시 존재 → 이전 대화를 read-only로 유지하고
           이 새 세션에서 아래로 이어가도록 안내하는 정보성 notice(v1은 버튼 없음, 정보 표시만). -->
      <div
        class="restore-unavailable-notice"
        role="status"
        data-testid={TEST_IDS.agentHistoryReadOnlyNotice}
      >
        {$t("agentRuntime.transcript.historyReadOnly")}
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
        {#if runtimeMetadata.approvalPolicy || approvalOverrideActive || approvalPolicyUnknown}
          <div
            class="metadata-item"
            class:metadata-item--warning={approvalHighRisk}
            data-risk={approvalHighRisk ? "high" : undefined}
          >
            <dt>{$t("agentRuntime.metadata.approval")}</dt>
            <dd>
              <!-- 실효 정책이 미상(replay 또는 provider 기본값 revert)이면 stale base scalar를 안전한 것처럼
                   보여주지 않고 unknown으로 표기한다(Codex high 4차). -->
              {approvalPolicyUnknown
                ? $t("agentRuntime.metadata.unknownValue")
                : (runtimeMetadata.approvalPolicy ?? $t("agentRuntime.metadata.unknownValue"))}
              {#if approvalOverrideActive}
                <!-- 다음 turn에 적용될 override가 세션 시작 권위값과 달라 위험을 숨기지 않도록 chip으로 노출한다. -->
                <span
                  class="metadata-override-chip"
                  class:metadata-override-chip--warning={isHighRiskApprovalPolicy(approvalOverrideActive)}
                  data-testid={TEST_IDS.agentRuntimeApprovalOverride}
                >
                  {$t("agentRuntime.metadata.overrideChip", { values: { value: approvalOverrideActive } })}
                </span>
              {/if}
              {#if approvalHighRisk}
                <!-- 실효 정책(override ?? base)이 never면 base가 이미 never인 경우에도 고위험 표시한다(은닉 방지). -->
                <span class="metadata-risk-label">{$t("agentRuntime.metadata.highRisk")}</span>
              {/if}
            </dd>
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
    availableModes={runtimeMetadata?.availableModes}
    currentModeId={runtimeMetadata?.sessionMode ?? runtimeMetadata?.permissionMode}
    {availableModels}
    {selectedModel}
    selectedEffort={selectedEffort}
    modelEfforts={selectedModelEfforts}
    availableCommands={store.availableCommands}
    capabilities={store.capabilities}
    resourceSearch={searchResourceMentions}
    restoring={resumeReplayPending}
    {onSend}
    {onStop}
    {availableApprovalPolicies}
    {selectedApprovalPolicy}
    approvalHighRisk={approvalHighRisk}
    currentSandbox={runtimeMetadata?.sandbox}
    {onModeChange}
    {onModelChange}
    {onEffortChange}
    {onApprovalPolicyChange}
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
    /* host baseline: UI 글꼴/크기 토큰을 명시 상속(테마·uiScale·uiFont 자동 반영, 08 §설정).
       agentRuntime 설정이 있으면 scoped 변수(--agent-transcript-*)가 우선한다(FE-25 후속). */
    font-family: var(--agent-transcript-font-stack, var(--ui-font-stack));
    font-size: var(--agent-transcript-font-size, var(--ui-font-size-base));
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
