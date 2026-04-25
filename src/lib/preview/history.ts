import { DEFAULT_SETTINGS, type AppBootstrap, type TabHistoryEntry } from "../types";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameHistoryEntry(left: TabHistoryEntry, right: TabHistoryEntry) {
  return (
    left.agentId === right.agentId &&
    left.distro === right.distro &&
    left.workDir === right.workDir &&
    left.title === right.title &&
    (left.resumeToken ?? null) === (right.resumeToken ?? null) &&
    left.lastOpenedAt === right.lastOpenedAt
  );
}

function normalizeHistoryLimit(bootstrap: AppBootstrap, value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return bootstrap.settings?.history?.tabLimit ?? DEFAULT_SETTINGS.history.tabLimit;
  }
  return Math.max(1, Math.trunc(value));
}

function applyHistoryLimit(bootstrap: AppBootstrap, entries: TabHistoryEntry[]) {
  const limit = normalizeHistoryLimit(bootstrap, bootstrap.settings?.history?.tabLimit);
  return entries.slice(0, limit);
}

export function recordPreviewHistoryEntry(
  bootstrap: AppBootstrap,
  defaultWorkDir: string,
  args?: Record<string, unknown>,
) {
  const entry: TabHistoryEntry = {
    agentId: (args?.agentId as TabHistoryEntry["agentId"]) ?? "claude",
    distro: String(args?.distro ?? "Ubuntu-24.04"),
    workDir: String(args?.workDir ?? defaultWorkDir),
    title: String(args?.title ?? "workspace"),
    resumeToken: (args?.resumeToken as string | null | undefined) ?? null,
    lastOpenedAt: new Date().toISOString(),
  };

  const deduped = bootstrap.tabHistory.filter((existing) => {
    return !(
      existing.agentId === entry.agentId &&
      existing.distro === entry.distro &&
      existing.workDir === entry.workDir &&
      (existing.resumeToken ?? null) === (entry.resumeToken ?? null)
    );
  });

  bootstrap.tabHistory = applyHistoryLimit(bootstrap, [entry, ...deduped]);
  return clone(bootstrap.tabHistory);
}

export function removePreviewHistoryEntry(
  bootstrap: AppBootstrap,
  args?: Record<string, unknown>,
) {
  const candidate = (args?.entry ?? null) as TabHistoryEntry | null;
  if (!candidate) {
    return clone(bootstrap.tabHistory);
  }

  bootstrap.tabHistory = bootstrap.tabHistory.filter(
    (entry) => !sameHistoryEntry(entry, candidate),
  );
  return clone(bootstrap.tabHistory);
}

export function trimPreviewHistory(
  bootstrap: AppBootstrap,
  args?: Record<string, unknown>,
) {
  const limit = normalizeHistoryLimit(bootstrap, args?.limit);
  bootstrap.settings = {
    ...bootstrap.settings,
    history: {
      ...DEFAULT_SETTINGS.history,
      ...(bootstrap.settings?.history ?? {}),
      tabLimit: limit,
    },
  };
  bootstrap.tabHistory = bootstrap.tabHistory.slice(0, limit);
  return clone(bootstrap.tabHistory);
}
