import type { InternalEditorTab } from "../../../editor/contracts";
import type { ReadSessionFileResult } from "../../../editors";
import type { EditorTabRef } from "../../../types";

export interface HydratedEditorTab extends InternalEditorTab {
  mtimeMs: number;
}

interface LoadHydratedEditorTabsDependencies {
  readSessionFile: (sessionId: string, wslPath: string) => Promise<ReadSessionFileResult>;
}

export function buildEditorHydrationPlaceholderTabs(
  refs: EditorTabRef[],
): InternalEditorTab[] {
  return refs.map((ref) => ({
    wslPath: ref.wslPath,
    content: "",
    languageId: "plaintext",
    dirty: false,
    line: ref.line ?? null,
    column: ref.column ?? null,
    loading: true,
    saving: false,
    error: null,
  }));
}

export async function loadHydratedEditorTabs(
  deps: LoadHydratedEditorTabsDependencies,
  sessionId: string,
  refs: EditorTabRef[],
): Promise<HydratedEditorTab[]> {
  return await Promise.all(
    refs.map(async (ref) => {
      try {
        const file = await deps.readSessionFile(sessionId, ref.wslPath);
        return {
          wslPath: ref.wslPath,
          content: file.content,
          languageId: file.languageId || "plaintext",
          dirty: false,
          line: ref.line ?? null,
          column: ref.column ?? null,
          loading: false,
          saving: false,
          error: null,
          mtimeMs: file.mtimeMs,
        };
      } catch (error) {
        return {
          wslPath: ref.wslPath,
          content: "",
          languageId: "plaintext",
          dirty: false,
          line: ref.line ?? null,
          column: ref.column ?? null,
          loading: false,
          saving: false,
          error: error instanceof Error ? error.message : String(error),
          mtimeMs: 0,
        };
      }
    }),
  );
}

export function splitHydratedEditorTabs(loadedTabs: HydratedEditorTab[]) {
  const savedContentByPath: Record<string, string> = {};
  const mtimeByPath: Record<string, number> = {};

  for (const tab of loadedTabs) {
    if (tab.mtimeMs > 0) {
      savedContentByPath[tab.wslPath] = tab.content;
      mtimeByPath[tab.wslPath] = tab.mtimeMs;
    }
  }

  return {
    tabs: loadedTabs.map(({ mtimeMs, ...tab }) => tab),
    savedContentByPath,
    mtimeByPath,
  };
}

export function resolveHydratedActivePath(
  activePath: string | null,
  tabs: Pick<InternalEditorTab, "wslPath">[],
) {
  if (activePath && tabs.some((tab) => tab.wslPath === activePath)) {
    return activePath;
  }

  return tabs[0]?.wslPath ?? null;
}
