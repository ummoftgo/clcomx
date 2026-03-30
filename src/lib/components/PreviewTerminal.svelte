<script lang="ts">
  import { _ as translate } from "svelte-i18n";
  import TerminalAssistPanel from "./TerminalAssistPanel.svelte";
  import TerminalAuxPanel from "./TerminalAuxPanel.svelte";
  import { getAgentLabel } from "../agents";

  interface Props {
    sessionId: string;
    visible: boolean;
    agentId: string;
    distro: string;
    workDir: string;
    ptyId: number;
    storedAuxPtyId?: number;
    storedAuxVisible?: boolean;
    storedAuxHeightPercent?: number | null;
    resumeToken?: string | null;
    onPtyId?: (ptyId: number) => void;
    onAuxStateChange?: (state: {
      auxPtyId: number;
      auxVisible: boolean;
      auxHeightPercent: number | null;
    }) => void;
    onExit?: (ptyId: number) => void;
    onResumeFallback?: () => void;
  }

  type PreviewLineKind = "meta" | "command" | "output" | "accent";

  interface PreviewLine {
    kind: PreviewLineKind;
    text: string;
  }

  function createPreviewTranscript(agentId: string, workDir: string): PreviewLine[] {
    if (agentId === "codex") {
      return [
        { kind: "meta", text: "Preview mode · PTY disconnected" },
        { kind: "command", text: `$ cd ${workDir}` },
        { kind: "command", text: "$ rg -n \"custom.css|preview.html|style layer\" src" },
        { kind: "output", text: "src/lib/ui/style-layers.ts" },
        { kind: "output", text: "src/lib/app-start.ts" },
        { kind: "accent", text: "Mock terminal only. Layout, spacing, tabs, and settings can still be reviewed." },
      ];
    }

    return [
      { kind: "meta", text: "Preview mode · Claude shell mocked" },
      { kind: "command", text: `$ cd ${workDir}` },
      { kind: "command", text: "$ claude --resume preview-session" },
      { kind: "output", text: "Reviewing browser preview scaffolding and runtime style layers." },
      { kind: "output", text: "Next: inspect settings modal and tab density from the same app shell." },
      { kind: "accent", text: "No live agent process is attached in preview mode." },
    ];
  }

  let {
    visible,
    agentId,
    distro,
    workDir,
    storedAuxVisible = false,
    storedAuxHeightPercent = null,
    onAuxStateChange,
  }: Props = $props();

  let auxVisible = $state(false);
  let draftOpen = $state(false);
  let draftValue = $state("");
  let draftEl = $state<HTMLTextAreaElement | null>(null);
  let shellEl = $state<HTMLDivElement | null>(null);
  let assistPanelEl = $state<HTMLDivElement | null>(null);
  let initialized = false;
  let transcript = $state<PreviewLine[]>([]);

  const agentLabel = $derived(getAgentLabel(agentId as "claude" | "codex"));
  const auxHeightPercent = $derived(
    Number.isFinite(storedAuxHeightPercent) && storedAuxHeightPercent !== null
      ? Math.max(18, Math.min(60, storedAuxHeightPercent))
      : 28,
  );

  $effect(() => {
    if (initialized) return;
    auxVisible = storedAuxVisible;
    draftOpen = agentId === "claude";
    draftValue =
      agentId === "claude"
        ? "브라우저 프리뷰에서 탭/터미널/설정 감각 먼저 확인\ncustom.css는 마지막 레이어에서 덮어쓰기"
        : "Inspect spacing, icon rhythm, and panel density in preview mode.";
    transcript = createPreviewTranscript(agentId, workDir);
    initialized = true;
    queueMicrotask(() => {
      syncDraftHeight();
      if (draftOpen) {
        focusDraft(true);
      }
    });
  });

  $effect(() => {
    if (!shellEl || !assistPanelEl) return;

    const syncAssistPanelHeight = () => {
      shellEl?.style.setProperty("--assist-panel-height", `${assistPanelEl?.offsetHeight ?? 0}px`);
    };

    syncAssistPanelHeight();
    const observer = new ResizeObserver(() => {
      syncAssistPanelHeight();
    });
    observer.observe(assistPanelEl);

    return () => {
      observer.disconnect();
    };
  });

  function toggleAuxPanel() {
    auxVisible = !auxVisible;
    onAuxStateChange?.({
      auxPtyId: -1,
      auxVisible,
      auxHeightPercent: auxVisible ? auxHeightPercent : null,
    });
  }

  function toggleDraftPanel() {
    draftOpen = !draftOpen;
    queueMicrotask(() => {
      syncDraftHeight();
      shellEl?.style.setProperty("--assist-panel-height", `${assistPanelEl?.offsetHeight ?? 0}px`);
      if (draftOpen) {
        focusDraft(true);
      }
    });
  }

  function getDraftLineHeight() {
    const style = draftEl ? getComputedStyle(draftEl) : null;
    const parsed = style ? Number.parseFloat(style.lineHeight) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 21;
  }

  function syncDraftHeight() {
    if (!draftEl) return;

    const lineHeight = getDraftLineHeight();
    const style = getComputedStyle(draftEl);
    const verticalPadding =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom) +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);
    const maxRows = 5;
    const maxHeight = lineHeight * maxRows + verticalPadding;

    draftEl.style.height = "auto";
    draftEl.style.height = `${Math.min(draftEl.scrollHeight, maxHeight)}px`;
    draftEl.style.overflowY = draftEl.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function focusDraft(moveCaretToEnd = false) {
    requestAnimationFrame(() => {
      draftEl?.focus();
      if (moveCaretToEnd && draftEl) {
        const length = draftEl.value.length;
        draftEl.setSelectionRange(length, length);
      }
    });
  }

  function handlePreviewDraftInput(event: Event) {
    draftValue = (event.target as HTMLTextAreaElement).value;
    syncDraftHeight();
  }

  function appendPreviewDraft(text: string, submit: boolean) {
    const lines = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .filter((line) => line.length > 0);

    if (lines.length === 0) return;

    transcript = [
      ...transcript,
      ...lines.map((line) => ({ kind: "command" as const, text: `> ${line}` })),
      ...(submit
        ? [
            {
              kind: "accent" as const,
              text: "Preview only. Send would hand this draft to the live terminal session.",
            },
          ]
        : []),
    ];
  }

  function handlePreviewDraftInsert() {
    if (!draftValue.trim()) return;
    appendPreviewDraft(draftValue, false);
    draftValue = "";
    syncDraftHeight();
    focusDraft();
  }

  function handlePreviewDraftSend() {
    if (!draftValue.trim()) return;
    appendPreviewDraft(draftValue, true);
    draftValue = "";
    draftOpen = false;
    syncDraftHeight();
  }

  function handlePreviewDraftKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      handlePreviewDraftSend();
    }
  }
