import { basenameFromPath } from "../../../editor/path";

export function normalizeWslPath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  const parts: string[] = [];
  const rawParts = normalized.split("/");
  for (const part of rawParts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return `/${parts.join("/")}`;
}

export function joinWslPath(basePath: string, targetPath: string) {
  if (!targetPath) {
    return normalizeWslPath(basePath);
  }
  return normalizeWslPath(`${normalizeWslPath(basePath)}/${targetPath}`);
}

export function basenameWithoutExtension(wslPath: string) {
  return basenameFromPath(wslPath).replace(/\.[^.]+$/, "");
}
