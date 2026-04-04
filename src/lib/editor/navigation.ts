import type { EditorSearchResult, ReadSessionFileResult } from "../editors";
import { basenameFromPath, directoryFromPath } from "./path";

export interface NavigationLocation {
  wslPath: string;
  line: number;
  column: number;
}

export interface HeuristicDocumentSymbol {
  name: string;
  detail: string;
  kind: "class" | "function" | "method" | "variable" | "type";
  line: number;
  column: number;
  containerName?: string;
}

export interface NavigationFileSnapshot
  extends Pick<ReadSessionFileResult, "wslPath" | "content" | "languageId"> {}

export interface HeuristicDefinitionRequest {
  modelPath: string;
  languageId: string;
  content: string;
  lineNumber: number;
  column: number;
  workspaceRoot: string;
  workspaceFiles: EditorSearchResult[];
  readWorkspaceFile: (wslPath: string) => Promise<NavigationFileSnapshot>;
}

interface JSImportBinding {
  localName: string;
  importedName: string;
  source: string;
}

interface PHPUseBinding {
  alias: string;
  fqcn: string;
}

interface ScriptBlock {
  content: string;
  lineOffset: number;
}

interface PhpExpressionToken {
  type: "string" | "identifier" | "concat" | "lparen" | "rparen";
  value?: string;
}

const JS_TS_LANGUAGE_IDS = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
]);

const PHP_LANGUAGE_IDS = new Set(["php"]);
const SVELTE_LANGUAGE_IDS = new Set(["svelte"]);

const JS_TS_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".svelte",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.mts",
  "/index.cts",
  "/index.mjs",
  "/index.cjs",
  "/index.svelte",
];

const PHP_EXTENSIONS = ["", ".php", ".phtml", ".inc.php", "/index.php"];
const SVELTE_EXTENSIONS = [
  "",
  ".svelte",
  ".ts",
  ".js",
  "/index.svelte",
  "/index.ts",
  "/index.js",
];

export async function findHeuristicDefinition(
  request: HeuristicDefinitionRequest,
): Promise<NavigationLocation | null> {
  const fastTarget = findFastHeuristicDefinition(request);
  if (fastTarget) {
    return fastTarget;
  }

  const pathTarget = resolvePathLikeDefinition(request);
  if (pathTarget) {
    return pathTarget;
  }

  const symbol = extractWordAtPosition(request.content, request.lineNumber, request.column);
  if (!symbol) {
    return null;
  }

  if (PHP_LANGUAGE_IDS.has(request.languageId)) {
    return findPhpDefinition(request, symbol);
  }

  if (SVELTE_LANGUAGE_IDS.has(request.languageId)) {
    return findSvelteDefinition(request, symbol);
  }

  if (JS_TS_LANGUAGE_IDS.has(request.languageId)) {
    return findJsTsDefinition(request, symbol);
  }

  return null;
}

export function findFastHeuristicDefinition(
  request: Pick<
    HeuristicDefinitionRequest,
    "modelPath" | "languageId" | "content" | "lineNumber" | "column" | "workspaceRoot"
  >,
): NavigationLocation | null {
  const pathTarget = resolveFastPathLikeDefinition(request);
  if (pathTarget) {
    return pathTarget;
  }

  const symbol = extractWordAtPosition(request.content, request.lineNumber, request.column);
  if (!symbol) {
    return null;
  }

  if (PHP_LANGUAGE_IDS.has(request.languageId) || SVELTE_LANGUAGE_IDS.has(request.languageId)) {
    const sameFile = findUniqueSameFileSymbol(request.content, request.languageId, symbol);
    if (sameFile) {
      return {
        ...sameFile,
        wslPath: request.modelPath,
      };
    }
  }

  return null;
}

