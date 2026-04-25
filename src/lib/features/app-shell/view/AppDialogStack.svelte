<script lang="ts">
  import { _ as t } from "../../../i18n";
  import { TEST_IDS } from "../../../testids";
  import { Button, ModalShell } from "../../../ui";

  type RenameDialogKind = "tab" | "window" | null;
  type DirtyCloseDialogKind = "tab" | "app" | "window";
  type MaybePromise = unknown | Promise<unknown>;

  interface DirtyCloseDialogCopy {
    title: string;
    description: string;
    confirm: string;
  }

  interface Props {
    showDirtyTabDialog: boolean;
    showCloseTabDialog: boolean;
    showDirtyAppDialog: boolean;
    showDirtyWindowCloseDialog: boolean;
    showCloseWindowDialog: boolean;
    hasPendingCloseSession: boolean;
    pendingCloseSessionTitle?: string;
    dirtyAppCloseCount: number;
    dirtyWindowCloseCount: number;
    renameDialogKind: RenameDialogKind;
    renameDialogValue: string;
    useKoreanDirtyCopy: boolean;
    onDismissDirtyTab: () => MaybePromise;
    onContinueDirtyTabClose: () => MaybePromise;
    onDismissCloseTab: () => MaybePromise;
    onConfirmCloseTab: () => MaybePromise;
    onDismissDirtyApp: () => MaybePromise;
    onConfirmDirtyAppClose: () => MaybePromise;
    onDismissDirtyWindowClose: () => MaybePromise;
    onConfirmDirtyWindowClose: () => MaybePromise;
    onDismissCloseWindow: () => MaybePromise;
    onMoveWindowToMain: () => MaybePromise;
    onCloseWindowSessions: () => MaybePromise;
    onDismissRename: () => MaybePromise;
    onConfirmRename: () => MaybePromise;
  }

  let {
    showDirtyTabDialog,
    showCloseTabDialog,
    showDirtyAppDialog,
    showDirtyWindowCloseDialog,
    showCloseWindowDialog,
    hasPendingCloseSession,
    pendingCloseSessionTitle = "",
    dirtyAppCloseCount,
    dirtyWindowCloseCount,
    renameDialogKind,
    renameDialogValue = $bindable(""),
    useKoreanDirtyCopy,
    onDismissDirtyTab,
    onContinueDirtyTabClose,
    onDismissCloseTab,
    onConfirmCloseTab,
    onDismissDirtyApp,
    onConfirmDirtyAppClose,
    onDismissDirtyWindowClose,
    onConfirmDirtyWindowClose,
    onDismissCloseWindow,
    onMoveWindowToMain,
    onCloseWindowSessions,
    onDismissRename,
    onConfirmRename,
  }: Props = $props();

  function getDirtyCloseDialogCopy(
    kind: DirtyCloseDialogKind,
    options: { title?: string; count?: number } = {},
  ): DirtyCloseDialogCopy {
    const count = Math.max(0, options.count ?? 0);

    if (kind === "tab") {
      return useKoreanDirtyCopy
        ? {
            title: "저장되지 않은 변경 사항",
            description: `"${options.title || "이 탭"}"에 저장되지 않은 편집 내용이 있습니다. 닫으면 변경 사항이 버려집니다.`,
            confirm: "그대로 닫기",
          }
        : {
            title: "Unsaved Changes",
            description: `"${options.title || "This tab"}" has unsaved editor changes. Closing it will discard them.`,
            confirm: "Close Anyway",
          };
    }

    if (kind === "window") {
      return useKoreanDirtyCopy
        ? {
            title: "저장되지 않은 변경 사항",
            description: `이 창에는 저장되지 않은 편집 내용이 있는 세션이 ${count}개 있습니다. 닫으면 모두 버려집니다.`,
            confirm: "그대로 닫기",
          }
        : {
            title: "Unsaved Changes",
            description: `This window has ${count} session${count === 1 ? "" : "s"} with unsaved editor changes. Closing it will discard them.`,
            confirm: "Close Anyway",
          };
    }

    return useKoreanDirtyCopy
      ? {
          title: "저장되지 않은 변경 사항",
          description: `저장되지 않은 편집 내용이 있는 세션이 ${count}개 있습니다. 앱을 닫으면 모두 버려집니다.`,
          confirm: "그대로 종료",
        }
      : {
          title: "Unsaved Changes",
          description: `There ${count === 1 ? "is" : "are"} ${count} dirty editor session${count === 1 ? "" : "s"}. Closing the app will discard them.`,
          confirm: "Quit Anyway",
        };
  }

  const dirtyTabCopy = $derived(
    getDirtyCloseDialogCopy("tab", { title: pendingCloseSessionTitle }),
  );
  const dirtyAppCopy = $derived(
    getDirtyCloseDialogCopy("app", { count: dirtyAppCloseCount }),
  );
  const dirtyWindowCopy = $derived(
    getDirtyCloseDialogCopy("window", { count: dirtyWindowCloseCount }),
  );
  const renameCopyPrefix = $derived(
    renameDialogKind === "window" ? "rename.window" : "rename.tab",
  );

  function handleRenameKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter") return;

    event.preventDefault();
    void onConfirmRename();
  }
</script>

<ModalShell
  open={showDirtyTabDialog && hasPendingCloseSession}
  size="sm"
  onClose={onDismissDirtyTab}
