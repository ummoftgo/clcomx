import * as monaco from "monaco-editor";
import type { EditorSearchResult } from "../editors";
import type { InternalEditorTab } from "./contracts";
import {
  collectHeuristicDocumentSymbols,
  findFastHeuristicDefinition,
  findLineFastHeuristicDefinition,
  findHeuristicDefinition,
  type NavigationFileSnapshot,
  type HeuristicDocumentSymbol,
} from "./navigation";
import { fromMonacoFileUriString, toMonacoFileUriString } from "./path";

export interface MonacoNavigationTarget {
  wslPath: string;
  line?: number | null;
  column?: number | null;
  rootDir?: string;
  snapshot?: NavigationFileSnapshot;
}

export interface MonacoNavigationSessionOptions {
  editor: monaco.editor.IStandaloneCodeEditor;
  workspaceRoot: string;
  getTabs: () => InternalEditorTab[];
  listWorkspaceFiles: (rootDir: string) => Promise<EditorSearchResult[]>;
  readWorkspaceFile: (wslPath: string) => Promise<NavigationFileSnapshot>;
  openLocation: (target: MonacoNavigationTarget) => void | Promise<void>;
}

export interface MonacoNavigationSession {
  syncTabs: (tabs: InternalEditorTab[]) => void;
  setWorkspaceRoot: (workspaceRoot: string) => void;
  dispose: () => void;
}

interface RegisteredNavigationSession {
  editor: monaco.editor.IStandaloneCodeEditor;
  workspaceRoot: string;
  getTabs: () => InternalEditorTab[];
  listWorkspaceFiles: (rootDir: string) => Promise<EditorSearchResult[]>;
  readWorkspaceFile: (wslPath: string) => Promise<NavigationFileSnapshot>;
  openLocation: (target: MonacoNavigationTarget) => void | Promise<void>;
  modelUris: Set<string>;
  fileCache: Map<string, NavigationFileSnapshot>;
  workspaceFilesCache: {
    rootDir: string;
    lastLoadedMs: number;
    entries: EditorSearchResult[];
    inFlight: Promise<EditorSearchResult[]> | null;
  };
  definitionCache: Map<string, NavigationLocationCacheValue>;
}

interface NavigationLocationCacheValue {
  location: MonacoNavigationTarget | null;
}

const NAVIGATION_LANGUAGE_IDS = [
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "php",
  "svelte",
];

const WORKSPACE_FILE_CACHE_TTL_MS = 30_000;
const sessionByModelUri = new Map<string, RegisteredNavigationSession>();
const sessionByEditor = new WeakMap<monaco.editor.ICodeEditor, RegisteredNavigationSession>();
let configured = false;

export function createMonacoNavigationSession(
  options: MonacoNavigationSessionOptions,
): MonacoNavigationSession {
  ensureMonacoNavigationSupport();

  const session: RegisteredNavigationSession = {
    editor: options.editor,
    workspaceRoot: options.workspaceRoot,
    getTabs: options.getTabs,
    listWorkspaceFiles: options.listWorkspaceFiles,
    readWorkspaceFile: options.readWorkspaceFile,
    openLocation: options.openLocation,
    modelUris: new Set<string>(),
    fileCache: new Map<string, NavigationFileSnapshot>(),
    workspaceFilesCache: {
      rootDir: options.workspaceRoot,
      lastLoadedMs: 0,
      entries: [],
      inFlight: null,
    },
    definitionCache: new Map<string, NavigationLocationCacheValue>(),
  };

  sessionByEditor.set(options.editor, session);

  return {
    syncTabs(tabs) {
      const nextUris = new Set(tabs.map((tab) => toMonacoFileUriString(tab.wslPath)));

      for (const uri of session.modelUris) {
        if (nextUris.has(uri)) {
          continue;
        }
        if (sessionByModelUri.get(uri) === session) {
          sessionByModelUri.delete(uri);
        }
      }

      for (const tab of tabs) {
        const uri = toMonacoFileUriString(tab.wslPath);
        sessionByModelUri.set(uri, session);
        if (!tab.loading && !tab.error) {
          session.fileCache.set(tab.wslPath, {
            wslPath: tab.wslPath,
            content: tab.content,
            languageId: tab.languageId,
          });
        }
      }

      session.modelUris = nextUris;
    },
    setWorkspaceRoot(workspaceRoot) {
      if (session.workspaceRoot === workspaceRoot) {
        return;
      }

      session.workspaceRoot = workspaceRoot;
      session.workspaceFilesCache = {
        rootDir: workspaceRoot,
        lastLoadedMs: 0,
        entries: [],
        inFlight: null,
      };
      session.definitionCache.clear();
    },
    dispose() {
      for (const uri of session.modelUris) {
        if (sessionByModelUri.get(uri) === session) {
          sessionByModelUri.delete(uri);
        }
      }
      session.modelUris.clear();
      session.fileCache.clear();
      session.definitionCache.clear();
      sessionByEditor.delete(options.editor);
    },
  };
}