export function findLineFastHeuristicDefinition(request: {
  modelPath: string;
  languageId: string;
  lineContent: string;
  lineNumber: number;
  column: number;
  workspaceRoot: string;
}): NavigationLocation | null {
  const extracted = extractQuotedValueAtColumnInLine(request.lineContent, request.column);
  if (!extracted) {
    return null;
  }

  if (PHP_LANGUAGE_IDS.has(request.languageId)) {
    const includeExpression = extractPhpIncludeExpressionInLine(
      request.lineContent,
      extracted.startColumn,
    );
    if (includeExpression) {
      const evaluatedExpression = evaluatePhpIncludeExpression(
        includeExpression.expression,
        request.modelPath,
      );
      if (evaluatedExpression) {
        const targetPath = resolveDirectPhpEvaluatedPath(evaluatedExpression, request.modelPath);
        if (targetPath) {
          return {
            wslPath: targetPath,
            line: 1,
            column: 1,
          };
        }
      }
    }
  }

  if (!looksLikeFileSpecifier(extracted.value)) {
    return null;
  }

  if (!isImportLikeContext(request.lineContent, extracted.startColumn)) {
    return null;
  }

  const targetPath = resolveDirectImportPath(
    extracted.value,
    request.modelPath,
    request.workspaceRoot,
    request.languageId,
  );
  if (!targetPath) {
    return null;
  }

  return {
    wslPath: targetPath,
    line: 1,
    column: 1,
  };
}

export function collectHeuristicDocumentSymbols(
  content: string,
  languageId: string,
): HeuristicDocumentSymbol[] {
  if (PHP_LANGUAGE_IDS.has(languageId)) {
    return collectPhpSymbols(content);
  }

  if (SVELTE_LANGUAGE_IDS.has(languageId)) {
    return collectSvelteSymbols(content);
  }

  if (JS_TS_LANGUAGE_IDS.has(languageId)) {
    return collectJsLikeSymbols(content);
  }

  return [];
}

function findJsTsDefinition(
  request: HeuristicDefinitionRequest,
  symbol: string,
): Promise<NavigationLocation | null> | NavigationLocation | null {
  const imports = parseJsImports(request.content, request.languageId);
  const binding = imports.find((entry) => entry.localName === symbol);
  if (!binding) {
    return null;
  }

  return resolveImportedDefinition(
    request,
    binding.source,
    binding.importedName,
    findJsLikeExportedSymbol,
  );
}

async function findPhpDefinition(
  request: HeuristicDefinitionRequest,
  symbol: string,
): Promise<NavigationLocation | null> {
  const sameFile = findUniqueSameFileSymbol(request.content, request.languageId, symbol);
  if (sameFile) {
    return {
      ...sameFile,
      wslPath: request.modelPath,
    };
  }

  const uses = parsePhpUses(request.content);
  const phpBinding = uses.find((entry) => entry.alias === symbol);
  if (phpBinding) {
    const resolvedPath = resolvePhpClassPath(
      phpBinding.fqcn,
      request.workspaceRoot,
      request.workspaceFiles,
    );
    if (!resolvedPath) {
      return null;
    }

    const file = await request.readWorkspaceFile(resolvedPath);
    const target = findPhpClassSymbol(file.content, basenameWithoutExtension(resolvedPath));
    if (target) {
      return {
        ...target,
        wslPath: resolvedPath,
      };
    }

    return {
      wslPath: resolvedPath,
      line: 1,
      column: 1,
    };
  }

  if (!/^[A-Z][A-Za-z0-9_]*$/.test(symbol)) {
    return null;
  }

  const fallbackPath = resolvePhpClassPath(symbol, request.workspaceRoot, request.workspaceFiles);
  if (!fallbackPath) {
    return null;
  }

  const file = await request.readWorkspaceFile(fallbackPath);
  return (
    findPhpClassSymbol(file.content, symbol) ?? {
      wslPath: fallbackPath,
      line: 1,
      column: 1,
    }
  );
}

async function findSvelteDefinition(
  request: HeuristicDefinitionRequest,
  symbol: string,
): Promise<NavigationLocation | null> {
  const sameFile = findUniqueSameFileSymbol(request.content, request.languageId, symbol);
  if (sameFile) {
    return {
      ...sameFile,
      wslPath: request.modelPath,
    };
  }

  const imports = parseJsImports(request.content, request.languageId);
  const binding = imports.find((entry) => entry.localName === symbol);
  if (!binding) {
    return null;
  }

  return resolveImportedDefinition(
    request,
    binding.source,
    binding.importedName,
    findJsLikeExportedSymbol,
  );
}

