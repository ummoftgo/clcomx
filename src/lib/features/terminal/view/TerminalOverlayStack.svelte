<script lang="ts">
  import type { PendingClipboardImage } from "../../../clipboard";
  import ImagePasteModal from "../../../components/ImagePasteModal.svelte";
  import EditorPickerModal from "../../../components/EditorPickerModal.svelte";
  import type { DetectedEditor } from "../../../editors";
  import ContextMenu from "../../../ui/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "../../../ui/context-menu";
  import TerminalInterruptConfirmModal from "./TerminalInterruptConfirmModal.svelte";

  interface Props {
    linkMenuVisible: boolean;
    linkMenuX: number;
    linkMenuY: number;
    linkMenuItems: ContextMenuItem[];
    pendingClipboardImage: PendingClipboardImage | null;
    clipboardBusy: boolean;
    clipboardError: string | null;
    editorPickerVisible: boolean;
    editorPickerTitle: string;
    editorPickerDescription: string;
    editorPickerEmptyLabel: string;
    defaultEditorId: string;
    editors: DetectedEditor[];
    interruptConfirmVisible: boolean;
    onLinkMenuSelect: (item: Extract<ContextMenuItem, { kind: "item" }>) => void;
    onCloseLinkMenu: () => void;
    onCancelClipboardImage: () => void;
    onConfirmClipboardImage: () => void;
    onEditorSelect: (editor: DetectedEditor) => void;
    onCloseEditorPicker: () => void;
    onCloseInterruptConfirm: () => void;
    onConfirmInterrupt: () => void | Promise<void>;
  }

  let {
    linkMenuVisible,
    linkMenuX,
    linkMenuY,
    linkMenuItems,
    pendingClipboardImage,
    clipboardBusy,
    clipboardError,
    editorPickerVisible,
    editorPickerTitle,
    editorPickerDescription,
    editorPickerEmptyLabel,
    defaultEditorId,
    editors,
    interruptConfirmVisible,
    onLinkMenuSelect,
    onCloseLinkMenu,
    onCancelClipboardImage,
    onConfirmClipboardImage,
    onEditorSelect,
    onCloseEditorPicker,
    onCloseInterruptConfirm,
    onConfirmInterrupt,
  }: Props = $props();
</script>

<ContextMenu
  visible={linkMenuVisible}
  x={linkMenuX}
  y={linkMenuY}
  items={linkMenuItems}
  onSelect={onLinkMenuSelect}
  onClose={onCloseLinkMenu}
/>

<ImagePasteModal
  visible={pendingClipboardImage !== null}
  image={pendingClipboardImage}
  busy={clipboardBusy}
  error={clipboardError}
  onCancel={onCancelClipboardImage}
  onConfirm={onConfirmClipboardImage}
/>

<EditorPickerModal
  visible={editorPickerVisible}
  title={editorPickerTitle}
  description={editorPickerDescription}
  emptyLabel={editorPickerEmptyLabel}
  {defaultEditorId}
  {editors}
  onSelect={onEditorSelect}
  onClose={onCloseEditorPicker}
/>

<TerminalInterruptConfirmModal
  open={interruptConfirmVisible}
  onClose={onCloseInterruptConfirm}
  onConfirm={onConfirmInterrupt}
/>
