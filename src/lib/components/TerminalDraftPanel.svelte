<script lang="ts">
  import { _ as t } from "svelte-i18n";
  import Button from "../ui/components/Button.svelte";
  import { TEST_IDS } from "../testids";

  interface Props {
    title: string;
    draftValue: string;
    fixedHeightPx?: number | null;
    bottomOffsetPx?: number;
    draftElement?: HTMLTextAreaElement | null;
    panelElement?: HTMLDivElement | null;
    onResizeStart?: (event: PointerEvent) => void;
    onClose: () => void;
    onDraftInput: (event: Event) => void;
    onDraftKeydown?: (event: KeyboardEvent) => void;
    onDraftPaste?: (event: ClipboardEvent) => void;
    onInsertDraft: () => void;
    onSendDraft: () => void;
  }

  let {
    title,
    draftValue,
    fixedHeightPx = null,
    bottomOffsetPx = 0,
    draftElement = $bindable<HTMLTextAreaElement | null>(null),
    panelElement = $bindable<HTMLDivElement | null>(null),
    onResizeStart,
    onClose,
    onDraftInput,
    onDraftKeydown,
    onDraftPaste,
    onInsertDraft,
    onSendDraft,
  }: Props = $props();
</script>

<div
  class="draft-panel"
  class:draft-panel--resized={fixedHeightPx !== null}
  style:height={fixedHeightPx !== null ? `${fixedHeightPx}px` : undefined}
  style:--draft-stack-offset={`${Math.max(bottomOffsetPx, 0)}px`}
  bind:this={panelElement}
>
  <div class="draft-surface">
    <button
      type="button"
      class="draft-resize-handle"
      tabindex="-1"
      aria-label={$t("terminal.aux.resizeHint")}
      title={$t("terminal.aux.resizeHint")}
      onpointerdown={onResizeStart}
    ></button>

    <div class="draft-header">
      <div class="draft-copy">
        <span class="draft-title">{title}</span>
        <span class="draft-subtitle">{$t("terminal.assist.draftHint")}</span>
      </div>

      <Button
        size="sm"
        variant="ghost"
        onclick={(event) => {
          (event.currentTarget as HTMLButtonElement | null)?.blur();
          onClose();
        }}
      >
        {$t("common.actions.close")}
      </Button>
    </div>

    <div class="draft-body" class:draft-body--resized={fixedHeightPx !== null}>
      <textarea
        bind:this={draftElement}
        value={draftValue}
        data-testid={TEST_IDS.draftTextarea}
        class="draft-textarea"
        class:draft-textarea--resized={fixedHeightPx !== null}
        rows="1"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        placeholder={$t("terminal.assist.draftPlaceholder")}
        oninput={onDraftInput}
        onkeydown={onDraftKeydown}
        onpaste={onDraftPaste}
      ></textarea>
    </div>

    <div class="draft-footer">
      <span class="draft-hint">{$t("terminal.assist.hint")}</span>

      <div class="draft-actions">
        <Button
          size="sm"
          data-testid={TEST_IDS.draftInsertButton}
          onclick={onInsertDraft}
          disabled={draftValue.length === 0}
        >
          {$t("common.actions.insert")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-testid={TEST_IDS.draftSendButton}
          onclick={onSendDraft}
          disabled={draftValue.length === 0}
        >
          {$t("common.actions.send")}
        </Button>
      </div>
    </div>
  </div>
</div>

<style>
  .draft-panel {
    position: absolute;
    left: var(--ui-space-1);
    right: var(--ui-space-1);
    bottom: calc(var(--assist-panel-height, 0px) + var(--ui-space-1) + var(--draft-stack-offset, 0px));
    overflow: hidden;
    min-height: 0;
    max-height: calc(
      100% - var(--assist-panel-height, 0px) - var(--draft-stack-offset, 0px) - calc(12px * var(--ui-scale))
    );
    border: 1px solid color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 76%, transparent);
    border-radius: var(--ui-radius-lg);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 90%, transparent), transparent),
      color-mix(in srgb, var(--ui-bg-app, var(--app-bg)) 90%, transparent);
    box-shadow: 0 -12px 28px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.24);
    z-index: 18;
  }

  .draft-surface {
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .draft-panel--resized .draft-surface {
    height: 100%;
  }

  .draft-resize-handle {
    flex: 0 0 auto;
    height: calc(14px * var(--ui-scale));
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    cursor: ns-resize;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .draft-resize-handle::before {
    content: "";
    width: calc(56px * var(--ui-scale));
    height: calc(4px * var(--ui-scale));
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 74%, transparent);
  }

  .draft-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
    padding: 0 var(--ui-space-4) var(--ui-space-3);
  }

  .draft-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
  }

  .draft-title {
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-secondary, var(--tab-text));
  }

  .draft-subtitle,
  .draft-hint {
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .draft-body {
    padding: 0 var(--ui-space-3) 0;
  }

  .draft-body--resized {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .draft-textarea {
    width: 100%;
    min-height: calc(42px * var(--ui-scale));
    max-height: 50vh;
    resize: none;
    padding: calc(10px * var(--ui-scale)) var(--ui-space-3);
    border: 1px solid var(--ui-border-subtle, rgba(148, 163, 184, 0.24));
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--ui-bg-elevated, var(--tab-bg)) 92%, transparent);
    color: var(--ui-text-primary, #e2e8f0);
    font: inherit;
    line-height: 1.5;
    outline: none;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
  }

  .draft-textarea--resized {
    flex: 1;
    min-height: 0;
    height: 100%;
    max-height: none;
    overflow-y: auto;
  }

  .draft-textarea:focus {
    border-color: var(--ui-accent, rgba(96, 165, 250, 0.65));
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.03),
      0 0 0 1px var(--ui-focus-ring, rgba(96, 165, 250, 0.12));
  }

  .draft-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-3);
    padding: var(--ui-space-3);
  }

  .draft-actions {
    display: flex;
    gap: var(--ui-space-2);
    align-items: center;
  }

  @media (max-width: 900px) {
    .draft-header,
    .draft-footer {
      flex-direction: column;
      align-items: stretch;
    }

    .draft-actions {
      justify-content: stretch;
    }

    :global(.draft-actions .ui-button) {
      flex: 1;
    }
  }
</style>
