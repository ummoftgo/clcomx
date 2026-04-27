import type { EditorSearchResult } from "../../editors";
import type { PHPUseBinding } from "../../features/editor/navigation/contracts";
import {
  joinWslPath,
  normalizeWslPath,
} from "../../features/editor/navigation/wsl-path-utils";
import { basenameFromPath } from "../path";

export function parsePhpUses(content: string): PHPUseBinding[] {
  const bindings: PHPUseBinding[] = [];
  for (const match of content.matchAll(/^\s*use\s+([^;]+);/gm)) {
    const body = match[1]?.trim();
    if (!body || body.includes("{")) {
      continue;
    }

    for (const part of body.split(",")) {
      const normalized = part.trim();
      if (!normalized) {
        continue;
      }

      const aliasMatch = /^(.*?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(normalized);
      const fqcn = (aliasMatch?.[1] ?? normalized).trim().replace(/^\\+/, "");
      if (!fqcn) {
        continue;
      }

      const alias = (aliasMatch?.[2] ?? fqcn.split("\\").pop() ?? "").trim();
      if (!alias) {
        continue;
      }

      bindings.push({ alias, fqcn });
    }
  }

  return bindings;
}

export function resolvePhpClassPath(
  symbolOrFqcn: string,
  workspaceRoot: string,
  workspaceFiles: EditorSearchResult[],
) {
  const normalized = symbolOrFqcn.replace(/^\\+/, "").trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split("\\").filter(Boolean);
  const basename = `${segments[segments.length - 1]}.php`;
  const namespaceSuffix = segments.join("/");
  const explicitCandidate = normalizeWslPath(joinWslPath(workspaceRoot, `${namespaceSuffix}.php`));
  const matchingExplicit = workspaceFiles.find(
    (entry) => normalizeWslPath(entry.wslPath) === explicitCandidate,
  );
  if (matchingExplicit) {
    return matchingExplicit.wslPath;
  }

  const candidates = workspaceFiles.filter((entry) => entry.basename === basename);
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftScore = scorePhpWorkspaceCandidate(left.relativePath, namespaceSuffix);
    const rightScore = scorePhpWorkspaceCandidate(right.relativePath, namespaceSuffix);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });

  return candidates[0]?.wslPath ?? null;
}

export function scorePhpWorkspaceCandidate(relativePath: string, namespaceSuffix: string) {
  const normalizedRelative = relativePath.replace(/\\/g, "/");
  const namespacePath = `${namespaceSuffix}.php`;
  if (normalizedRelative === namespacePath) {
    return 0;
  }
  if (normalizedRelative.endsWith(`/${namespacePath}`)) {
    return 1;
  }
  if (normalizedRelative.endsWith(`/${basenameFromPath(namespacePath)}`)) {
    return 2;
  }
  return 3 + normalizedRelative.split("/").length;
}