function ensureMonacoNavigationSupport() {
  if (configured) {
    return;
  }

  for (const languageId of NAVIGATION_LANGUAGE_IDS) {
    monaco.languages.registerDefinitionProvider(languageId, {
      async provideDefinition(model, position, token) {
        if (token.isCancellationRequested) {
          return null;
        }

        const session = sessionByModelUri.get(model.uri.toString());
        if (!session) {
          return null;
        }

        const modelPath = fromMonacoFileUriString(model.uri.toString()) ?? model.uri.path;
        const cacheKey = buildDefinitionCacheKey(model, position);
        const cached = session.definitionCache.get(cacheKey);
        if (cached) {
          return toDefinitionResult(cached.location);
        }

        const lineContent = model.getLineContent(position.lineNumber);
        const lineFastLocation = findLineFastHeuristicDefinition({
          modelPath,
          languageId: model.getLanguageId(),
          lineContent,
          lineNumber: position.lineNumber,
          column: position.column,
          workspaceRoot: session.workspaceRoot,
        });
        if (lineFastLocation && !token.isCancellationRequested) {
          const result = {
            wslPath: lineFastLocation.wslPath,
            line: lineFastLocation.line,
            column: lineFastLocation.column,
            rootDir: session.workspaceRoot,
          };
          rememberDefinitionResult(session, cacheKey, result);
          return toDefinitionResult(result);
        }

        const content = model.getValue();
        const fastLocation = findFastHeuristicDefinition({
          modelPath,
          languageId: model.getLanguageId(),
          content,
          lineNumber: position.lineNumber,
          column: position.column,
          workspaceRoot: session.workspaceRoot,
        });
        if (fastLocation && !token.isCancellationRequested) {
          const result = {
            wslPath: fastLocation.wslPath,
            line: fastLocation.line,
            column: fastLocation.column,
            rootDir: session.workspaceRoot,
          };
          rememberDefinitionResult(session, cacheKey, result);
          return toDefinitionResult(result);
        }

        const location = await findHeuristicDefinition({
          modelPath,
          languageId: model.getLanguageId(),
          content,
          lineNumber: position.lineNumber,
          column: position.column,
          workspaceRoot: session.workspaceRoot,
          workspaceFiles: await loadWorkspaceFiles(session),
          readWorkspaceFile: (wslPath) => loadWorkspaceFile(session, wslPath),
        });

        if (!location || token.isCancellationRequested) {
          rememberDefinitionResult(session, cacheKey, null);
          return null;
        }

        const result = {
          wslPath: location.wslPath,
          line: location.line,
          column: location.column,
          rootDir: session.workspaceRoot,
        };
        rememberDefinitionResult(session, cacheKey, result);
        return toDefinitionResult(result);
      },
    });
  }

  for (const languageId of ["php", "svelte"]) {
    monaco.languages.registerDocumentSymbolProvider(languageId, {
      provideDocumentSymbols(model) {
        return collectHeuristicDocumentSymbols(model.getValue(), model.getLanguageId()).map(
          (symbol) => toMonacoDocumentSymbol(symbol),
        );
      },
    });
  }

  monaco.editor.registerEditorOpener({
    async openCodeEditor(source, resource, selectionOrPosition) {
      const session = sessionByEditor.get(source);
      if (!session) {
        return false;
      }

      const wslPath = fromMonacoFileUriString(resource.toString());
      if (!wslPath) {
        return false;
      }

      const target = selectionOrPosition
        ? "startLineNumber" in selectionOrPosition
          ? {
              line: selectionOrPosition.startLineNumber,
              column: selectionOrPosition.startColumn,
            }
          : {
              line: selectionOrPosition.lineNumber,
              column: selectionOrPosition.column,
            }
        : { line: null, column: null };

      await session.openLocation({
        wslPath,
        line: target.line,
        column: target.column,
        rootDir: session.workspaceRoot,
        snapshot: session.fileCache.get(wslPath),
      });
      return true;
    },
  });

  configured = true;
}