function findUniqueSameFileSymbol(
  content: string,
  languageId: string,
  symbolName: string,
): NavigationLocation | null {
  const matches = collectHeuristicDocumentSymbols(content, languageId).filter(
    (entry) => entry.name === symbolName,
  );

  if (matches.length !== 1) {
    return null;
  }

  return {
    wslPath: "",
    line: matches[0].line,
    column: matches[0].column,
  };
}

async function resolveImportedDefinition(
  request: HeuristicDefinitionRequest,
  importSource: string,
  importedName: string,
  findExportedSymbol: (content: string, symbolName: string) => NavigationLocation | null,
): Promise<NavigationLocation | null> {
  const targetPath = resolveImportPath(
    importSource,
    request.modelPath,
    request.workspaceRoot,
    request.languageId,
    request.workspaceFiles,
  );
  if (!targetPath) {
    return null;
  }

  const file = await request.readWorkspaceFile(targetPath);
  const exportedSymbol = findExportedSymbol(file.content, importedName);
  if (exportedSymbol) {
    return {
      ...exportedSymbol,
      wslPath: targetPath,
    };
  }

  return {
    wslPath: targetPath,
    line: 1,
    column: 1,
  };
}

function findJsLikeExportedSymbol(content: string, symbolName: string): NavigationLocation | null {
  const blocks = extractScriptBlocks(content, false);
  for (const block of blocks) {
    const exact =
      findNamedExportLocation(block.content, symbolName, block.lineOffset) ??
      findNamedSymbolLocation(block.content, symbolName, block.lineOffset);
    if (exact) {
      return exact;
    }
  }

  if (symbolName === "default") {
    for (const block of blocks) {
      const fallback = findDefaultExportLocation(block.content, block.lineOffset);
      if (fallback) {
        return fallback;
      }
    }
  }

  return null;
}

function findPhpClassSymbol(content: string, symbolName: string): NavigationLocation | null {
  const symbols = collectPhpSymbols(content).filter(
    (entry) => entry.name === symbolName && entry.kind === "class",
  );
  if (symbols.length !== 1) {
    return null;
  }

  return {
    wslPath: "",
    line: symbols[0].line,
    column: symbols[0].column,
  };
}

function resolvePathLikeDefinition(
  request: HeuristicDefinitionRequest,
): NavigationLocation | null {
  const extracted = extractQuotedValueAtPosition(
    request.content,
    request.lineNumber,
    request.column,
  );
  if (!extracted || !looksLikeFileSpecifier(extracted.value)) {
    if (PHP_LANGUAGE_IDS.has(request.languageId)) {
      return resolvePhpIncludeLikeDefinition(request, extracted);
    }
    return null;
  }

  if (PHP_LANGUAGE_IDS.has(request.languageId)) {
    const phpIncludeTarget = resolvePhpIncludeLikeDefinition(request, extracted);
    if (phpIncludeTarget) {
      return phpIncludeTarget;
    }
  }

  const targetPath = resolveImportPath(
    extracted.value,
    request.modelPath,
    request.workspaceRoot,
    request.languageId,
    request.workspaceFiles,
  );
  if (!targetPath) {
    return null;
  }

  return {
    wslPath: targetPath,
    line: 1,
    column: 1,
  };
}

function resolveFastPathLikeDefinition(
  request: Pick<
    HeuristicDefinitionRequest,
    "modelPath" | "languageId" | "content" | "lineNumber" | "column" | "workspaceRoot"
  >,
): NavigationLocation | null {
  const extracted = extractQuotedValueAtPosition(
    request.content,
    request.lineNumber,
    request.column,
  );
  if (!extracted) {
    return null;
  }

  const line = getLineContent(request.content, request.lineNumber);
  if (PHP_LANGUAGE_IDS.has(request.languageId)) {
    const includeExpression = extractPhpIncludeExpressionAtPosition(line, extracted.startColumn);
    if (includeExpression) {
      const evaluatedExpression = evaluatePhpIncludeExpression(
        includeExpression.expression,
        request.modelPath,
      );
      if (evaluatedExpression) {
        const targetPath = resolveDirectPhpEvaluatedPath(evaluatedExpression, request.modelPath);
        if (targetPath) {
          return {
            wslPath: targetPath,
            line: 1,
            column: 1,
          };
        }
      }
    }
  }

  if (!looksLikeFileSpecifier(extracted.value)) {
    return null;
  }

  if (!isImportLikeContext(line, extracted.startColumn)) {
    return null;
  }

  const targetPath = resolveDirectImportPath(
    extracted.value,
    request.modelPath,
    request.workspaceRoot,
    request.languageId,
  );
  if (!targetPath) {
    return null;
  }

  return {
    wslPath: targetPath,
    line: 1,
    column: 1,
  };
}