</script>

<div
  class="preview-shell"
  style:display={visible ? "flex" : "none"}
  data-preview-terminal="true"
  bind:this={shellEl}
>
  <div class="preview-main">
    <div class="preview-banner">
      <div class="preview-banner-copy">
        <span class="preview-badge">Browser Preview</span>
        <strong>{agentLabel}</strong>
        <span>{distro}</span>
      </div>
      <span class="preview-path">{workDir}</span>
    </div>

    <div class="preview-output">
      {#each transcript as line}
        <div class={`preview-line preview-line--${line.kind}`}>{line.text}</div>
      {/each}
    </div>

    <div class="preview-status">
      <span>Preview terminal surface</span>
      <span>Real PTY disabled</span>
    </div>
  </div>

  {#if auxVisible}
    {#snippet previewAuxBody()}
      <div class="preview-subpanel">
        <div class="preview-line preview-line--meta">$ pwd</div>
        <div class="preview-line preview-line--output">{workDir}</div>
        <div class="preview-line preview-line--output">Preview only. No shell process is attached.</div>
      </div>
    {/snippet}

    <TerminalAuxPanel
      visible={auxVisible}
      heightPercent={auxHeightPercent}
      title="Auxiliary Shell"
      currentPath={workDir}
      pathLabel={$translate("terminal.aux.currentPath")}
      body={previewAuxBody}
    />
  {/if}

  <div bind:this={assistPanelEl}>
    <TerminalAssistPanel
      auxVisible={auxVisible}
      draftOpen={draftOpen}
      draftValue={draftValue}
      onPasteImage={() => {}}
      onToggleAux={toggleAuxPanel}
      onToggleDraft={toggleDraftPanel}
      onDraftInput={handlePreviewDraftInput}
      onDraftKeydown={handlePreviewDraftKeydown}
      onInsertDraft={handlePreviewDraftInsert}
      onSendDraft={handlePreviewDraftSend}
      onDraftElementChange={(element) => {
        draftEl = element;
        syncDraftHeight();
      }}
    />
  </div>
</div>

<style>
  .preview-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    border-radius: 18px;
    border: 1px solid color-mix(in srgb, var(--ui-border-subtle) 72%, transparent);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-elevated) 72%, transparent), transparent 24%),
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-app) 94%, black 6%), color-mix(in srgb, var(--ui-bg-app) 86%, black 14%));
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.04),
      0 24px 60px rgba(var(--ui-shadow-rgb), 0.28);
    overflow: hidden;
  }

  .preview-main {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  }

  .preview-banner,
  .preview-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .preview-banner,
  .preview-status {
    padding-inline: 18px;
  }

  .preview-banner {
    padding-top: 18px;
    padding-bottom: 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--ui-border-subtle) 68%, transparent);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent);
  }

  .preview-banner-copy {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--ui-text-secondary);
    font-size: var(--ui-font-size-sm);
  }

  .preview-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px 9px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-accent-soft) 82%, transparent);
    color: var(--ui-accent);
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .preview-path {
    color: var(--ui-text-muted);
    font-size: var(--ui-font-size-sm);
  }

  .preview-output,
  .preview-subpanel {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 10px;
    padding: 18px;
    overflow: auto;
    font-family: "JetBrains Mono", "Cascadia Code", monospace;
    font-size: 13px;
    line-height: 1.55;
  }

  .preview-output {
    background:
      radial-gradient(circle at top right, rgba(255, 255, 255, 0.05), transparent 30%),
      linear-gradient(180deg, rgba(15, 23, 42, 0.14), transparent 22%);
  }

  .preview-line {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .preview-line--meta {
    color: color-mix(in srgb, var(--ui-text-muted) 88%, white 12%);
  }

  .preview-line--command {
    color: color-mix(in srgb, var(--ui-success) 80%, white 20%);
  }

  .preview-line--output {
    color: var(--ui-text-primary);
  }

  .preview-line--accent {
    margin-top: 6px;
    padding-top: 10px;
    border-top: 1px dashed color-mix(in srgb, var(--ui-border-subtle) 80%, transparent);
    color: var(--ui-accent);
  }

  .preview-status {
    padding-top: 10px;
    padding-bottom: 12px;
    border-top: 1px solid color-mix(in srgb, var(--ui-border-subtle) 68%, transparent);
    color: var(--ui-text-muted);
    font-size: var(--ui-font-size-sm);
  }

  .preview-subpanel {
    height: 100%;
    background: color-mix(in srgb, var(--ui-bg-surface) 86%, black 14%);
  }

</style>
