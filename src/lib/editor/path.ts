export function basenameFromPath(wslPath: string) {
  const normalized = wslPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

export function directoryFromPath(wslPath: string) {
  const normalized = wslPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "";
  }
  return normalized.slice(0, lastSlash);
}

export function toMonacoFileUriString(wslPath: string) {
  const normalized = wslPath.startsWith("/") ? wslPath : `/${wslPath}`;
  const segments = normalized.split("/").map((segment, index) => {
    if (index === 0) return "";
    return encodeURIComponent(segment);
  });
  return `file://${segments.join("/")}`;
}
