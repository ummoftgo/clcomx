<script lang="ts">
  import { _ as translate } from "svelte-i18n";
  import type { PendingClipboardImage } from "../clipboard";
  import { formatImageSize } from "../clipboard";
  import { TEST_IDS } from "../testids";

  type TranslationOptions = {
    default?: string;
    values?: Record<string, string | number | boolean | Date | null | undefined>;
    locale?: string;
    format?: string;
  };

  interface Props {
    visible: boolean;
    image: PendingClipboardImage | null;
    busy?: boolean;
    error?: string | null;
    onCancel: () => void;
    onConfirm: () => void;
  }

  let {
    visible,
    image,
    busy = false,
    error = null,
    onCancel,
    onConfirm,
  }: Props = $props();
  const t = (key: string, options?: TranslationOptions) => $translate(key, options);

  function handleKeydown(event: KeyboardEvent) {
    if (!visible || busy) return;
    if (event.key === "Escape") {
      onCancel();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="overlay"
  data-testid={TEST_IDS.imagePasteModal}
  style:display={visible ? "flex" : "none"}
  role="presentation"
  tabindex="-1"
  onclick={onCancel}
  onkeydown={(event) => {
    if (event.key === "Escape" && !busy) {
      onCancel();
    }
  }}
>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="image-paste-modal-title"
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => event.stopPropagation()}
  >
    <div class="modal-shell">
      <div class="header">
        <div class="title-block">
          <p class="eyebrow">{t("imagePaste.eyebrow")}</p>
          <h2 id="image-paste-modal-title">{t("imagePaste.title")}</h2>
          <p class="description">
            {t("imagePaste.description")}
            <code>./temp/image</code>
          </p>
        </div>
        <button class="close-btn" onclick={onCancel} disabled={busy}>&times;</button>
      </div>

      <div class="content">
        <div class="preview-frame">
          {#if image}
            <img src={image.previewUrl} alt={t("imagePaste.previewAlt")} />
          {:else}
            <div class="preview-empty">{t("imagePaste.previewEmpty")}</div>
          {/if}
        </div>

        <aside class="meta-panel">
          <div class="meta-row">
            <span>{t("imagePaste.meta.format")}</span>
            <strong>{image?.mimeType || "image/png"}</strong>
          </div>
          <div class="meta-row">
            <span>{t("imagePaste.meta.size")}</span>
            <strong>{image ? formatImageSize(image.size) : "0 B"}</strong>
          </div>
          <p class="meta-note">{t("imagePaste.meta.note")}</p>
        </aside>
      </div>

      {#if error}
        <div class="error">{error}</div>
      {/if}

      <div class="actions">
        <button
          class="ghost"
          data-testid={TEST_IDS.imagePasteCancel}
          onclick={onCancel}
          disabled={busy}
        >
          {t("imagePaste.cancel")}
        </button>
        <button
          class="primary"
          data-testid={TEST_IDS.imagePasteConfirm}
          onclick={onConfirm}
          disabled={!image || busy}
        >
          {busy ? t("imagePaste.saving") : t("imagePaste.confirm")}
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: calc(28px * var(--ui-scale));
    background:
      linear-gradient(180deg, rgba(2, 6, 23, 0.54), rgba(2, 6, 23, 0.72)),
      color-mix(in srgb, var(--app-bg) 76%, black 24%);
    z-index: 220;
    backdrop-filter: blur(18px) saturate(120%);
  }

  .modal-shell {
    width: min(820px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: calc(22px * var(--ui-scale));
    border: 1px solid color-mix(in srgb, var(--tab-border) 74%, white 26%);
    border-radius: var(--ui-radius-xl);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--tab-bg) 92%, white 8%), var(--tab-bg)),
      radial-gradient(circle at top right, rgba(96, 165, 250, 0.09), transparent 28%);
    color: var(--tab-text);
    box-shadow: 0 24px 52px rgba(2, 6, 23, 0.42);
    animation: modal-in 160ms ease-out;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ui-space-4);
    margin-bottom: var(--ui-space-4);
  }

  .title-block {
    min-width: 0;
  }

  .eyebrow {
    margin: 0 0 6px;
    font-size: var(--ui-font-size-xs);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    opacity: 0.68;
  }

  .header h2 {
    margin: 0;
    font-size: clamp(calc(20px * var(--ui-scale)), 2.5vw, calc(28px * var(--ui-scale)));
    letter-spacing: -0.02em;
  }

  .close-btn {
    border: none;
    background: transparent;
    color: var(--tab-text);
    font-size: calc(28px * var(--ui-scale));
    cursor: pointer;
    opacity: 0.75;
    line-height: 1;
  }

  .close-btn:hover:not(:disabled) {
    opacity: 1;
  }

  .description {
    margin: 8px 0 0;
    color: color-mix(in srgb, var(--tab-text) 82%, white 18%);
    font-size: var(--ui-font-size-base);
    line-height: 1.5;
  }

  .description code {
    color: var(--tab-text);
    background: color-mix(in srgb, var(--tab-active-bg) 72%, white 28%);
    padding: calc(2px * var(--ui-scale)) var(--ui-space-2);
    border-radius: 999px;
  }

  .content {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(240px, 0.9fr);
    gap: var(--ui-space-4);
    align-items: stretch;
  }

  .preview-frame,
  .meta-panel {
    border: 1px solid var(--tab-border);
    border-radius: var(--ui-radius-xl);
    background: color-mix(in srgb, var(--tab-active-bg) 78%, black 22%);
  }

  .preview-frame {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: calc(280px * var(--ui-scale));
    max-height: 520px;
    padding: var(--ui-space-4);
    background:
      radial-gradient(circle at top, rgba(148, 163, 184, 0.08), transparent 42%),
      linear-gradient(180deg, color-mix(in srgb, var(--tab-bg) 72%, white 28%), var(--tab-bg));
  }

  .preview-frame img {
    display: block;
    max-width: 100%;
    max-height: 470px;
    border-radius: var(--ui-radius-md);
    box-shadow: 0 14px 32px rgba(2, 6, 23, 0.34);
  }

  .preview-empty {
    display: grid;
    place-items: center;
    width: 100%;
    min-height: calc(240px * var(--ui-scale));
    border-radius: var(--ui-radius-lg);
    border: 1px dashed var(--tab-border);
    color: color-mix(in srgb, var(--tab-text) 72%, white 28%);
    opacity: 0.72;
    font-size: var(--ui-font-size-base);
    letter-spacing: 0.02em;
  }

  .meta-panel {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-4);
    padding: calc(18px * var(--ui-scale));
  }

  .meta-row {
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
    padding: calc(14px * var(--ui-scale)) var(--ui-space-4);
    border-radius: var(--ui-radius-lg);
    background: color-mix(in srgb, var(--tab-bg) 84%, white 16%);
  }

  .meta-row span {
    color: color-mix(in srgb, var(--tab-text) 70%, white 30%);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .meta-row strong {
    font-size: 14px;
    font-weight: 600;
  }

  .meta-note {
    margin: 0;
    color: color-mix(in srgb, var(--tab-text) 80%, white 20%);
    font-size: 13px;
    line-height: 1.55;
  }

  .error {
    margin: 18px 0 0;
    padding: 12px 14px;
    border-radius: 14px;
    color: #fecaca;
    background: rgba(127, 29, 29, 0.45);
    border: 1px solid rgba(248, 113, 113, 0.35);
    font-size: 13px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 18px;
  }

  .ghost,
  .primary {
    padding: 11px 16px;
    border: 1px solid var(--tab-border);
    border-radius: 12px;
    cursor: pointer;
    color: var(--tab-text);
  }

  .ghost {
    background: transparent;
  }

  .ghost:hover:not(:disabled) {
    background: color-mix(in srgb, var(--tab-active-bg) 82%, white 18%);
  }

  .primary {
    background: linear-gradient(180deg, #2563eb, #1d4ed8);
    border-color: #2563eb;
    color: white;
    font-weight: 700;
  }

  .primary:hover:not(:disabled) {
    filter: brightness(1.03);
  }

  .ghost:disabled,
  .primary:disabled {
    cursor: default;
    opacity: 0.65;
  }

  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.99);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @media (max-width: 760px) {
    .overlay {
      padding: 16px;
    }

    .modal-shell {
      width: calc(100vw - 24px);
    }

    .content {
      grid-template-columns: 1fr;
    }

    .actions {
      flex-direction: column-reverse;
    }

    .ghost,
    .primary {
      width: 100%;
      justify-content: center;
    }
  }
</style>
