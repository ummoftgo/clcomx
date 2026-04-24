<script lang="ts">
  type TerminalLoadingOverlayVariant = "main" | "aux";

  interface Props {
    variant?: TerminalLoadingOverlayVariant;
    label: string;
    hint: string;
    eyebrow?: string;
  }

  let {
    variant = "main",
    label,
    hint,
    eyebrow = "CLCOMX",
  }: Props = $props();
</script>

<div
  class="terminal-connect-overlay"
  class:terminal-connect-overlay--subpanel={variant === "aux"}
  class:terminal-connect-overlay--aux-panel={variant === "aux"}
>
  <div
    class="terminal-connect-card"
    class:terminal-connect-card--compact={variant === "aux"}
  >
    <div class="terminal-connect-eyebrow">{eyebrow}</div>
    <div class="terminal-connect-title">{label}</div>
    <div class="terminal-connect-hint">{hint}</div>
    <div class="terminal-connect-dots" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>
    {#if variant === "main"}
      <div class="terminal-connect-bar" aria-hidden="true">
        <span></span>
      </div>
    {/if}
  </div>
</div>

<style>
  .terminal-connect-overlay {
    position: absolute;
    inset: var(--ui-space-1);
    display: grid;
    place-items: center;
    padding: clamp(20px, 3vw, 28px);
    border-radius: calc(var(--ui-radius-lg) + 2px);
    background:
      linear-gradient(180deg, rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.16), rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.3)),
      color-mix(in srgb, var(--ui-bg-app, var(--app-bg)) 72%, transparent);
    backdrop-filter: blur(6px);
    z-index: 8;
  }

  .terminal-connect-overlay--subpanel {
    inset: 0;
    padding: var(--ui-space-3);
    border-radius: var(--ui-radius-md);
  }

  .terminal-connect-overlay--aux-panel {
    z-index: 24;
    border-radius: inherit;
  }

  .terminal-connect-card {
    min-width: min(320px, 100%);
    max-width: min(420px, 100%);
    display: grid;
    gap: var(--ui-space-2);
    padding: clamp(18px, 2.2vw, 24px);
    border: 1px solid color-mix(in srgb, var(--ui-border-strong, var(--tab-border)) 78%, transparent);
    border-radius: calc(var(--ui-radius-xl) + 2px);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--ui-bg-surface, var(--tab-active-bg)) 94%, transparent), transparent),
      color-mix(in srgb, var(--ui-bg-app, var(--app-bg)) 90%, transparent);
    box-shadow: 0 18px 40px rgba(var(--ui-shadow-rgb, 15, 23, 42), 0.24);
  }

  .terminal-connect-card--compact {
    min-width: min(280px, 100%);
    gap: var(--ui-space-2);
    padding: clamp(16px, 2vw, 20px);
  }

  .terminal-connect-eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .terminal-connect-title {
    font-size: clamp(18px, 2vw, 22px);
    font-weight: 700;
    line-height: 1.2;
    color: var(--ui-text-primary, var(--tab-text));
  }

  .terminal-connect-hint {
    font-size: var(--ui-font-size-sm);
    line-height: 1.55;
    color: var(--ui-text-muted, var(--tab-text));
  }

  .terminal-connect-dots {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: var(--ui-space-1);
  }

  .terminal-connect-dots span {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-accent, var(--tab-accent, #6ea8ff)) 82%, white 18%);
    animation: terminal-loading-bounce 1.1s ease-in-out infinite;
  }

  .terminal-connect-dots span:nth-child(2) {
    animation-delay: 0.12s;
  }

  .terminal-connect-dots span:nth-child(3) {
    animation-delay: 0.24s;
  }

  .terminal-connect-bar {
    position: relative;
    overflow: hidden;
    width: 100%;
    height: 4px;
    margin-top: var(--ui-space-1);
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-border-subtle, var(--tab-border)) 72%, transparent);
  }

  .terminal-connect-bar span {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -24%;
    width: 24%;
    border-radius: inherit;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ui-accent, var(--tab-accent, #6ea8ff)) 92%, white 8%), transparent);
    animation: terminal-loading-sweep 1.5s ease-in-out infinite;
  }

  @keyframes terminal-loading-bounce {
    0%, 80%, 100% {
      transform: translateY(0);
      opacity: 0.42;
    }
    40% {
      transform: translateY(-4px);
      opacity: 1;
    }
  }

  @keyframes terminal-loading-sweep {
    0% {
      transform: translateX(0);
    }
    100% {
      transform: translateX(520%);
    }
  }
</style>
