import { SVELTE_LANGUAGE_IDS } from "../../features/editor/navigation/contracts";
import type { JSImportBinding } from "../../features/editor/navigation/contracts";
import { extractScriptBlocks } from "./script-blocks";

export function parseJsImports(content: string, languageId: string): JSImportBinding[] {
  const blocks = extractScriptBlocks(content, SVELTE_LANGUAGE_IDS.has(languageId));
  const bindings: JSImportBinding[] = [];

  for (const block of blocks) {
    for (const match of block.content.matchAll(
      /^\s*import\s+(type\s+)?(.+?)\s+from\s+["']([^"']+)["'];?/gm,
    )) {
      const specifier = match[2]?.trim();
      const source = match[3]?.trim();
      if (!specifier || !source) {
        continue;
      }

      bindings.push(...parseJsImportSpecifier(specifier, source));
    }

    for (const match of block.content.matchAll(
      /^\s*export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?/gm,
    )) {
      const source = match[2]?.trim();
      if (!source) {
        continue;
      }
      for (const part of match[1].split(",")) {
        const normalized = part.trim();
        if (!normalized) {
          continue;
        }
        const aliasMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(
          normalized,
        );
        if (!aliasMatch) {
          continue;
        }

        bindings.push({
          localName: aliasMatch[2] || aliasMatch[1],
          importedName: aliasMatch[1],
          source,
        });
      }
    }
  }

  return bindings;
}

function parseJsImportSpecifier(specifier: string, source: string): JSImportBinding[] {
  const bindings: JSImportBinding[] = [];
  const trimmed = specifier.trim();
  if (!trimmed) {
    return bindings;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return parseNamedJsImports(trimmed.slice(1, -1), source);
  }

  if (trimmed.startsWith("* as ")) {
    const localName = trimmed.slice(5).trim();
    if (localName) {
      bindings.push({ localName, importedName: "*", source });
    }
    return bindings;
  }

  if (trimmed.includes(",")) {
    const [defaultImport, remainder] = trimmed.split(/,(.+)/, 2);
    if (defaultImport?.trim()) {
      bindings.push({
        localName: defaultImport.trim(),
        importedName: "default",
        source,
      });
    }

    if (remainder?.trim()) {
      if (remainder.trim().startsWith("{")) {
        bindings.push(...parseNamedJsImports(remainder.trim().slice(1, -1), source));
      } else if (remainder.trim().startsWith("* as ")) {
        bindings.push({
          localName: remainder.trim().slice(5).trim(),
          importedName: "*",
          source,
        });
      }
    }

    return bindings;
  }

  bindings.push({
    localName: trimmed,
    importedName: "default",
    source,
  });
  return bindings;
}

function parseNamedJsImports(specifierBody: string, source: string): JSImportBinding[] {
  const bindings: JSImportBinding[] = [];
  for (const part of specifierBody.split(",")) {
    const normalized = part.trim();
    if (!normalized) {
      continue;
    }

    const aliasMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(
      normalized,
    );
    if (!aliasMatch) {
      continue;
    }

    bindings.push({
      localName: aliasMatch[2] || aliasMatch[1],
      importedName: aliasMatch[1],
      source,
    });
  }
  return bindings;
}