function resolvePhpIncludeLikeDefinition(
  request: HeuristicDefinitionRequest,
  extracted = extractQuotedValueAtPosition(
    request.content,
    request.lineNumber,
    request.column,
  ),
): NavigationLocation | null {
  if (!extracted) {
    return null;
  }

  const line = getLineContent(request.content, request.lineNumber);
  const includeExpression = extractPhpIncludeExpressionAtPosition(line, extracted.startColumn);
  if (includeExpression) {
    const evaluatedExpression = evaluatePhpIncludeExpression(
      includeExpression.expression,
      request.modelPath,
    );
    if (evaluatedExpression) {
      const evaluatedTarget = resolvePhpEvaluatedPath(
        evaluatedExpression,
        request.modelPath,
        request.workspaceFiles,
      );
      if (evaluatedTarget) {
        return {
          wslPath: evaluatedTarget,
          line: 1,
          column: 1,
        };
      }
    }
  }

  const expressionPrefix = line.slice(0, Math.max(0, extracted.startColumn - 1));
  if (!isPhpIncludeContext(expressionPrefix)) {
    return null;
  }

  const baseDir = resolvePhpIncludeBaseDirectory(expressionPrefix, request.modelPath);
  const targetPath = resolvePhpIncludePath(
    extracted.value,
    baseDir,
    request.modelPath,
    request.workspaceFiles,
  );
  if (!targetPath) {
    return null;
  }

  return {
    wslPath: targetPath,
    line: 1,
    column: 1,
  };
}

