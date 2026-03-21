<script lang="ts">
  import { tick } from "svelte";
  import { _ as t } from "svelte-i18n";
  import {
    getSessions,
    getActiveSessionId,
    moveSession,
    setActiveSession,
  } from "../stores/sessions.svelte";
  import ContextMenu from "../ui/components/ContextMenu.svelte";
  import AgentIcon from "./AgentIcon.svelte";
  import type { ContextMenuItem } from "../ui/context-menu";
  import {
    TEST_IDS,
    tabCloseButtonTestId,
    tabMenuButtonTestId,
    tabTestId,
  } from "../testids";

  interface WindowMenuItem {
    label: string;
    name: string;
  }

  interface Props {
    onNewTab: () => void;
    onSettings?: () => void;
    onCloseTab?: (id: string) => void;
    onRenameTab?: (id: string) => void;
    onRenameWindow?: () => void;
    onTogglePinTab?: (id: string) => void;
    onToggleLockTab?: (id: string) => void;
    onMoveTabLeft?: (id: string) => void;
    onMoveTabRight?: (id: string) => void;
    onMoveTabToNewWindow?: (id: string) => void;
    onMoveTabToWindow?: (sessionId: string, targetLabel: string) => void;
    availableWindows?: WindowMenuItem[];
  }

  let {
    onNewTab,
    onSettings,
    onCloseTab,
    onRenameTab,
    onRenameWindow,
    onTogglePinTab,
    onToggleLockTab,
    onMoveTabLeft,
    onMoveTabRight,
    onMoveTabToNewWindow,
    onMoveTabToWindow,
    availableWindows = [],
  }: Props = $props();

  const sessions = $derived(getSessions());
  const activeId = $derived(getActiveSessionId());

  let dragCandidateId: string | null = null;
  let draggingSessionId = $state<string | null>(null);
  let dragPointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragCurrentX = $state(0);
  let dragCurrentY = $state(0);
  let dragSourceElement: HTMLElement | null = null;
  let tabElements = new Map<string, HTMLDivElement>();
  let openMenuSessionId = $state<string | null>(null);
  let menuX = $state(0);
  let menuY = $state(0);

  function trackTab(element: HTMLDivElement, sessionId: string) {
    tabElements.set(sessionId, element);
    return {
      update(nextSessionId: string) {
        if (nextSessionId !== sessionId) {
          tabElements.delete(sessionId);
          sessionId = nextSessionId;
          tabElements.set(sessionId, element);
        }
      },
      destroy() {
        tabElements.delete(sessionId);
      },
    };
  }

  function getDraggingSessionTitle() {
    if (!draggingSessionId) return "";
    return sessions.find((session) => session.id === draggingSessionId)?.title ?? "";
  }

  function getDraggingPreviewStyle() {
    const maxX = Math.max(10, window.innerWidth - 230);
    const maxY = Math.max(8, window.innerHeight - 44);
    const x = Math.min(maxX, Math.max(10, dragCurrentX + 14));
    const y = Math.min(maxY, Math.max(8, dragCurrentY + 12));
    return `left:${x}px;top:${y}px;`;
  }

  function requestTerminalFocus(sessionId?: string | null) {
    const targetSessionId = sessionId ?? activeId;
    if (!targetSessionId) return;
    window.dispatchEvent(new CustomEvent("clcomx:focus-active-terminal", {
      detail: { sessionId: targetSessionId },
    }));
  }

  function releasePointerCapture() {
    if (dragSourceElement && dragPointerId !== null && dragSourceElement.hasPointerCapture?.(dragPointerId)) {
      dragSourceElement.releasePointerCapture(dragPointerId);
    }
  }

  function resetDrag() {
    releasePointerCapture();
    dragCandidateId = null;
    draggingSessionId = null;
    dragPointerId = null;
    dragSourceElement = null;
  }

  function closeMenu() {
    openMenuSessionId = null;
  }

  function handleClose(e: MouseEvent, id: string) {
    e.stopPropagation();
    closeMenu();
    const session = sessions.find((entry) => entry.id === id);
    if (session?.locked) return;
    onCloseTab?.(id);
  }

  function openMenuAt(sessionId: string, x: number, y: number) {
    openMenuSessionId = sessionId;
    menuX = x;
    menuY = y;
  }

  function openMenuFromButton(event: MouseEvent, sessionId: string) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget as HTMLElement | null;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    openMenuAt(
      sessionId,
      Math.max(12, Math.min(window.innerWidth - 220, rect.right - 198)),
      Math.max(8, Math.min(window.innerHeight - 12, rect.bottom + 6)),
    );
  }

  function openMenuFromContext(event: MouseEvent, sessionId: string) {
    event.preventDefault();
    event.stopPropagation();
    openMenuAt(sessionId, event.clientX, event.clientY);
  }

  function handlePointerDown(event: PointerEvent, id: string) {
    if (event.button !== 0) return;
    dragCandidateId = id;
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragCurrentX = event.clientX;
    dragCurrentY = event.clientY;
    dragSourceElement = event.currentTarget as HTMLElement | null;
    dragSourceElement?.setPointerCapture?.(event.pointerId);
  }

  function findHoveredSessionId(clientX: number, clientY: number) {
    for (const session of sessions) {
      const element = tabElements.get(session.id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return session.id;
      }
    }

    return null;
  }

  function handlePointerMove(event: PointerEvent) {
    if (!dragCandidateId || dragPointerId !== event.pointerId) return;

    dragCurrentX = event.clientX;
    dragCurrentY = event.clientY;

    const moved = Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY);
    if (!draggingSessionId && moved < 6) {
      return;
    }

    draggingSessionId = dragCandidateId;

    const hoveredSessionId = findHoveredSessionId(event.clientX, event.clientY);
    const draggingSession = sessions.find((session) => session.id === draggingSessionId);
    const hoveredSession = sessions.find((session) => session.id === hoveredSessionId);
    if (
      hoveredSessionId &&
      hoveredSessionId !== draggingSessionId &&
      draggingSession &&
      hoveredSession &&
      draggingSession.pinned === hoveredSession.pinned
    ) {
      const targetIndex = sessions.findIndex((session) => session.id === hoveredSessionId);
      if (targetIndex >= 0) {
        moveSession(draggingSessionId, targetIndex);
      }
    }
  }

  async function handlePointerUp(event: PointerEvent) {
    if (!dragCandidateId || dragPointerId !== event.pointerId) return;

    const focusedSessionId = draggingSessionId ?? dragCandidateId;

    if (!draggingSessionId) {
      setActiveSession(dragCandidateId);
    } else {
      setActiveSession(draggingSessionId);
    }

    resetDrag();
    await tick();
    requestTerminalFocus(focusedSessionId);
  }

  async function handlePointerCancel() {
    resetDrag();
    await tick();
    requestTerminalFocus();
  }

  function moveLeft(sessionId: string) {
    closeMenu();
    onMoveTabLeft?.(sessionId);
    requestAnimationFrame(() => {
      requestTerminalFocus(sessionId);
    });
  }

  function moveRight(sessionId: string) {
    closeMenu();
    onMoveTabRight?.(sessionId);
    requestAnimationFrame(() => {
      requestTerminalFocus(sessionId);
    });
  }

  function moveToNewWindow(sessionId: string) {
    closeMenu();
    onMoveTabToNewWindow?.(sessionId);
  }

  function moveToWindow(sessionId: string, targetLabel: string) {
    closeMenu();
    onMoveTabToWindow?.(sessionId, targetLabel);
  }

  function renameTab(sessionId: string) {
    closeMenu();
    onRenameTab?.(sessionId);
  }

  function renameWindow() {
    closeMenu();
    onRenameWindow?.();
  }

  function togglePin(sessionId: string) {
    closeMenu();
    onTogglePinTab?.(sessionId);
    requestAnimationFrame(() => {
      requestTerminalFocus(sessionId);
    });
  }

  function toggleLock(sessionId: string) {
    closeMenu();
    onToggleLockTab?.(sessionId);
    requestAnimationFrame(() => {
      requestTerminalFocus(sessionId);
    });
  }

  function getSessionById(sessionId: string) {
    return sessions.find((session) => session.id === sessionId);
  }

  function getSessionGroup(sessionId: string) {
    const session = getSessionById(sessionId);
    if (!session) return [];
    return sessions.filter((entry) => entry.pinned === session.pinned);
  }

  function isFirstInGroup(sessionId: string) {
    return getSessionGroup(sessionId)[0]?.id === sessionId;
  }

  function isLastInGroup(sessionId: string) {
    const group = getSessionGroup(sessionId);
    return group[group.length - 1]?.id === sessionId;
  }

  function buildMenuItems(sessionId: string): ContextMenuItem[] {
    const session = getSessionById(sessionId);
    const items: ContextMenuItem[] = [
      {
        id: "rename-tab",
        kind: "item",
        label: $t("tabs.menu.renameTab", { default: "Rename Tab" }),
        value: sessionId,
      },
      {
        id: "rename-window",
        kind: "item",
        label: $t("tabs.menu.renameWindow", { default: "Rename This Window" }),
      },
      { id: "rename-separator", kind: "separator" },
      {
        id: session?.pinned ? "unpin-tab" : "pin-tab",
        kind: "item",
        label: $t(session?.pinned ? "tabs.menu.unpinTab" : "tabs.menu.pinTab", {
          default: session?.pinned ? "Unpin Tab" : "Pin Tab",
        }),
        value: sessionId,
      },
      {
        id: session?.locked ? "unlock-tab" : "lock-tab",
        kind: "item",
        label: $t(session?.locked ? "tabs.menu.unlockTab" : "tabs.menu.lockTab", {
          default: session?.locked ? "Unlock Tab Close" : "Lock Tab Close",
        }),
        value: sessionId,
      },
      { id: "organize-separator", kind: "separator" },
      {
        id: "move-left",
        kind: "item",
        label: $t("tabs.menu.moveLeft", { default: "Move left" }),
        disabled: isFirstInGroup(sessionId),
        value: sessionId,
      },
      {
        id: "move-right",
        kind: "item",
        label: $t("tabs.menu.moveRight", { default: "Move right" }),
        disabled: isLastInGroup(sessionId),
        value: sessionId,
      },
      {
        id: "move-new-window",
        kind: "item",
        label: $t("tabs.menu.moveToNewWindow", { default: "Move to new window" }),
        value: sessionId,
      },
    ];

    if (availableWindows.length > 0) {
      items.push({
        id: "move-window-header",
        kind: "header",
        label: $t("tabs.menu.moveToWindowSection", { default: "Move to other window" }),
      });

      for (const windowItem of availableWindows) {
        items.push({
          id: `move-window-${windowItem.label}`,
          kind: "item",
          label: $t("tabs.menu.moveToWindow", {
            default: "Move to {name}",
            values: { name: windowItem.name },
          }),
          value: windowItem.label,
        });
      }
    }

    items.push({ id: "close-separator", kind: "separator" });
    items.push({
      id: "close-tab",
      kind: "item",
      label: $t("tabs.menu.closeTab", { default: "Close tab" }),
      disabled: Boolean(session?.locked),
      danger: true,
      value: sessionId,
    });

    return items;
  }

  function handleMenuSelect(item: Extract<ContextMenuItem, { kind: "item" }>) {
    if (!openMenuSessionId) return;

    const sessionId = openMenuSessionId;
    closeMenu();

    switch (item.id) {
      case "rename-tab":
        renameTab(sessionId);
        return;
      case "rename-window":
        renameWindow();
        return;
      case "pin-tab":
      case "unpin-tab":
        togglePin(sessionId);
        return;
      case "lock-tab":
      case "unlock-tab":
        toggleLock(sessionId);
        return;
      case "move-left":
        moveLeft(sessionId);
        return;
      case "move-right":
        moveRight(sessionId);
        return;
      case "move-new-window":
        moveToNewWindow(sessionId);
        return;
      case "close-tab":
        onCloseTab?.(sessionId);
        return;
      default:
        if (item.value) {
          moveToWindow(sessionId, item.value);
        }
    }
  }
