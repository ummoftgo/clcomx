import type { EditorSearchResult, ReadSessionFileResult } from "../../../editors";

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

export interface JSImportBinding {
  localName: string;
  importedName: string;
  source: string;
}

export interface PHPUseBinding {
  alias: string;
  fqcn: string;
}

export interface ScriptBlock {
  content: string;
  lineOffset: number;
}

export interface PhpExpressionToken {
  type: "string" | "identifier" | "concat" | "lparen" | "rparen";
  value?: string;
}

export const JS_TS_LANGUAGE_IDS = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
]);

export const PHP_LANGUAGE_IDS = new Set(["php"]);
export const SVELTE_LANGUAGE_IDS = new Set(["svelte"]);

export const JS_TS_EXTENSIONS = [
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

export const PHP_EXTENSIONS = ["", ".php", ".phtml", ".inc.php", "/index.php"];

export const SVELTE_EXTENSIONS = [
  "",
  ".svelte",
  ".ts",
  ".js",
  "/index.svelte",
  "/index.ts",
  "/index.js",
];
