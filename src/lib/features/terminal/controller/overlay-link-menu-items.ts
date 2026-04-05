import type { ContextMenuItem } from "../../../ui/context-menu";
import type { LinkMenuTarget } from "../state/overlay-interaction-state.svelte";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function buildOverlayLinkMenuItems(
  target: LinkMenuTarget | null,
  t: TranslateFn,
  buildCandidateFileLinkMenuItems: (
    raw: string,
    candidates: Extract<LinkMenuTarget, { kind: "file-candidates" }>["candidates"],
  ) => ContextMenuItem[],
): ContextMenuItem[] {
  if (target?.kind === "file") {
    return [
      {
        id: "open-file",
        kind: "item",
        label: t("terminal.filePaths.openFile"),
        icon: "file",
      },
      {
        id: "open-in-internal-editor",
        kind: "item",
        label: t("terminal.filePaths.openInInternalEditor"),
        icon: "file",
      },
      {
        id: "open-in-other-editor",
        kind: "item",
        label: t("terminal.filePaths.openInOtherEditor"),
        icon: "open-with",
      },
      {
        id: "copy-path",
        kind: "item",
        label: t("terminal.filePaths.copyPath"),
        icon: "copy",
      },
    ];
  }

  if (target?.kind === "file-candidates") {
    return buildCandidateFileLinkMenuItems(target.raw, target.candidates);
  }

  return [
    {
      id: "open-link-in-browser",
      kind: "item",
      label: t("terminal.links.openInBrowser"),
      icon: "external-link",
    },
    {
      id: "copy-link",
      kind: "item",
      label: t("terminal.links.copyLink"),
      icon: "copy",
    },
  ];
}
