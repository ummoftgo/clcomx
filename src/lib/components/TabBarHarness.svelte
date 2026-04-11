<script lang="ts">
  import {
    getActiveSessionId,
    getSessions,
    moveSession,
    setActiveSession,
  } from "../features/session/state/live-session-store.svelte";
  import type { TabBarProps } from "../features/session-tabs/contracts/tab-bar";
  import TabBar from "./TabBar.svelte";

  type TabBarHarnessProps = Omit<
    TabBarProps,
    "activeSessionId" | "onActivateTab" | "onReorderTab" | "sessions"
  >;

  let {
    onNewTab,
    onRequestTerminalFocus,
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
  }: TabBarHarnessProps = $props();

  const sessions = $derived(getSessions());
  const activeSessionId = $derived(getActiveSessionId());
</script>

<TabBar
  {sessions}
  {activeSessionId}
  {onNewTab}
  onActivateTab={setActiveSession}
  onReorderTab={moveSession}
  {onRequestTerminalFocus}
  {onSettings}
  {onCloseTab}
  {onRenameTab}
  {onRenameWindow}
  {onTogglePinTab}
  {onToggleLockTab}
  {onMoveTabLeft}
  {onMoveTabRight}
  {onMoveTabToNewWindow}
  {onMoveTabToWindow}
  {availableWindows}
/>
