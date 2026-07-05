<!--
  AgentComposer — 입력 박스 + send/stop(08 §6).

  Stage 1 범위: multiline text 입력 + Enter 전송(Shift+Enter 개행) + slash command palette +
  workspace file @mention + resource action button + image attachment + status별 send↔stop 전환.
  provider-backed resource source는 props로 주입받고, `$` trigger는 후속 stage. UI 문자열은 i18n 키만 쓴다(하드코딩 금지).
  status가 running/requires_action이면 stop, requires_action이면 입력 비활성+승인 대기 안내.
-->
<script lang="ts">
  import { formatImageSize, MAX_CLIPBOARD_IMAGE_BYTES } from "../../../clipboard";
  import { t } from "../../../i18n";
  import { TEST_IDS } from "../../../testids";
  import type {
    AgentCommand,
    AgentContent,
    AgentSessionModeOption,
    AgentSessionStatus,
  } from "../contracts/normalized";
  import type { ComposerCapabilities } from "../contracts/transcript";

  const DEFAULT_CAPABILITIES: ComposerCapabilities = {
    image: false,
    embeddedContext: false,
    audio: false,
  };

  /** composer `@` file/resource mention 후보. */
  interface ResourceMentionSuggestion {
    label: string;
    uri: string;
    detail?: string;
    mimeType?: string;
    resourceKind?: "file" | "skill";
    text?: string;
  }

  /** 전송 대기 중인 image attachment. */
  interface ImageAttachment {
    id: string;
    name: string;
    referenceText: string;
    uri: string;
    mimeType: string;
    size: number;
  }

  /** draft 끝에 열린 `@` mention token과 그 앞 prefix. */
  interface ResourceMentionTrigger {
    query: string;
    prefix: string;
  }

  /** image reference token을 draft에 넣을 textarea selection 범위. */
  interface DraftInsertionRange {
    start: number;
    end: number;
  }

  interface Props {
    /** 세션 상태(입력 활성/버튼 전환 게이팅). */
    status: AgentSessionStatus;
    /** provider 식별자(중립 라벨, 브랜딩 제약 09). */
    providerLabel: string;
    /** 현재 provider permission/session mode 또는 sandbox 표시값(08 §6.5 indicator). */
    modeLabel?: string;
    /** 텍스트 전송 콜백. */
    onSend: (content: AgentContent[]) => void;
    /** 진행 turn 취소 콜백. */
    onStop: () => void;
    /** provider가 알린 슬래시 커맨드 목록(팔레트 소스). */
    availableCommands?: AgentCommand[];
    /** 세션 모드 전환 후보(있으면 셀렉터 노출). 없으면 modeLabel만 표시(읽기 전용). */
    availableModes?: AgentSessionModeOption[];
    /** 현재 세션 모드 id(셀렉터 선택값). */
    currentModeId?: string;
    /** 모드 셀렉터 변경 콜백(지원 provider만 전달). 거부/실패 시 reject하는 promise를 돌려주면
     *  셀렉터를 권위 값으로 롤백한다. */
    onModeChange?: (modeId: string) => void | Promise<void>;
    /** provider prompt capability. image 버튼 노출과 전송 gate에 사용한다. */
    capabilities?: ComposerCapabilities;
    /** `@` mention query를 workspace/resource 후보로 변환하는 검색 함수. */
    resourceSearch?: (query: string) => Promise<ResourceMentionSuggestion[]>;
    /** session/load replay 복원 중인지 여부(복원 중에는 입력을 잠근다). */
    restoring?: boolean;
  }

  let {
    status,
    providerLabel,
    modeLabel,
    onSend,
    onStop,
    availableCommands = [],
    availableModes,
    currentModeId,
    onModeChange,
    capabilities = DEFAULT_CAPABILITIES,
    resourceSearch,
    restoring = false,
  }: Props = $props();

  let draft = $state("");
  // 슬래시 팔레트 선택 인덱스 + Escape로 닫은 query(같은 query에선 다시 안 뜨게).
  let selectedIndex = $state(0);
  let dismissedQuery = $state<string | null>(null);
  // resource mention 팔레트 상태. 검색 결과는 async라 stale response를 seq로 버린다.
  let resourceSelectedIndex = $state(0);
  let dismissedResourceQuery = $state<string | null>(null);
  let resourceSuggestions = $state<ResourceMentionSuggestion[]>([]);
  let selectedResources = $state<ResourceMentionSuggestion[]>([]);
  let imageAttachments = $state<ImageAttachment[]>([]);
  let imageError = $state<string | null>(null);
  let resourceSearchSeq = 0;
  let imageAttachmentSeq = 0;
  let inputEl: HTMLTextAreaElement | undefined;
  let imageInputEl = $state<HTMLInputElement | undefined>();

  // turn이 실행 중이거나 승인 대기 중이면 cancel cleanup을 위해 stop 버튼을 유지한다.
  const canStop = $derived(!restoring && (status === "running" || status === "requires_action"));
  // 입력 활성 조건: ready/idle/running만 입력 가능(승인 대기·시작·종료는 비활성).
  const inputEnabled = $derived(
    !restoring && (status === "ready" || status === "idle" || status === "running"),
  );
  // 모드 셀렉터: idle/ready에서만 활성(전송 중·승인 대기·시작/종료 중에는 잠금). 변경 요청이
  // 진행 중이면 잠가 이중 요청을 막고, 거부 시 권위 값으로 롤백해 provider 상태와의 desync를 막는다.
  let modeChangePending = $state(false);
  const modeSelectEnabled = $derived(
    !restoring && !modeChangePending && (status === "ready" || status === "idle"),
  );

  async function handleModeChange(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const nextModeId = select.value;
    // 셀렉터는 provider가 확정한 권위 모드(currentModeId)만 표시한다. 사용자의 선택은 요청만 보내고,
    // 화면 값은 즉시 권위 값으로 되돌린다 — 요청이 수락되면 current_mode_update가 currentModeId를
    // 갱신해 reactive value 바인딩이 옮기고, 실패/미확정이면 계속 권위 값에 머문다(desync 없음).
    select.value = currentModeId ?? "";
    if (!onModeChange || nextModeId === (currentModeId ?? "")) return;
    modeChangePending = true;
    try {
      await onModeChange(nextModeId);
    } catch {
      // 거부/실패: 이미 권위 값으로 표시 중이므로 추가 롤백 불필요.
    } finally {
      modeChangePending = false;
    }
  }

  const placeholder = $derived(
    restoring
      ? $t("agentRuntime.composer.restoring")
      : status === "requires_action"
        ? $t("agentRuntime.status.requiresAction")
        : inputEnabled
          ? $t("agentRuntime.composer.placeholder")
          : $t("agentRuntime.composer.disabled"),
  );
  const visibleModeLabel = $derived(modeLabel?.trim() ?? "");
  const imageAttachAvailable = $derived(capabilities.image === true);
  const hasImageAttachmentFeedback = $derived(imageAttachments.length !== 0 || imageError !== null);
  const canSendPrompt = $derived(
    inputEnabled && (draft.trim().length > 0 || selectedResourcesInDraft().length > 0 || imageAttachments.length > 0),
  );

  // ── 슬래시 커맨드 팔레트(08 §6, /resume 등). provider-backed 목록 없는 Codex는 로컬 /resume만.
  // 트리거: draft 전체가 "/" + 공백/개행 없는 첫 토큰(예: "/res"). 인자 입력(공백 후)에선 닫힘.
  const slashQuery = $derived(/^\/[^\s]*$/.test(draft) ? draft.slice(1) : null);
  // 트리거: draft 끝 token이 "@" + 공백/개행 없는 query일 때 파일 mention 팔레트.
  const resourceTrigger = $derived(findResourceMentionTrigger(draft));
  const resourceQuery = $derived(resourceTrigger?.query ?? null);

  // provider 목록 + 로컬 보강(provider에 없을 때만 /resume 추가).
  const allCommands = $derived.by<AgentCommand[]>(() => {
    const byName = new Map<string, AgentCommand>();
    for (const c of availableCommands) {
      const name = normalizeCommandName(c.name);
      if (name) byName.set(normalizeCommandKey(name), { ...c, name });
    }
    if (!byName.has("resume")) {
      byName.set("resume", { name: "resume", description: $t("agentRuntime.composer.commandResume") });
    }
    return [...byName.values()];
  });

  const paletteCommands = $derived.by<AgentCommand[]>(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return allCommands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  const paletteOpen = $derived(
    inputEnabled && slashQuery !== null && slashQuery !== dismissedQuery && paletteCommands.length > 0,
  );
  const resourcePaletteOpen = $derived(
    inputEnabled &&
      resourceQuery !== null &&
      resourceQuery !== dismissedResourceQuery &&
      resourceSuggestions.length > 0,
  );

  // query가 바뀌면 선택을 처음으로 되돌린다.
  $effect(() => {
    void slashQuery;
    selectedIndex = 0;
  });
  $effect(() => {
    void resourceQuery;
    resourceSelectedIndex = 0;
  });

  // resource query가 바뀔 때 workspace 파일 후보를 비동기로 갱신한다.
  $effect(() => {
    const query = resourceQuery;
    const search = resourceSearch;
    const seq = ++resourceSearchSeq;
    if (!inputEnabled || query === null || query === dismissedResourceQuery || !search) {
      resourceSuggestions = [];
      return;
    }
    void search(query)
      .then((results) => {
        if (seq !== resourceSearchSeq) return;
        resourceSuggestions = normalizeResourceSuggestions(results);
      })
      .catch(() => {
        if (seq === resourceSearchSeq) resourceSuggestions = [];
      });
  });

  /** 팔레트에서 커맨드 선택 → draft를 "/<name> "으로 채우고 팔레트를 닫는다(전송은 평문 텍스트). */
  function acceptCommand(cmd: AgentCommand | undefined): void {
    if (!cmd) return;
    const name = normalizeCommandName(cmd.name);
    if (!name) return;
    draft = `/${name} `;
    dismissedQuery = null;
  }

  /** provider command name을 내부 UI 정본(선두 slash 없음)으로 맞춘다. */
  function normalizeCommandName(name: string): string {
    return name.trim().replace(/^\/+/, "");
  }

  /** command 중복 판단은 provider casing 차이를 무시한다. */
  function normalizeCommandKey(name: string): string {
    return name.toLowerCase();
  }

  /** 검색 결과를 표시/전송 가능한 resource mention 후보로 정규화하고 uri 중복을 제거한다. */
  function normalizeResourceSuggestions(results: ResourceMentionSuggestion[]): ResourceMentionSuggestion[] {
    const byUri = new Map<string, ResourceMentionSuggestion>();
    for (const result of results) {
      const label = result.label.trim();
      const uri = result.uri.trim();
      if (!label || !uri) continue;
      if (!byUri.has(uri)) byUri.set(uri, { ...result, label, uri });
    }
    return [...byUri.values()];
  }

  /** draft 끝의 mention token을 찾아 선택 시 보존할 prefix와 query를 돌려준다. */
  function findResourceMentionTrigger(value: string): ResourceMentionTrigger | null {
    const match = /(^|\s)@([^\s]*)$/.exec(value);
    if (!match) return null;
    return {
      prefix: value.slice(0, match.index + match[1].length),
      query: match[2],
    };
  }

  /** draft에 삽입되는 mention token. label은 검색 결과의 상대 경로를 사용한다. */
  function resourceToken(resource: ResourceMentionSuggestion): string {
    return `@${resource.label}`;
  }

  /** 현재 draft에 token이 남아 있는 resource만 전송 대상에 포함한다. */
  function selectedResourcesInDraft(): ResourceMentionSuggestion[] {
    return selectedResources.filter((resource) => resourceTokenExists(draft, resourceToken(resource)));
  }

  /** mention token이 공백/문장 경계 안에 그대로 남아 있는지 확인한다. */
  function resourceTokenExists(value: string, token: string): boolean {
    let cursor = 0;
    while (cursor <= value.length) {
      const index = value.indexOf(token, cursor);
      if (index === -1) return false;
      const before = index === 0 ? "" : value[index - 1];
      const after = value[index + token.length] ?? "";
      if (isMentionBoundary(before) && isMentionBoundary(after)) return true;
      cursor = index + token.length;
    }
    return false;
  }

  /** mention token 앞뒤에서 허용되는 경계 문자다. */
  function isMentionBoundary(value: string): boolean {
    return value === "" || /\s/.test(value);
  }

  /** resource 후보 선택 → draft에 @path token을 넣고 resource content를 전송 대기 목록에 보존한다. */
  function acceptResource(resource: ResourceMentionSuggestion | undefined): void {
    if (!resource) return;
    const normalized = normalizeResourceSuggestions([resource])[0];
    if (!normalized) return;
    const prefix = resourceTrigger?.prefix ?? "";
    draft = `${prefix}${resourceToken(normalized)} `;
    dismissedResourceQuery = null;
    resourceSuggestions = [];
    selectedResources = [
      ...selectedResources.filter((existing) => existing.uri !== normalized.uri),
      normalized,
    ];
  }

  /** resource 버튼으로 현재 draft 끝에 @mention token을 열고 입력 focus를 유지한다. */
  function openResourceMention(): void {
    if (!inputEnabled || !resourceSearch) return;
    if (!findResourceMentionTrigger(draft)) {
      const separator = draft.length === 0 || /\s$/.test(draft) ? "" : " ";
      draft = `${draft}${separator}@`;
    }
    dismissedResourceQuery = null;
    inputEl?.focus();
  }

  /** image 파일 선택창을 열고 입력 focus를 유지한다. */
  function openImagePicker(): void {
    if (!inputEnabled || !imageAttachAvailable) return;
    imageInputEl?.click();
    inputEl?.focus();
  }

  /** FileReader로 image file을 data URI로 변환한다(ACP prompt image 송신 형식). */
  function readFileAsDataUri(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error("image read failed"));
        }
      };
      reader.readAsDataURL(file);
    });
  }

  /** image attachment가 draft에서 참조될 때 쓰는 위치 토큰이다. */
  function imageReferenceText(index: number): string {
    return `[${$t("agentRuntime.composer.imageAttachment")} #${index}]`;
  }

  /** 현재 attachment 목록 뒤에 추가될 image reference token을 순서대로 만든다. */
  function nextImageReferenceText(pendingCount: number): string {
    return imageReferenceText(imageAttachments.length + pendingCount + 1);
  }

  /** draft가 비어 있지 않으면 image reference token을 지정 위치에 추가한다. */
  function insertImageReferencesIntoDraft(
    references: string[],
    range?: DraftInsertionRange,
  ): void {
    if (references.length === 0 || draft.trim().length === 0) return;
    const start = Math.max(0, Math.min(range?.start ?? draft.length, draft.length));
    const end = Math.max(start, Math.min(range?.end ?? start, draft.length));
    const before = draft.slice(0, start).replace(/[ \t]+$/g, "");
    const after = draft.slice(end).replace(/^[ \t]+/g, "");
    draft = [before, references.join(" "), after].filter(Boolean).join(" ");
  }

  /** textarea의 현재 selection range를 image paste/drop 시작 시점에 보존한다. */
  function currentDraftInsertionRange(target: HTMLTextAreaElement): DraftInsertionRange {
    const start = target.selectionStart ?? draft.length;
    const end = target.selectionEnd ?? start;
    return { start, end };
  }

  /** attachment 제거 시 대응하는 image reference token도 draft에서 제거한다. */
  function removeImageReferenceFromDraft(referenceText: string): void {
    if (!draft.includes(referenceText)) return;
    draft = draft
      .replace(referenceText, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/^\s+|\s+$/g, "");
  }

  /** attachment 순서가 바뀐 뒤 draft와 chip의 image reference 번호를 다시 맞춘다. */
  function renumberImageAttachments(attachments: ImageAttachment[]): ImageAttachment[] {
    return attachments.map((image, index) => {
      const referenceText = imageReferenceText(index + 1);
      if (referenceText === image.referenceText) return image;
      if (draft.includes(image.referenceText)) {
        draft = draft.replace(image.referenceText, referenceText);
      }
      return { ...image, referenceText };
    });
  }

  /** DataTransfer/ClipboardData에서 image file만 추출한다. */
  function imageFilesFromTransfer(data: DataTransfer | null): File[] {
    if (!data) return [];
    const files: File[] = [];
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length > 0) return files;
    return Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
  }

  /** image file 목록을 전송 대기 attachment로 변환한다. */
  async function addImageFiles(
    files: File[],
    insertionRange?: DraftInsertionRange,
  ): Promise<void> {
    imageError = null;
    const next: ImageAttachment[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_CLIPBOARD_IMAGE_BYTES) {
        imageError = $t("agentRuntime.composer.imageTooLarge");
        continue;
      }
      try {
        const imageId = ++imageAttachmentSeq;
        next.push({
          id: `image-${imageId}`,
          name: file.name || $t("agentRuntime.composer.imageAttachment"),
          referenceText: nextImageReferenceText(next.length),
          uri: await readFileAsDataUri(file),
          mimeType: file.type || "image/png",
          size: file.size,
        });
      } catch {
        imageError = $t("agentRuntime.composer.imageReadFailed");
      }
    }
    if (next.length > 0) {
      imageAttachments = [...imageAttachments, ...next];
      insertImageReferencesIntoDraft(next.map((image) => image.referenceText), insertionRange);
    }
  }

  /** 파일 선택 input에서 고른 image를 attachment로 등록한다. */
  async function onImageInputChange(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    await addImageFiles(Array.from(input.files ?? []));
    input.value = "";
  }

  /** clipboard image paste를 attachment로 등록한다. 일반 text paste는 그대로 둔다. */
  async function onPaste(event: ClipboardEvent): Promise<void> {
    if (!inputEnabled || !imageAttachAvailable) return;
    const files = imageFilesFromTransfer(event.clipboardData);
    if (files.length === 0) return;
    const insertionRange = currentDraftInsertionRange(event.currentTarget as HTMLTextAreaElement);
    event.preventDefault();
    await addImageFiles(files, insertionRange);
  }

  /** drag 중 image drop 가능 여부를 브라우저에 알린다. */
  function onDragOver(event: DragEvent): void {
    if (!inputEnabled || !imageAttachAvailable) return;
    if (imageFilesFromTransfer(event.dataTransfer).length === 0) return;
    event.preventDefault();
  }

  /** drop된 image file을 attachment로 등록한다. */
  async function onDrop(event: DragEvent): Promise<void> {
    if (!inputEnabled || !imageAttachAvailable) return;
    const files = imageFilesFromTransfer(event.dataTransfer);
    if (files.length === 0) return;
    const insertionRange = currentDraftInsertionRange(event.currentTarget as HTMLTextAreaElement);
    event.preventDefault();
    await addImageFiles(files, insertionRange);
  }

  /** 선택된 image attachment를 전송 대기 목록에서 제거한다. */
  function removeImageAttachment(id: string): void {
    const removed = imageAttachments.find((image) => image.id === id);
    imageAttachments = renumberImageAttachments(imageAttachments.filter((image) => image.id !== id));
    if (removed) removeImageReferenceFromDraft(removed.referenceText);
    if (imageAttachments.length === 0) imageAttachmentSeq = 0;
  }

  /** 입력을 전송하고 draft를 비운다(빈 입력은 무시). */
  function send(): void {
    const text = draft.trim();
    const resources = selectedResourcesInDraft();
    if ((text.length === 0 && resources.length === 0 && imageAttachments.length === 0) || !inputEnabled) return;
    const content: AgentContent[] = [];
    if (text.length > 0) content.push({ type: "text", text });
    for (const image of imageAttachments) {
      content.push({
        type: "image",
        uri: image.uri,
        mimeType: image.mimeType,
      });
    }
    for (const resource of resources) {
      content.push({
        type: "resource",
        uri: resource.uri,
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        ...(resource.text ? { text: resource.text } : {}),
        ...(resource.resourceKind ? { resourceKind: resource.resourceKind } : {}),
      });
    }
    onSend(content);
    draft = "";
    dismissedQuery = null;
    dismissedResourceQuery = null;
    selectedResources = [];
    imageAttachments = [];
    imageAttachmentSeq = 0;
    imageError = null;
  }

  /** Enter=전송, Shift+Enter=개행. 팔레트 열림 시 ↑↓ 이동 / Enter·Tab 선택 / Esc 닫기. */
  function onKeydown(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    if (e.ctrlKey && (key === "t" || key === "w")) {
      e.stopPropagation();
      return;
    }
    if (paletteOpen) {
      const n = paletteCommands.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % n;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIndex = (selectedIndex - 1 + n) % n;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptCommand(paletteCommands[Math.min(selectedIndex, n - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissedQuery = slashQuery;
        return;
      }
    }
    if (resourcePaletteOpen) {
      const n = resourceSuggestions.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        resourceSelectedIndex = (resourceSelectedIndex + 1) % n;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        resourceSelectedIndex = (resourceSelectedIndex - 1 + n) % n;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptResource(resourceSuggestions[Math.min(resourceSelectedIndex, n - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissedResourceQuery = resourceQuery;
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!canStop) send();
    }
  }
</script>

<div class="agent-composer" data-testid={TEST_IDS.agentComposer}>
  {#if paletteOpen}
    <ul
      class="command-palette"
      data-testid={TEST_IDS.agentComposerCommandPalette}
      role="listbox"
      aria-label={$t("agentRuntime.composer.commandPalette")}
    >
      {#each paletteCommands as cmd, i (cmd.name)}
        <li
          class="command-option"
          class:active={i === Math.min(selectedIndex, paletteCommands.length - 1)}
          data-testid={TEST_IDS.agentComposerCommandOption}
          role="option"
          aria-selected={i === Math.min(selectedIndex, paletteCommands.length - 1)}
        >
          <button type="button" class="command-option-btn" onclick={() => acceptCommand(cmd)}>
            <span class="command-name">/{cmd.name}</span>
            {#if cmd.description || cmd.inputHint}
              <span class="command-desc">{cmd.description ?? ""}{cmd.inputHint ? ` ${cmd.inputHint}` : ""}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if resourcePaletteOpen}
    <ul
      class="command-palette resource-palette"
      data-testid={TEST_IDS.agentComposerResourcePalette}
      role="listbox"
      aria-label={$t("agentRuntime.composer.resourcePalette")}
    >
      {#each resourceSuggestions as resource, i (resource.uri)}
        <li
          class="command-option"
          class:active={i === Math.min(resourceSelectedIndex, resourceSuggestions.length - 1)}
          data-testid={TEST_IDS.agentComposerResourceOption}
          role="option"
          aria-selected={i === Math.min(resourceSelectedIndex, resourceSuggestions.length - 1)}
        >
          <button type="button" class="command-option-btn" onclick={() => acceptResource(resource)}>
            <span class="command-name">@{resource.label}</span>
            {#if resource.detail}
              <span class="command-desc">{resource.detail}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <textarea
    class="composer-input"
    data-testid={TEST_IDS.agentComposerInput}
    bind:this={inputEl}
    bind:value={draft}
    placeholder={placeholder}
    rows="2"
    disabled={!inputEnabled}
    onkeydown={onKeydown}
    onpaste={onPaste}
    ondragover={onDragOver}
    ondrop={onDrop}
  ></textarea>
  {#if hasImageAttachmentFeedback}
    <div class="image-attachments" aria-live="polite">
      {#each imageAttachments as image (image.id)}
        <span class="image-attachment" data-testid={TEST_IDS.agentComposerImageAttachment}>
          <span class="image-attachment-reference">{image.referenceText}</span>
          <span class="image-attachment-name">{image.name}</span>
          <span class="image-attachment-size">{formatImageSize(image.size)}</span>
          <button
            type="button"
            class="image-attachment-remove"
            aria-label={$t("agentRuntime.composer.removeImage")}
            title={$t("agentRuntime.composer.removeImage")}
            disabled={!inputEnabled}
            onclick={() => removeImageAttachment(image.id)}
          >
            ×
          </button>
        </span>
      {/each}
      {#if imageError}
        <span class="image-attachment-error">{imageError}</span>
      {/if}
    </div>
  {/if}
  <div class="composer-footer">
    <div class="composer-indicators">
      <span class="provider-label" title={providerLabel}>{providerLabel}</span>
      {#if onModeChange && availableModes && availableModes.length > 0}
        <!-- 모드 셀렉터: provider가 availableModes를 알린 경우에만(예: Claude plan/acceptEdits 등). -->
        <select
          class="mode-select"
          data-testid={TEST_IDS.agentComposerModeSelect}
          value={currentModeId ?? ""}
          disabled={!modeSelectEnabled}
          aria-label={$t("agentRuntime.composer.modeSelect")}
          onchange={handleModeChange}
        >
          {#each availableModes as mode (mode.id)}
            <option value={mode.id}>{mode.name ?? mode.id}</option>
          {/each}
        </select>
      {:else if visibleModeLabel}
        <span class="mode-label" title={visibleModeLabel}>{visibleModeLabel}</span>
      {/if}
    </div>
    <div class="composer-controls">
      {#if imageAttachAvailable}
        <input
          bind:this={imageInputEl}
          class="image-input"
          data-testid={TEST_IDS.agentComposerImageInput}
          type="file"
          accept="image/*"
          multiple
          disabled={!inputEnabled}
          onchange={onImageInputChange}
        />
        <button
          type="button"
          class="composer-tool image-tool"
          data-testid={TEST_IDS.agentComposerImageButton}
          aria-label={$t("agentRuntime.composer.imageButton")}
          title={$t("agentRuntime.composer.imageButton")}
          disabled={!inputEnabled}
          onclick={openImagePicker}
        >
          <span class="image-tool-icon" aria-hidden="true"></span>
        </button>
      {/if}
      {#if resourceSearch}
        <button
          type="button"
          class="composer-tool"
          data-testid={TEST_IDS.agentComposerResourceButton}
          aria-label={$t("agentRuntime.composer.resourceButton")}
          title={$t("agentRuntime.composer.resourceButton")}
          disabled={!inputEnabled}
          onclick={openResourceMention}
        >
          @
        </button>
      {/if}
      {#if canStop}
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
          disabled={!canSendPrompt}
          onclick={send}
        >
          {$t("agentRuntime.composer.send")}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .agent-composer {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.6rem 0.75rem;
    border-top: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.25));
    background: var(--ui-bg-surface, rgba(127, 127, 127, 0.04));
  }
  .command-palette {
    position: absolute;
    left: 0.75rem;
    right: 0.75rem;
    bottom: calc(100% - 0.4rem);
    z-index: 5;
    margin: 0;
    padding: 0.25rem;
    list-style: none;
    max-height: 14rem;
    overflow-y: auto;
    border: 1px solid var(--ui-border-strong, rgba(127, 127, 127, 0.4));
    border-radius: var(--ui-radius-md, 0.5rem);
    background: var(--ui-bg-elevated, #1c1c1c);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  .command-option {
    border-radius: var(--ui-radius-sm, 0.3rem);
  }
  .command-option.active {
    background: var(--ui-accent-soft, rgba(127, 127, 127, 0.18));
  }
  .command-option-btn {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    width: 100%;
    text-align: left;
    padding: 0.3rem 0.5rem;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .command-name {
    font-size: var(--ui-font-size-sm);
    font-family: var(--ui-font-mono-stack);
    color: var(--ui-accent, #4a90d9);
  }
  .command-desc {
    font-size: var(--ui-font-size-xs);
    color: var(--ui-text-muted);
  }
  .composer-input {
    width: 100%;
    resize: vertical;
    min-height: 2.5rem;
    font: inherit;
    padding: 0.45rem 0.55rem;
    border-radius: 0.45rem;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.3));
    background: var(--ui-bg-app, transparent);
    color: inherit;
    box-sizing: border-box;
  }
  .composer-input:disabled {
    opacity: 0.5;
  }
  .image-attachments {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
    min-height: 1.5rem;
  }
  .image-attachment {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    max-width: min(18rem, 100%);
    padding: 0.2rem 0.35rem;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.3));
    border-radius: 0.35rem;
    background: var(--ui-bg-app, rgba(127, 127, 127, 0.08));
    font-size: var(--ui-font-size-xs);
  }
  .image-attachment-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .image-attachment-reference {
    flex-shrink: 0;
    font-family: var(--ui-font-mono-stack);
    color: var(--ui-accent, #4a90d9);
  }
  .image-attachment-size {
    flex-shrink: 0;
    opacity: 0.65;
  }
  .image-attachment-remove {
    width: 1.1rem;
    height: 1.1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    line-height: 1;
  }
  .image-attachment-remove:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .image-attachment-error {
    color: var(--ui-danger, #f85149);
    font-size: var(--ui-font-size-xs);
  }
  .composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .composer-indicators {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }
  .provider-label {
    font-size: var(--ui-font-size-xs);
    opacity: 0.55;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mode-label {
    min-width: 0;
    padding-left: 0.35rem;
    border-left: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.25));
    font-size: var(--ui-font-size-xs);
    opacity: 0.72;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mode-select {
    margin-left: 0.35rem;
    padding: 0.1rem 0.3rem;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.3));
    border-radius: var(--ui-radius-sm, 0.25rem);
    background: var(--ui-bg-elevated, transparent);
    color: inherit;
    font-size: var(--ui-font-size-xs);
    max-width: 12ch;
  }
  .composer-controls {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
  }
  .composer-tool {
    width: 1.9rem;
    height: 1.9rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font: inherit;
    font-size: var(--ui-font-size-sm);
    font-family: var(--ui-font-mono-stack);
    border-radius: 0.35rem;
    border: 1px solid var(--ui-border-subtle, rgba(127, 127, 127, 0.3));
    background: var(--ui-bg-app, transparent);
    color: var(--ui-text, inherit);
    cursor: pointer;
  }
  .composer-tool:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .image-input {
    display: none;
  }
  .image-tool-icon {
    position: relative;
    width: 1rem;
    height: 0.82rem;
    border: 1.5px solid currentColor;
    border-radius: 0.18rem;
    box-sizing: border-box;
  }
  .image-tool-icon::before {
    content: "";
    position: absolute;
    right: 0.13rem;
    top: 0.13rem;
    width: 0.18rem;
    height: 0.18rem;
    border-radius: 999px;
    background: currentColor;
  }
  .image-tool-icon::after {
    content: "";
    position: absolute;
    left: 0.15rem;
    bottom: 0.12rem;
    width: 0.55rem;
    height: 0.35rem;
    border-left: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: skewX(-25deg);
  }
  .composer-action {
    font: inherit;
    font-size: var(--ui-font-size-sm);
    padding: 0.35rem 0.85rem;
    border-radius: 0.4rem;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .composer-action.send {
    background: var(--ui-accent, #4a90d9);
    color: var(--ui-accent-text, #fff);
  }
  .composer-action.send:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .composer-action.stop {
    background: var(--ui-danger, #f85149);
    color: var(--ui-accent-text, #fff);
  }
</style>
