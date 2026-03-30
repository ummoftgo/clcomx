import { invoke } from "./tauri/core";

export interface SavedClipboardImage {
  hostPath: string;
  wslPath: string;
  filename: string;
}

export interface PendingClipboardImage {
  blob: Blob;
  previewUrl: string;
  mimeType: string;
  size: number;
}

function findImageFromClipboardData(data: DataTransfer | null): Blob | null {
  if (!data) return null;

  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) {
      continue;
    }

    const file = item.getAsFile();
    if (file) {
      return file;
    }
  }

  return null;
}

export function getImageFromPasteEvent(event: ClipboardEvent): Blob | null {
  return findImageFromClipboardData(event.clipboardData);
}

export async function readImageFromClipboard(): Promise<Blob | null> {
  if (!navigator.clipboard?.read) {
    throw new Error("Clipboard image read is not available in this environment.");
  }

  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (imageType) {
      return await item.getType(imageType);
    }
  }

  return null;
}

export function createPendingClipboardImage(blob: Blob): PendingClipboardImage {
  return {
    blob,
    previewUrl: URL.createObjectURL(blob),
    mimeType: blob.type || "image/png",
    size: blob.size,
  };
}

export function revokePendingClipboardImage(image: PendingClipboardImage | null) {
  if (!image) return;
  URL.revokeObjectURL(image.previewUrl);
}

export async function saveClipboardImage(
  image: PendingClipboardImage,
  distro: string,
): Promise<SavedClipboardImage> {
  const bytes = Array.from(new Uint8Array(await image.blob.arrayBuffer()));
  return await invoke<SavedClipboardImage>("save_clipboard_image", {
    bytes,
    distro,
    mimeType: image.mimeType,
  });
}

export async function clearImageCache(): Promise<number> {
  return await invoke<number>("clear_image_cache");
}

export interface ImageCacheStats {
  path: string;
  files: number;
  bytes: number;
}

export async function getImageCacheStats(): Promise<ImageCacheStats> {
  return await invoke<ImageCacheStats>("get_image_cache_stats");
}

export async function openImageCacheFolder(): Promise<string> {
  return await invoke<string>("open_image_cache_folder");
}

export function formatPathForAgentInput(path: string): string {
  const safePath = /[\s"'`]/.test(path)
    ? `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : path;

  return `${safePath} `;
}

export function formatImageSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${bytes} B`;
}