</script>

<div class="tab-bar" data-testid={TEST_IDS.tabBar}>
  <div class="tabs">
    {#each sessions as session, index (session.id)}
      {@const previous = sessions[index - 1]}
      {#if previous && previous.pinned && !session.pinned}
        <div class="tab-group-separator" aria-hidden="true"></div>
      {/if}
      <div
        class="tab"
        data-testid={tabTestId(session.id)}
        role="button"
        tabindex="0"
        class:active={session.id === activeId}
        class:dragging={session.id === draggingSessionId}
        use:trackTab={session.id}
        onpointerdown={(event) => handlePointerDown(event, session.id)}
        onpointermove={handlePointerMove}
        onpointerup={handlePointerUp}
        onpointercancel={handlePointerCancel}
        onclick={() => { if (!draggingSessionId) setActiveSession(session.id); }}
        oncontextmenu={(event) => openMenuFromContext(event, session.id)}
        onkeydown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!draggingSessionId) setActiveSession(session.id);
          }
        }}
      >
        {#if session.pinned}
          <span class="tab-state-badge" title={$t("tabs.menu.pinTab", { default: "Pin Tab" })}>PIN</span>
        {/if}
        {#if session.locked}
          <span class="tab-state-badge tab-state-badge--locked" title={$t("tabs.menu.lockTab", { default: "Lock Tab Close" })}>LOCK</span>
        {/if}
        <AgentIcon agentId={session.agentId} />
        <span class="tab-title">{session.title}</span>
        <button
          class="tab-menu-button"
          type="button"
          data-testid={tabMenuButtonTestId(session.id)}
          title={$t("tabs.menu.title", { default: "Tab menu" })}
          onpointerdown={(event) => event.stopPropagation()}
          onclick={(event) => openMenuFromButton(event, session.id)}
          oncontextmenu={(event) => openMenuFromContext(event, session.id)}
        >
          &#8942;
        </button>
        <button
          class="tab-close"
          type="button"
          data-testid={tabCloseButtonTestId(session.id)}
          disabled={session.locked}
          onclick={(e) => handleClose(e, session.id)}
          onpointerdown={(e) => e.stopPropagation()}
          title={$t("tabs.menu.closeTab", { default: "Close tab" })}
        >
          &times;
        </button>
      </div>

    {/each}
  </div>

  <div class="tab-actions">
    <button
      class="tab-action tab-action--new"
      data-testid={TEST_IDS.newTabButton}
      onclick={onNewTab}
      title={$t("tabs.actions.newTab", { default: "New tab (Ctrl+T)" })}
    >
      <span class="tab-action-icon tab-action-icon--plus" aria-hidden="true">+</span>
    </button>
    {#if onSettings}
      <button
        class="tab-action tab-action--settings"
        data-testid={TEST_IDS.settingsButton}
        onclick={onSettings}
        title={$t("tabs.actions.settings", { default: "Settings" })}
      >
        <span class="tab-action-icon" aria-hidden="true">&#9881;</span>
      </button>
    {/if}
  </div>
</div>

<ContextMenu
  visible={openMenuSessionId !== null}
  x={menuX}
  y={menuY}
  items={openMenuSessionId ? buildMenuItems(openMenuSessionId) : []}
  onSelect={handleMenuSelect}
  onClose={closeMenu}
/>

{#if draggingSessionId}
  <div
    class="drag-preview"
    style={getDraggingPreviewStyle()}
  >
    <span class="drag-preview-title">{getDraggingSessionTitle()}</span>
    <span class="drag-preview-grip">&#8942;</span>
  </div>
{/if}

<style>
  .tab-bar {
    display: flex;
    align-items: center;
    height: var(--tab-height);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--tab-bg) 96%, #020617), var(--tab-bg)),
      var(--tab-bg);
    border-bottom: 1px solid color-mix(in srgb, var(--tab-border) 70%, transparent);
    user-select: none;
    -webkit-app-region: drag;
  }

  .tabs {
    display: flex;
    flex: 1;
    overflow-x: auto;
    -webkit-app-region: no-drag;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: var(--ui-space-2);
    margin: calc(5px * var(--ui-scale)) var(--ui-space-1) 0 var(--ui-space-2);
    padding: 0 var(--ui-space-3) 0 var(--ui-space-3);
    height: var(--tab-height);
    background: color-mix(in srgb, var(--tab-active-bg) 24%, transparent);
    border: 1px solid transparent;
    border-bottom: none;
    border-top-left-radius: var(--ui-radius-md);
    border-top-right-radius: var(--ui-radius-md);
    color: var(--tab-text);
    font-size: var(--ui-font-size-base);
    cursor: pointer;
    white-space: nowrap;
    min-width: calc(120px * var(--ui-scale));
    max-width: calc(220px * var(--ui-scale));
    transition: background 0.12s, opacity 0.12s, transform 0.12s;
    touch-action: none;
  }

  .tab:hover {
    background: color-mix(in srgb, var(--tab-active-bg) 56%, transparent);
  }

  .tab.active {
    background: color-mix(in srgb, var(--tab-active-bg) 84%, transparent);
    border-color: color-mix(in srgb, var(--tab-border) 72%, transparent);
    box-shadow: 0 4px 16px rgba(2, 6, 23, 0.14);
  }

  .tab.dragging {
    opacity: 0.35;
  }

  .tab-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
  }

  .tab-group-separator {
    width: 1px;
    margin: calc(8px * var(--ui-scale)) var(--ui-space-1) calc(6px * var(--ui-scale));
    background: color-mix(in srgb, var(--tab-border) 78%, transparent);
    align-self: stretch;
    opacity: 0.8;
  }

  .tab-state-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: calc(28px * var(--ui-scale));
    height: calc(18px * var(--ui-scale));
    padding: 0 var(--ui-space-2);
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-accent-soft) 68%, transparent);
    color: var(--ui-text-primary);
    font-size: var(--ui-font-size-xs);
    font-weight: 700;
    letter-spacing: 0.03em;
  }

  .tab-state-badge--locked {
    background: color-mix(in srgb, var(--ui-danger-soft) 70%, transparent);
  }

  .tab-menu-button,
  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: calc(18px * var(--ui-scale));
    height: calc(18px * var(--ui-scale));
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 999px;
    color: var(--tab-text);
    cursor: pointer;
    opacity: 0.62;
  }

  .tab-menu-button {
    font-size: var(--ui-font-size-base);
  }

  .tab-close {
    font-size: var(--ui-font-size-base);
  }

  .tab-menu-button:hover,
  .tab-close:hover:not(:disabled) {
    opacity: 1;
    background: color-mix(in srgb, var(--tab-text) 12%, transparent);
  }

  .tab-close:disabled {
    cursor: default;
    opacity: 0.28;
  }

  .tab-actions {
    display: flex;
    align-items: center;
    gap: var(--ui-space-2);
    padding: 0 var(--ui-space-4) 0 var(--ui-space-2);
    -webkit-app-region: no-drag;
  }

  .tab-action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: calc(30px * var(--ui-scale));
    height: calc(30px * var(--ui-scale));
    padding: 0;
    background: color-mix(in srgb, var(--tab-active-bg) 34%, transparent);
    border: 1px solid color-mix(in srgb, var(--tab-border) 66%, transparent);
    border-radius: var(--ui-radius-md);
    color: var(--tab-text);
    cursor: pointer;
    opacity: 0.8;
  }

  .tab-action-icon {
    display: inline-grid;
    place-items: center;
    width: 100%;
    height: 100%;
    line-height: 1;
    font-size: calc(var(--ui-font-size-lg) + 2px);
  }

  .tab-action-icon--plus {
    font-size: calc(var(--ui-font-size-xl) - 1px);
    transform: translateY(-1px);
  }

  .tab-action:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--tab-active-bg) 72%, transparent);
  }

  .drag-preview {
    position: fixed;
    z-index: 2000;
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: var(--ui-space-2);
    height: var(--tab-height);
    min-width: calc(144px * var(--ui-scale));
    max-width: calc(220px * var(--ui-scale));
    padding: 0 var(--ui-space-3);
    border: 1px solid color-mix(in srgb, var(--tab-border) 70%, transparent);
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--tab-active-bg) 88%, transparent);
    color: var(--tab-text);
    font-size: var(--ui-font-size-base);
    box-shadow: 0 16px 34px rgba(2, 6, 23, 0.3);
  }

  .drag-preview-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .drag-preview-grip {
    opacity: 0.65;
    font-size: var(--ui-font-size-base);
  }
</style>