>
  <div class="window-close-panel" data-testid={TEST_IDS.closeTabDialog}>
    <h2>{dirtyTabCopy.title}</h2>
    <p>{dirtyTabCopy.description}</p>
    <div class="window-close-actions">
      <Button variant="danger" onclick={() => { void onContinueDirtyTabClose(); }}>
        {dirtyTabCopy.confirm}
      </Button>
      <Button onclick={onDismissDirtyTab}>
        {$t("common.actions.cancel")}
      </Button>
    </div>
  </div>
</ModalShell>

<ModalShell
  open={showCloseTabDialog && hasPendingCloseSession}
  size="sm"
  onClose={onDismissCloseTab}
>
  <div class="window-close-panel" data-testid={TEST_IDS.closeTabDialog}>
    <h2>{$t("app.closeTab.title")}</h2>
    <p>{$t("app.closeTab.description", {
      values: { title: pendingCloseSessionTitle },
    })}</p>
    <div class="window-close-actions">
      <Button variant="danger" onclick={() => { void onConfirmCloseTab(); }}>
        {$t("app.closeTab.confirm")}
      </Button>
      <Button onclick={onDismissCloseTab}>
        {$t("common.actions.cancel")}
      </Button>
    </div>
  </div>
</ModalShell>

<ModalShell
  open={showDirtyAppDialog}
  size="sm"
  onClose={onDismissDirtyApp}
>
  <div class="window-close-panel" data-testid={TEST_IDS.closeWindowDialog}>
    <h2>{dirtyAppCopy.title}</h2>
    <p>{dirtyAppCopy.description}</p>
    <div class="window-close-actions">
      <Button variant="danger" onclick={() => { void onConfirmDirtyAppClose(); }}>
        {dirtyAppCopy.confirm}
      </Button>
      <Button onclick={onDismissDirtyApp}>
        {$t("common.actions.cancel")}
      </Button>
    </div>
  </div>
</ModalShell>

<ModalShell
  open={showDirtyWindowCloseDialog && showCloseWindowDialog}
  size="sm"
  onClose={onDismissDirtyWindowClose}
>
  <div class="window-close-panel" data-testid={TEST_IDS.closeWindowDialog}>
    <h2>{dirtyWindowCopy.title}</h2>
    <p>{dirtyWindowCopy.description}</p>
    <div class="window-close-actions">
      <Button variant="danger" onclick={() => { void onConfirmDirtyWindowClose(); }}>
        {dirtyWindowCopy.confirm}
      </Button>
      <Button onclick={onDismissDirtyWindowClose}>
        {$t("common.actions.cancel")}
      </Button>
    </div>
  </div>
</ModalShell>

<ModalShell
  open={showCloseWindowDialog && !showDirtyWindowCloseDialog}
  size="sm"
  onClose={onDismissCloseWindow}
>
  <div class="window-close-panel" data-testid={TEST_IDS.closeWindowDialog}>
    <h2>{$t("app.closeWindow.title")}</h2>
    <p>{$t("app.closeWindow.description")}</p>
    <div class="window-close-actions">
      <Button variant="primary" onclick={() => { void onMoveWindowToMain(); }}>
        {$t("app.closeWindow.moveTabsToMain")}
      </Button>
      <Button variant="danger" onclick={() => { void onCloseWindowSessions(); }}>
        {$t("app.closeWindow.closeTabs")}
      </Button>
      <Button onclick={onDismissCloseWindow}>
        {$t("common.actions.cancel")}
      </Button>
    </div>
  </div>
</ModalShell>

<ModalShell
  open={renameDialogKind !== null}
  size="sm"
  onClose={onDismissRename}
>
  <div class="window-close-panel rename-panel">
    <h2>{$t(`${renameCopyPrefix}.title`)}</h2>
    <p>{$t(`${renameCopyPrefix}.description`)}</p>
    <div class="rename-field">
      <label for="rename-input">
        {$t(`${renameCopyPrefix}.label`)}
      </label>
      <input
        id="rename-input"
        class="rename-input"
        type="text"
        bind:value={renameDialogValue}
        onkeydown={handleRenameKeydown}
      />
    </div>
    <div class="window-close-actions">
      <Button variant="primary" onclick={() => { void onConfirmRename(); }}>
        {$t(`${renameCopyPrefix}.confirm`)}
      </Button>
      <Button onclick={onDismissRename}>
        {$t("common.actions.cancel")}
      </Button>
    </div>
  </div>
</ModalShell>

<style>
  .window-close-panel {
    padding: 24px;
    color: var(--ui-text-primary);
  }

  .window-close-panel h2 {
    margin: 0 0 10px;
    font-size: 19px;
    line-height: 1.2;
  }

  .window-close-panel p {
    margin: 0 0 18px;
    color: var(--ui-text-muted);
    font-size: 14px;
    line-height: 1.55;
  }

  .window-close-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: flex-end;
  }

  .rename-panel {
    display: grid;
    gap: 16px;
  }

  .rename-field {
    display: grid;
    gap: 8px;
  }

  .rename-field label {
    font-size: 14px;
    color: var(--ui-text-secondary);
  }

  .rename-input {
    min-height: 42px;
    padding: 0 14px;
    border: 1px solid var(--ui-border-subtle);
    border-radius: var(--ui-radius-md);
    background: color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent);
    color: var(--ui-text-primary);
    font-size: var(--ui-font-size-base);
  }
</style>
