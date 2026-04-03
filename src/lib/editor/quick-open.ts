import type { EditorSearchResult } from "../editors";

export type EditorQuickOpenRank = [number, number, number, number, string];

interface PreparedEditorQuickOpenEntry {
  basenameLower: string;
  relativeLower: string;
}

const preparedEntryCache = new WeakMap<EditorSearchResult, PreparedEditorQuickOpenEntry>();

function prepareEntry(entry: EditorSearchResult): PreparedEditorQuickOpenEntry {
  const cached = preparedEntryCache.get(entry);
  if (cached) {
    return cached;
  }

  const prepared = {
    basenameLower: entry.basename.toLowerCase(),
    relativeLower: entry.relativePath.toLowerCase(),
  };
  preparedEntryCache.set(entry, prepared);
  return prepared;
}

export function getEditorQuickOpenRank(
  query: string,
  result: Pick<EditorSearchResult, "basename" | "relativePath">,
): EditorQuickOpenRank | null {
  const normalizedQuery = query.trim().toLowerCase();
  const basename = result.basename.toLowerCase();
  const relativePath = result.relativePath.toLowerCase();

  const bucket = !normalizedQuery
    ? 4
    : basename === normalizedQuery
      ? 0
      : basename.startsWith(normalizedQuery)
        ? 1
        : basename.includes(normalizedQuery)
          ? 2
          : relativePath.includes(normalizedQuery)
            ? 3
            : null;

  if (bucket === null) {
    return null;
  }

  return [
    bucket,
    result.relativePath.split("/").length - 1,
    result.relativePath.length,
    result.basename.length,
    relativePath,
  ];
}

export function compareEditorQuickOpenRank(
  left: EditorQuickOpenRank,
  right: EditorQuickOpenRank,
) {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    const delta =
      typeof leftValue === "string" && typeof rightValue === "string"
        ? leftValue.localeCompare(rightValue)
        : (leftValue as number) - (rightValue as number);

    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

export function filterEditorQuickOpenResults(
  entries: EditorSearchResult[],
  query: string,
  limit = 80,
) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const boundedLimit = Math.max(1, limit);
  const normalizedQueryLower = normalizedQuery.toLowerCase();
  const ranked: Array<{ result: EditorSearchResult; rank: EditorQuickOpenRank }> = [];

  for (const result of entries) {
    const prepared = prepareEntry(result);
    const bucket =
      prepared.basenameLower === normalizedQueryLower
        ? 0
        : prepared.basenameLower.startsWith(normalizedQueryLower)
          ? 1
          : prepared.basenameLower.includes(normalizedQueryLower)
            ? 2
            : prepared.relativeLower.includes(normalizedQueryLower)
              ? 3
              : null;

    if (bucket === null) {
      continue;
    }

    const rank: EditorQuickOpenRank = [
      bucket,
      result.relativePath.split("/").length - 1,
      result.relativePath.length,
      result.basename.length,
      prepared.relativeLower,
    ];

    let insertAt = ranked.length;
    while (insertAt > 0 && compareEditorQuickOpenRank(rank, ranked[insertAt - 1].rank) < 0) {
      insertAt -= 1;
    }

    if (insertAt >= boundedLimit) {
      continue;
    }

    ranked.splice(insertAt, 0, { result, rank });
    if (ranked.length > boundedLimit) {
      ranked.pop();
    }
  }

  return ranked.map(({ result }) => result);
}
