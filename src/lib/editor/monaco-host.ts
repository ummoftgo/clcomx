import "monaco-editor/min/vs/editor/editor.main.css";
import * as monaco from "monaco-editor";
import { ensureMonacoEnvironment } from "./monaco-environment";
import type { InternalEditorChangeEvent, InternalEditorTab } from "./contracts";
import { toMonacoFileUriString } from "./path";
import type { ThemeDef } from "../themes";
import {
  buildMonacoStandaloneThemeData,
  buildMonacoThemeName,
} from "./monaco-theme";

export interface MonacoEditorPresentationOptions {
  fontFamily: string;
  fontSize: number;
}

export interface MonacoEditorHostOptions {
  target: HTMLElement;
  tabs: InternalEditorTab[];
  activePath: string | null;
  theme: ThemeDef | null;
  presentation: MonacoEditorPresentationOptions;
  onChange: (event: InternalEditorChangeEvent) => void;
  onSaveRequest?: (wslPath: string) => void;
}

export interface MonacoEditorHost {
  syncTabs: (tabs: InternalEditorTab[]) => void;
  setActivePath: (wslPath: string | null) => void;
  setTheme: (theme: ThemeDef | null) => void;
  setPresentation: (presentation: MonacoEditorPresentationOptions) => void;
  focus: () => void;
  dispose: () => void;
}

interface ManagedModel {
  model: monaco.editor.ITextModel;
  changeDisposable: monaco.IDisposable;
}

export function createMonacoEditorHost(options: MonacoEditorHostOptions): MonacoEditorHost {
  ensureMonacoEnvironment();

  const managedModels = new Map<string, ManagedModel>();
  const syncingPaths = new Set<string>();
  let activeThemeName: string | null = null;

  function applyEditorTheme(theme: ThemeDef | null) {
    if (!theme) {
      monaco.editor.setTheme("vs-dark");
      activeThemeName = "vs-dark";
      return;
    }

    const themeName = buildMonacoThemeName(theme.id);
    monaco.editor.defineTheme(themeName, buildMonacoStandaloneThemeData(theme));
    monaco.editor.setTheme(themeName);
    activeThemeName = themeName;
  }

  applyEditorTheme(options.theme);

  const editor = monaco.editor.create(options.target, {
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: options.presentation.fontSize,
    fontFamily: options.presentation.fontFamily,
    roundedSelection: false,
    scrollBeyondLastLine: false,
    padding: { top: 16, bottom: 16 },
    tabSize: 2,
    insertSpaces: true,
    renderLineHighlight: "gutter",
    smoothScrolling: true,
    wordWrap: "on",
    stickyScroll: { enabled: false },
    theme: activeThemeName ?? undefined,
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    const model = editor.getModel();
    if (!model) return;
    const currentPath = findPathForModel(managedModels, model);
    if (!currentPath) return;
    options.onSaveRequest?.(currentPath);
  });

  function ensureModel(tab: InternalEditorTab) {
    const existing = managedModels.get(tab.wslPath);
    if (existing) {
      syncModel(existing.model, tab);
      return existing.model;
    }

    const uri = monaco.Uri.parse(toMonacoFileUriString(tab.wslPath));
    const model =
      monaco.editor.getModel(uri) ??
      monaco.editor.createModel(tab.content, tab.languageId || "plaintext", uri);
    monaco.editor.setModelLanguage(model, tab.languageId || "plaintext");

    const changeDisposable = model.onDidChangeContent(() => {
      if (syncingPaths.has(tab.wslPath)) {
        return;
      }
      options.onChange({
        wslPath: tab.wslPath,
        content: model.getValue(),
      });
    });

    managedModels.set(tab.wslPath, { model, changeDisposable });
    return model;
  }

  function syncModel(model: monaco.editor.ITextModel, tab: InternalEditorTab) {
    monaco.editor.setModelLanguage(model, tab.languageId || "plaintext");
    if (model.getValue() === tab.content) {
      return;
    }

    syncingPaths.add(tab.wslPath);
    model.setValue(tab.content);
    queueMicrotask(() => {
      syncingPaths.delete(tab.wslPath);
    });
  }

  function revealTab(tab: InternalEditorTab | undefined) {
    if (!tab) return;
    if (!tab.line || tab.line <= 0) return;
    const position = {
      lineNumber: tab.line,
      column: tab.column && tab.column > 0 ? tab.column : 1,
    };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
  }

  function syncTabs(tabs: InternalEditorTab[]) {
    const livePaths = new Set(tabs.map((tab) => tab.wslPath));

    for (const tab of tabs) {
      ensureModel(tab);
    }

    for (const [wslPath, entry] of managedModels) {
      if (livePaths.has(wslPath)) {
        continue;
      }
      if (editor.getModel() === entry.model) {
        editor.setModel(null);
      }
      entry.changeDisposable.dispose();
      entry.model.dispose();
      managedModels.delete(wslPath);
    }
  }

  function setActivePath(wslPath: string | null) {
    if (!wslPath) {
      editor.setModel(null);
      return;
    }

    const current = managedModels.get(wslPath);
    if (!current) {
      return;
    }

    if (editor.getModel() !== current.model) {
      editor.setModel(current.model);
    }

    revealTab(options.tabs.find((tab) => tab.wslPath === wslPath));
  }

  syncTabs(options.tabs);
  setActivePath(options.activePath);

  return {
    syncTabs(nextTabs) {
      options.tabs = nextTabs;
      syncTabs(nextTabs);
      setActivePath(options.activePath);
    },
    setActivePath(wslPath) {
      options.activePath = wslPath;
      setActivePath(wslPath);
    },
    setTheme(theme) {
      options.theme = theme;
      applyEditorTheme(theme);
    },
    setPresentation(presentation) {
      options.presentation = presentation;
      editor.updateOptions({
        fontFamily: presentation.fontFamily,
        fontSize: presentation.fontSize,
      });
    },
    focus() {
      editor.focus();
    },
    dispose() {
      for (const [, entry] of managedModels) {
        entry.changeDisposable.dispose();
        entry.model.dispose();
      }
      managedModels.clear();
      editor.dispose();
    },
  };
}

function findPathForModel(
  managedModels: Map<string, ManagedModel>,
  model: monaco.editor.ITextModel,
) {
  for (const [wslPath, entry] of managedModels) {
    if (entry.model === model) {
      return wslPath;
    }
  }
  return null;
}