function collectPhpSymbols(content: string): HeuristicDocumentSymbol[] {
  const symbols: HeuristicDocumentSymbol[] = [];

  collectRegexSymbols(
    content,
    /^\s*(?:final\s+|abstract\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm,
    "class",
    symbols,
  );
  collectRegexSymbols(
    content,
    /^\s*(?:(?:public|protected|private)\s+)(?:static\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
    "method",
    symbols,
  );
  collectRegexSymbols(
    content,
    /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
    "function",
    symbols,
  );

  return dedupeSymbols(symbols);
}

function collectSvelteSymbols(content: string): HeuristicDocumentSymbol[] {
  const symbols: HeuristicDocumentSymbol[] = [];
  for (const block of extractScriptBlocks(content, true)) {
    symbols.push(...collectJsLikeSymbols(block.content, block.lineOffset));
  }
  return dedupeSymbols(symbols);
}

function collectJsLikeSymbols(
  content: string,
  lineOffset = 0,
): HeuristicDocumentSymbol[] {
  const symbols: HeuristicDocumentSymbol[] = [];

  collectRegexSymbols(
    content,
    /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm,
    "class",
    symbols,
    lineOffset,
  );
  collectRegexSymbols(
    content,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm,
    "function",
    symbols,
    lineOffset,
  );
  collectRegexSymbols(
    content,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm,
    "variable",
    symbols,
    lineOffset,
  );
  collectRegexSymbols(
    content,
    /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm,
    "type",
    symbols,
    lineOffset,
  );

  return dedupeSymbols(symbols);
}

function collectRegexSymbols(
  content: string,
  pattern: RegExp,
  kind: HeuristicDocumentSymbol["kind"],
  bucket: HeuristicDocumentSymbol[],
  lineOffset = 0,
) {
  for (const match of content.matchAll(pattern)) {
    const name = match[1]?.trim();
    const fullMatch = match[0];
    const matchIndex = match.index ?? -1;
    if (!name || matchIndex < 0) {
      continue;
    }

    const nameIndex = fullMatch.lastIndexOf(name);
    const position = offsetToLineColumn(content, matchIndex + Math.max(nameIndex, 0));
    bucket.push({
      name,
      detail: "",
      kind,
      line: position.line + lineOffset,
      column: position.column,
    });
  }
}

function dedupeSymbols(symbols: HeuristicDocumentSymbol[]) {
  const seen = new Set<string>();
  return symbols.filter((entry) => {
    const key = `${entry.kind}:${entry.name}:${entry.line}:${entry.column}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseJsImports(content: string, languageId: string): JSImportBinding[] {
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

function parsePhpUses(content: string): PHPUseBinding[] {
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

function findNamedExportLocation(
  content: string,
  symbolName: string,
  lineOffset = 0,
): NavigationLocation | null {
  const patterns = [
    new RegExp(
      `^\\s*export\\s+(?:async\\s+)?function\\s+(${escapeRegExp(symbolName)})\\b`,
      "gm",
    ),
    new RegExp(
      `^\\s*export\\s+(?:const|let|var)\\s+(${escapeRegExp(symbolName)})\\b`,
      "gm",
    ),
    new RegExp(
      `^\\s*export\\s+(?:class|interface|type|enum)\\s+(${escapeRegExp(symbolName)})\\b`,
      "gm",
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (!match || match.index === undefined) {
      continue;
    }

    const nameIndex = match[0].lastIndexOf(symbolName);
    const position = offsetToLineColumn(content, match.index + Math.max(nameIndex, 0));
    return {
      wslPath: "",
      line: position.line + lineOffset,
      column: position.column,
    };
  }

  return null;
}

function findNamedSymbolLocation(
  content: string,
  symbolName: string,
  lineOffset = 0,
): NavigationLocation | null {
  const symbols = collectJsLikeSymbols(content, lineOffset).filter(
    (entry) => entry.name === symbolName,
  );
  if (symbols.length !== 1) {
    return null;
  }

  return {
    wslPath: "",
    line: symbols[0].line,
    column: symbols[0].column,
  };
}

function findDefaultExportLocation(content: string, lineOffset = 0): NavigationLocation | null {
  const patterns = [
    /^\s*export\s+default\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm,
    /^\s*export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm,
    /^\s*export\s+default\s+/gm,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (!match || match.index === undefined) {
      continue;
    }

    const position = offsetToLineColumn(content, match.index);
    return {
      wslPath: "",
      line: position.line + lineOffset,
      column: position.column,
    };
  }

  return null;
}

function extractScriptBlocks(content: string, svelteAware: boolean): ScriptBlock[] {
  if (!svelteAware) {
    return [{ content, lineOffset: 0 }];
  }

  const blocks: ScriptBlock[] = [];
  for (const match of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gm)) {
    const innerContent = match[1] ?? "";
    const fullMatch = match[0] ?? "";
    const matchIndex = match.index ?? 0;
    const openTagEnd = fullMatch.indexOf(">") + 1;
    const innerStartIndex = matchIndex + Math.max(openTagEnd, 0);
    const startPosition = offsetToLineColumn(content, innerStartIndex);
    blocks.push({
      content: innerContent,
      lineOffset: startPosition.line - 1,
    });
  }

  return blocks.length > 0 ? blocks : [{ content, lineOffset: 0 }];
}

function extractQuotedValueAtPosition(
  content: string,
  lineNumber: number,
  column: number,
): { value: string; startColumn: number; endColumn: number } | null {
  const line = getLineContent(content, lineNumber);
  if (!line) {
    return null;
  }

  return extractQuotedValueAtColumnInLine(line, column);
}

function extractQuotedValueAtColumnInLine(
  line: string,
  column: number,
): { value: string; startColumn: number; endColumn: number } | null {
  if (!line) {
    return null;
  }

  const index = Math.max(0, column - 1);
  for (const quote of [`"`, "'", "`"]) {
    const start = findUnescapedQuoteLeft(line, index, quote);
    if (start < 0) {
      continue;
    }
    const end = findUnescapedQuoteRight(line, Math.max(index, start + 1), quote);
    if (end < 0 || index < start || index > end) {
      continue;
    }

    return {
      value: line.slice(start + 1, end),
      startColumn: start + 2,
      endColumn: end + 1,
    };
  }

  return null;
}

function findUnescapedQuoteLeft(line: string, fromIndex: number, quote: string) {
  for (let index = fromIndex; index >= 0; index -= 1) {
    if (line[index] !== quote) {
      continue;
    }
    if (!isEscaped(line, index)) {
      return index;
    }
  }
  return -1;
}

function findUnescapedQuoteRight(line: string, fromIndex: number, quote: string) {
  for (let index = fromIndex; index < line.length; index += 1) {
    if (line[index] !== quote) {
      continue;
    }
    if (!isEscaped(line, index)) {
      return index;
    }
  }
  return -1;
}

function isEscaped(line: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function looksLikeFileSpecifier(value: string) {
  if (!value.trim()) {
    return false;
  }
  if (/^(https?:|data:|mailto:)/i.test(value)) {
    return false;
  }
  return value.startsWith(".") || value.startsWith("/") || value.includes("/");
}

function isPhpIncludeContext(prefix: string) {
  return /\b(?:include|include_once|require|require_once)\b/i.test(prefix);
}

function isImportLikeContext(line: string, quotedStartColumn: number) {
  const prefix = line.slice(0, Math.max(0, quotedStartColumn - 1));
  return /\bimport\b|\bexport\b|\bfrom\b/i.test(prefix);
}

function extractPhpIncludeExpressionAtPosition(line: string, quotedStartColumn: number) {
  return extractPhpIncludeExpressionInLine(line, quotedStartColumn);
}

function extractPhpIncludeExpressionInLine(line: string, quotedStartColumn: number) {
  const quoteStartIndex = Math.max(0, quotedStartColumn - 2);
  const matches = [...line.matchAll(/\b(?:include|include_once|require|require_once)\b/gi)];
  const keywordMatch = matches.reverse().find((match) => (match.index ?? -1) <= quoteStartIndex);
  if (!keywordMatch || keywordMatch.index === undefined) {
    return null;
  }

  const expressionStart = keywordMatch.index + keywordMatch[0].length;
  const expressionEnd = line.indexOf(";", expressionStart);
  return {
    expression: line.slice(expressionStart, expressionEnd >= 0 ? expressionEnd : line.length),
  };
}

function resolvePhpIncludeBaseDirectory(expressionPrefix: string, modelPath: string) {
  const currentDir = directoryFromPath(modelPath);
  if (!currentDir) {
    return null;
  }

  let ascent = 0;
  for (const match of expressionPrefix.matchAll(/dirname\s*\(\s*__DIR__\s*\)/gi)) {
    if (match[0]) {
      ascent += 1;
    }
  }

  if (/dirname\s*\(\s*__FILE__\s*\)/i.test(expressionPrefix) || /__DIR__/i.test(expressionPrefix)) {
    return climbDirectories(currentDir, ascent);
  }

  if (/\b__FILE__\b/i.test(expressionPrefix)) {
    return currentDir;
  }

  return currentDir;
}

function evaluatePhpIncludeExpression(expression: string, modelPath: string) {
  const tokenList = tokenizePhpExpression(expression);
  if (!tokenList) {
    return null;
  }
  const tokens = tokenList;

  let cursor = 0;

  function parseExpression(): string | null {
    let value = parsePrimary();
    if (value === null) {
      return null;
    }

    while (tokens[cursor]?.type === "concat") {
      cursor += 1;
      const next = parsePrimary();
      if (next === null) {
        return null;
      }
      value += next;
    }

    return value;
  }

  function parsePrimary(): string | null {
    const token = tokens[cursor];
    if (!token) {
      return null;
    }

    if (token.type === "string") {
      cursor += 1;
      return token.value ?? "";
    }

    if (token.type === "lparen") {
      cursor += 1;
      const inner = parseExpression();
      if (inner === null || tokens[cursor]?.type !== "rparen") {
        return null;
      }
      cursor += 1;
      return inner;
    }

    if (token.type === "identifier") {
      const identifier = token.value ?? "";
      cursor += 1;
      if (identifier === "__DIR__") {
        return directoryFromPath(modelPath);
      }
      if (identifier === "__FILE__") {
        return modelPath;
      }
      if (identifier === "dirname") {
        if (tokens[cursor]?.type !== "lparen") {
          return null;
        }
        cursor += 1;
        const inner = parseExpression();
        if (inner === null || tokens[cursor]?.type !== "rparen") {
          return null;
        }
        cursor += 1;
        return phpDirname(inner);
      }
    }

    return null;
  }

  const value = parseExpression();
  if (value === null || cursor !== tokens.length) {
    return null;
  }

  return value;
}

function tokenizePhpExpression(expression: string): PhpExpressionToken[] | null {
  const tokens: PhpExpressionToken[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === "." || character === "(" || character === ")") {
      tokens.push({
        type:
          character === "."
            ? "concat"
            : character === "("
              ? "lparen"
              : "rparen",
      });
      index += 1;
      continue;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      let cursor = index + 1;
      let value = "";
      while (cursor < expression.length) {
        const current = expression[cursor];
        if (current === quote && expression[cursor - 1] !== "\\") {
          break;
        }
        value += current;
        cursor += 1;
      }
      if (cursor >= expression.length) {
        return null;
      }
      tokens.push({ type: "string", value });
      index = cursor + 1;
      continue;
    }

    if (/[A-Za-z_]/.test(character)) {
      let cursor = index + 1;
      while (cursor < expression.length && /[A-Za-z0-9_]/.test(expression[cursor])) {
        cursor += 1;
      }
      tokens.push({
        type: "identifier",
        value: expression.slice(index, cursor),
      });
      index = cursor;
      continue;
    }

    return null;
  }

  return tokens;
}

function phpDirname(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) {
    return ".";
  }
  if (lastSlash === 0) {
    return "/";
  }
  return normalized.slice(0, lastSlash);
}

function resolvePhpEvaluatedPath(
  evaluatedPath: string,
  modelPath: string,
  workspaceFiles: EditorSearchResult[],
) {
  const normalizedValue = evaluatedPath.trim();
  if (!normalizedValue) {
    return null;
  }

  const fileSet = new Set(workspaceFiles.map((entry) => normalizeWslPath(entry.wslPath)));
  const basePath = normalizedValue.startsWith("/")
    ? normalizeWslPath(normalizedValue)
    : joinWslPath(directoryFromPath(modelPath), normalizedValue);
  const candidates = new Set<string>();

  if (hasExplicitFileExtension(normalizedValue)) {
    candidates.add(basePath);
  } else {
    for (const suffix of PHP_EXTENSIONS) {
      candidates.add(`${basePath}${suffix}`);
    }
  }

  for (const candidate of candidates) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveDirectPhpEvaluatedPath(evaluatedPath: string, modelPath: string) {
  const normalizedValue = evaluatedPath.trim();
  if (!normalizedValue) {
    return null;
  }

  const basePath = normalizedValue.startsWith("/")
    ? normalizeWslPath(normalizedValue)
    : joinWslPath(directoryFromPath(modelPath), normalizedValue);
  if (hasExplicitFileExtension(normalizedValue)) {
    return basePath;
  }

  return `${basePath}.php`;
}

function resolvePhpIncludePath(
  specifier: string,
  baseDir: string | null,
  modelPath: string,
  workspaceFiles: EditorSearchResult[],
) {
  const normalizedSpecifier = specifier.trim();
  if (!normalizedSpecifier) {
    return null;
  }

  const fileSet = new Set(workspaceFiles.map((entry) => normalizeWslPath(entry.wslPath)));
  const candidates = new Set<string>();
  const pushCandidate = (candidatePath: string) => {
    const normalized = normalizeWslPath(candidatePath);
    if (normalized) {
      candidates.add(normalized);
    }
  };

  const candidateBases = new Set<string>();
  if (baseDir) {
    candidateBases.add(baseDir);
  }
  candidateBases.add(directoryFromPath(modelPath));

  if (normalizedSpecifier.startsWith("/")) {
    pushCandidate(normalizedSpecifier);
  } else {
    for (const candidateBase of candidateBases) {
      if (!candidateBase) {
        continue;
      }
      pushCandidate(joinWslPath(candidateBase, normalizedSpecifier));
    }
  }

  const expandedCandidates = new Set<string>();
  for (const candidate of candidates) {
    if (hasExplicitFileExtension(normalizedSpecifier)) {
      expandedCandidates.add(candidate);
      continue;
    }

    for (const suffix of PHP_EXTENSIONS) {
      expandedCandidates.add(`${candidate}${suffix}`);
    }
  }

  for (const candidate of expandedCandidates) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function climbDirectories(startPath: string, levels: number) {
  let current = normalizeWslPath(startPath);
  for (let index = 0; index < levels; index += 1) {
    current = directoryFromPath(current) || "/";
  }
  return current || "/";
}

function extractWordAtPosition(content: string, lineNumber: number, column: number) {
  const line = getLineContent(content, lineNumber);
  if (!line) {
    return null;
  }

  const index = Math.max(0, column - 1);
  const isWordChar = (character: string) => /[A-Za-z0-9_$]/.test(character);
  if (!isWordChar(line[index] ?? "") && !isWordChar(line[index - 1] ?? "")) {
    return null;
  }

  let start = index;
  if (!isWordChar(line[start] ?? "") && isWordChar(line[start - 1] ?? "")) {
    start -= 1;
  }
  while (start > 0 && isWordChar(line[start - 1])) {
    start -= 1;
  }

  let end = index;
  while (end < line.length && isWordChar(line[end])) {
    end += 1;
  }

  const word = line.slice(start, end).trim();
  return word || null;
}

function resolveImportPath(
  specifier: string,
  fromPath: string,
  workspaceRoot: string,
  languageId: string,
  workspaceFiles: EditorSearchResult[],
) {
  const normalizedSpecifier = specifier.trim();
  if (!looksLikeFileSpecifier(normalizedSpecifier)) {
    return null;
  }

  const pathSet = new Set(workspaceFiles.map((entry) => normalizeWslPath(entry.wslPath)));
  const extensions = getImportCandidateExtensions(languageId);
  const pathCandidates = new Set<string>();

  const pushCandidate = (candidatePath: string) => {
    const normalized = normalizeWslPath(candidatePath);
    if (normalized) {
      pathCandidates.add(normalized);
    }
  };

  const basePath = normalizedSpecifier.startsWith("/")
    ? joinWslPath(workspaceRoot, normalizedSpecifier.slice(1))
    : joinWslPath(directoryFromPath(fromPath), normalizedSpecifier);

  if (hasExplicitFileExtension(normalizedSpecifier)) {
    pushCandidate(basePath);
  } else {
    for (const suffix of extensions) {
      pushCandidate(`${basePath}${suffix}`);
    }
  }

  for (const candidate of pathCandidates) {
    if (pathSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveDirectImportPath(
  specifier: string,
  fromPath: string,
  workspaceRoot: string,
  languageId: string,
) {
  const normalizedSpecifier = specifier.trim();
  if (!looksLikeFileSpecifier(normalizedSpecifier)) {
    return null;
  }

  const extensions = getImportCandidateExtensions(languageId);
  const basePath = normalizedSpecifier.startsWith("/")
    ? joinWslPath(workspaceRoot, normalizedSpecifier.slice(1))
    : joinWslPath(directoryFromPath(fromPath), normalizedSpecifier);

  if (hasExplicitFileExtension(normalizedSpecifier)) {
    return basePath;
  }

  if (normalizedSpecifier.endsWith("/index")) {
    for (const suffix of extensions) {
      if (suffix.startsWith(".")) {
        return `${basePath}${suffix}`;
      }
    }
  }

  return null;
}

function resolvePhpClassPath(
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

function scorePhpWorkspaceCandidate(relativePath: string, namespaceSuffix: string) {
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

function getImportCandidateExtensions(languageId: string) {
  if (PHP_LANGUAGE_IDS.has(languageId)) {
    return PHP_EXTENSIONS;
  }
  if (SVELTE_LANGUAGE_IDS.has(languageId)) {
    return SVELTE_EXTENSIONS;
  }
  if (JS_TS_LANGUAGE_IDS.has(languageId)) {
    return JS_TS_EXTENSIONS;
  }
  return [""];
}

function hasExplicitFileExtension(specifier: string) {
  return /\/?[^/]+\.[A-Za-z0-9]+$/.test(specifier.trim());
}

function normalizeWslPath(value: string) {
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

function joinWslPath(basePath: string, targetPath: string) {
  if (!targetPath) {
    return normalizeWslPath(basePath);
  }
  return normalizeWslPath(`${normalizeWslPath(basePath)}/${targetPath}`);
}

function basenameWithoutExtension(wslPath: string) {
  return basenameFromPath(wslPath).replace(/\.[^.]+$/, "");
}

function getLineContent(content: string, lineNumber: number) {
  return content.split("\n")[Math.max(0, lineNumber - 1)] ?? "";
}

function offsetToLineColumn(content: string, offset: number) {
  const slice = content.slice(0, offset);
  const lines = slice.split("\n");
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