async function loadWorkspaceFiles(session: RegisteredNavigationSession) {
  const now = Date.now();
  if (
    session.workspaceFilesCache.rootDir === session.workspaceRoot &&
    session.workspaceFilesCache.lastLoadedMs > 0 &&
    now - session.workspaceFilesCache.lastLoadedMs < WORKSPACE_FILE_CACHE_TTL_MS
  ) {
    return session.workspaceFilesCache.entries;
  }

  if (session.workspaceFilesCache.inFlight) {
    return session.workspaceFilesCache.inFlight;
  }

  const inFlight = session
    .listWorkspaceFiles(session.workspaceRoot)
    .then((entries) => {
      session.workspaceFilesCache = {
        rootDir: session.workspaceRoot,
        lastLoadedMs: Date.now(),
        entries,
        inFlight: null,
      };
      return entries;
    })
    .catch((error) => {
      session.workspaceFilesCache = {
        ...session.workspaceFilesCache,
        rootDir: session.workspaceRoot,
        inFlight: null,
      };
      throw error;
    });

  session.workspaceFilesCache = {
    rootDir: session.workspaceRoot,
    lastLoadedMs: session.workspaceFilesCache.lastLoadedMs,
    entries: session.workspaceFilesCache.entries,
    inFlight,
  };
  return inFlight;
}

function buildDefinitionCacheKey(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
) {
  return `${model.uri.toString()}::${model.getVersionId()}::${position.lineNumber}:${position.column}`;
}

function rememberDefinitionResult(
  session: RegisteredNavigationSession,
  cacheKey: string,
  location: MonacoNavigationTarget | null,
) {
  if (session.definitionCache.size > 256) {
    session.definitionCache.clear();
  }
  session.definitionCache.set(cacheKey, { location });
}

function toDefinitionResult(location: MonacoNavigationTarget | null) {
  if (!location) {
    return null;
  }

  return [
    {
      uri: monaco.Uri.parse(toMonacoFileUriString(location.wslPath)),
      range: {
        startLineNumber: location.line ?? 1,
        startColumn: location.column ?? 1,
        endLineNumber: location.line ?? 1,
        endColumn: location.column ?? 1,
      },
      targetSelectionRange: {
        startLineNumber: location.line ?? 1,
        startColumn: location.column ?? 1,
        endLineNumber: location.line ?? 1,
        endColumn: location.column ?? 1,
      },
    },
  ];
}

async function loadWorkspaceFile(
  session: RegisteredNavigationSession,
  wslPath: string,
): Promise<NavigationFileSnapshot> {
  const openTab = session
    .getTabs()
    .find((tab) => tab.wslPath === wslPath && !tab.loading && !tab.error);
  if (openTab) {
    const snapshot = {
      wslPath,
      content: openTab.content,
      languageId: openTab.languageId,
    };
    session.fileCache.set(wslPath, snapshot);
    return snapshot;
  }

  const cached = session.fileCache.get(wslPath);
  if (cached) {
    return cached;
  }

  const file = await session.readWorkspaceFile(wslPath);
  session.fileCache.set(wslPath, file);
  return file;
}

function toMonacoDocumentSymbol(
  symbol: HeuristicDocumentSymbol,
): monaco.languages.DocumentSymbol {
  const range = {
    startLineNumber: symbol.line,
    startColumn: symbol.column,
    endLineNumber: symbol.line,
    endColumn: symbol.column + Math.max(symbol.name.length, 1),
  };

  return {
    name: symbol.name,
    detail: symbol.detail,
    kind: toMonacoSymbolKind(symbol.kind),
    tags: [],
    containerName: symbol.containerName,
    range,
    selectionRange: range,
  };
}

function toMonacoSymbolKind(
  kind: HeuristicDocumentSymbol["kind"],
): monaco.languages.SymbolKind {
  switch (kind) {
    case "class":
      return monaco.languages.SymbolKind.Class;
    case "function":
      return monaco.languages.SymbolKind.Function;
    case "method":
      return monaco.languages.SymbolKind.Method;
    case "type":
      return monaco.languages.SymbolKind.Interface;
    case "variable":
    default:
      return monaco.languages.SymbolKind.Variable;
  }
}
