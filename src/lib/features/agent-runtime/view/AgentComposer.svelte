<!--
  AgentComposer — 입력 박스 + send/stop(08 §6).

  Stage 1 범위: multiline text 입력 + Enter 전송(Shift+Enter 개행) + status별 send↔stop 전환.
  image/mention/capability gating은 후속 stage. UI 문자열은 i18n 키만 쓴다(하드코딩 금지).
  status가 running이면 stop, requires_action이면 입력 비활성+승인 대기 안내, starting/failed/exited면 비활성.
-->
<script lang="ts">
  import { t } from "../../../i18n";
  import { TEST_IDS } from "../../../testids";
  import type { AgentCommand, AgentContent, AgentSessionStatus } from "../contracts/normalized";

  interface Props {
    /** 세션 상태(입력 활성/버튼 전환 게이팅). */
    status: AgentSessionStatus;
    /** provider 식별자(중립 라벨, 브랜딩 제약 09). */
    providerLabel: string;
    /** 텍스트 전송 콜백. */
    onSend: (content: AgentContent[]) => void;
    /** 진행 turn 취소 콜백. */
    onStop: () => void;
    /** provider가 알린 슬래시 커맨드 목록(팔레트 소스). */
    availableCommands?: AgentCommand[];
  }

  let { status, providerLabel, onSend, onStop, availableCommands = [] }: Props = $props();

  let draft = $state("");
  // 슬래시 팔레트 선택 인덱스 + Escape로 닫은 query(같은 query에선 다시 안 뜨게).
  let selectedIndex = $state(0);
  let dismissedQuery = $state<string | null>(null);

  // turn 진행 중이면 stop 버튼.
  const isRunning = $derived(status === "running");
  // 입력 활성 조건: ready/idle/running만 입력 가능(승인 대기·시작·종료는 비활성).
  const inputEnabled = $derived(
    status === "ready" || status === "idle" || status === "running",
  );
  const placeholder = $derived(
    status === "requires_action"
      ? $t("agentRuntime.status.requiresAction")
      : inputEnabled
        ? $t("agentRuntime.composer.placeholder")
        : $t("agentRuntime.composer.disabled"),
  );

  // ── 슬래시 커맨드 팔레트(08 §6, /resume 등). provider-backed 목록 없는 Codex는 로컬 /resume만.
  // 트리거: draft 전체가 "/" + 공백/개행 없는 첫 토큰(예: "/res"). 인자 입력(공백 후)에선 닫힘.
  const slashQuery = $derived(/^\/[^\s]*$/.test(draft) ? draft.slice(1) : null);

  // provider 목록 + 로컬 보강(provider에 없을 때만 /resume 추가).
  const allCommands = $derived.by<AgentCommand[]>(() => {
    const byName = new Map<string, AgentCommand>();
    for (const c of availableCommands) if (c.name) byName.set(c.name, c);
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

  // query가 바뀌면 선택을 처음으로 되돌린다.
  $effect(() => {
    void slashQuery;
    selectedIndex = 0;
  });

  /** 팔레트에서 커맨드 선택 → draft를 "/<name> "으로 채우고 팔레트를 닫는다(전송은 평문 텍스트). */
  function acceptCommand(cmd: AgentCommand | undefined): void {
    if (!cmd) return;
    draft = `/${cmd.name} `;
    dismissedQuery = null;
  }

  /** 입력을 전송하고 draft를 비운다(빈 입력은 무시). */
  function send(): void {
    const text = draft.trim();
    if (text.length === 0 || !inputEnabled) return;
    onSend([{ type: "text", text }]);
    draft = "";
    dismissedQuery = null;
  }

  /** Enter=전송, Shift+Enter=개행. 팔레트 열림 시 ↑↓ 이동 / Enter·Tab 선택 / Esc 닫기. */
  function onKeydown(e: KeyboardEvent): void {
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
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
  <textarea
    class="composer-input"
    data-testid={TEST_IDS.agentComposerInput}
    bind:value={draft}
    placeholder={placeholder}
    rows="2"
    disabled={!inputEnabled}
    onkeydown={onKeydown}
  ></textarea>
  <div class="composer-footer">
    <span class="provider-label" title={providerLabel}>{providerLabel}</span>
    {#if isRunning}
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
        disabled={!inputEnabled || draft.trim().length === 0}
        onclick={send}
      >
        {$t("agentRuntime.composer.send")}
      </button>
    {/if}
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
  .composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .provider-label {
    font-size: var(--ui-font-size-xs);
    opacity: 0.55;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
