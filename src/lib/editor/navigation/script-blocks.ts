import type { ScriptBlock } from "../../features/editor/navigation/contracts";

export function extractScriptBlocks(content: string, svelteAware: boolean): ScriptBlock[] {
  if (!svelteAware) {
    return [{ content, lineOffset: 0 }];
  }

  const blocks: ScriptBlock[] = [];
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of content.matchAll(scriptRegex)) {
    const body = match[1] ?? "";
    const fullMatch = match[0] ?? "";
    const openTagEnd = fullMatch.indexOf(">") + 1;
    const bodyOffset = (match.index ?? 0) + Math.max(openTagEnd, 0);
    const prefix = content.slice(0, bodyOffset);
    blocks.push({
      content: body,
      lineOffset: prefix.split("\n").length - 1,
    });
  }

  return blocks.length > 0 ? blocks : [{ content, lineOffset: 0 }];
}
