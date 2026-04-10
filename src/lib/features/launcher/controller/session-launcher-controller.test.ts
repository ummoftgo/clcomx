import { describe, expect, it, vi } from "vitest";
import type { AgentId } from "../../../agents";
import type { TabHistoryEntry } from "../../../types";
import {
  createSessionLauncherController,
  createSessionLauncherState,
  getParentPath,
  type SessionLauncherControllerDependencies,
} from "./session-launcher-controller";

const HISTORY_ENTRY: TabHistoryEntry = {
  agentId: "claude",
  distro: "Ubuntu",
  workDir: "/workspace/demo",
  title: "Demo",
  resumeToken: "resume-1",
  lastOpenedAt: "2026-04-11T00:00:00.000Z",
};

function createRuntime(
  overrides: Partial<SessionLauncherControllerDependencies> = {},
) {
  const state = overrides.state ?? createSessionLauncherState("claude");
  const deps: SessionLauncherControllerDependencies = {
    state,
    getDefaultAgentId: vi.fn(() => "claude"),
    getDefaultDistro: vi.fn(() => "Ubuntu"),
    getDefaultStartPathsByDistro: vi.fn(() => ({ Ubuntu: "/home/user/work" })),
    getAvailableAgentIds: vi.fn(() => ["claude", "codex"]),
    listWslDistros: vi.fn(async () => ["Ubuntu", "Debian"]),
    listWslDirectories: vi.fn(async (_distro: string, path: string) => [
      { name: "src", path: `${path}/src` },
    ]),
    removeHistoryEntry: vi.fn(async () => {}),
    onOpenHistory: vi.fn(),
    onConfirm: vi.fn(),
    formatNoDistrosError: vi.fn(() => "No distros"),
    formatLoadDistrosError: vi.fn((error: unknown) => `Load distros failed: ${error}`),
    formatLoadDirectoriesError: vi.fn((error: unknown) => `Load directories failed: ${error}`),
    formatDeleteHistoryError: vi.fn((error: unknown) => `Delete failed: ${error}`),
    ...overrides,
  };

  return {
    state,
    deps,
    controller: createSessionLauncherController(deps),
  };
}

describe("session-launcher-controller", () => {
  it("starts a new-session flow with the preferred distro and default path", async () => {
    const runtime = createRuntime();

    await runtime.controller.beginNewSession();

    expect(runtime.state.step).toBe("browser");
    expect(runtime.state.selectedDistro).toBe("Ubuntu");
    expect(runtime.state.currentPath).toBe("/home/user/work");
    expect(runtime.state.pathInput).toBe("/home/user/work");
    expect(runtime.state.directories).toEqual([
      { name: "src", path: "/home/user/work/src" },
    ]);
    expect(runtime.deps.listWslDistros).toHaveBeenCalledTimes(1);
    expect(runtime.deps.listWslDirectories).toHaveBeenCalledWith("Ubuntu", "/home/user/work");
  });

  it("falls back to the first distro when the configured default is unavailable", async () => {
    const runtime = createRuntime({
      getDefaultDistro: vi.fn(() => "Missing"),
      getDefaultStartPathsByDistro: vi.fn(() => ({ Debian: "/home/debian" })),
      listWslDistros: vi.fn(async () => ["Debian"]),
    });

    await runtime.controller.beginNewSession();

    expect(runtime.state.selectedDistro).toBe("Debian");
    expect(runtime.state.currentPath).toBe("/home/debian");
    expect(runtime.deps.listWslDirectories).toHaveBeenCalledWith("Debian", "/home/debian");
  });

  it("shows a no-distro error without navigating when no distro is available", async () => {
    const runtime = createRuntime({
      listWslDistros: vi.fn(async () => []),
    });

    await runtime.controller.beginNewSession();

    expect(runtime.state.step).toBe("browser");
    expect(runtime.state.selectedDistro).toBe("");
    expect(runtime.state.currentPath).toBe("/home");
    expect(runtime.state.error).toBe("No distros");
    expect(runtime.deps.listWslDirectories).not.toHaveBeenCalled();
  });

  it("surfaces distro load failures without navigating", async () => {
    const loadError = new Error("wsl unavailable");
    const runtime = createRuntime({
      listWslDistros: vi.fn(async () => {
        throw loadError;
      }),
    });

    await runtime.controller.beginNewSession();

    expect(runtime.state.step).toBe("browser");
    expect(runtime.state.selectedDistro).toBe("");
    expect(runtime.state.error).toBe(`Load distros failed: ${loadError}`);
    expect(runtime.state.loading).toBe(false);
    expect(runtime.deps.listWslDirectories).not.toHaveBeenCalled();
  });

  it("clears directory entries and records an error when navigation fails", async () => {
    const loadError = new Error("permission denied");
    const runtime = createRuntime({
      listWslDirectories: vi.fn(async () => {
        throw loadError;
      }),
    });
    runtime.state.selectedDistro = "Ubuntu";
    runtime.state.directories = [{ name: "old", path: "/old" }];

    await runtime.controller.navigateTo("/restricted");

    expect(runtime.state.currentPath).toBe("/restricted");
    expect(runtime.state.directories).toEqual([]);
    expect(runtime.state.error).toBe(`Load directories failed: ${loadError}`);
    expect(runtime.state.loading).toBe(false);
  });

  it("records directory navigation history and supports back and forward", async () => {
    const runtime = createRuntime();

    await runtime.controller.navigateTo("/home/user");
    await runtime.controller.navigateTo("/home/user/project");
    await runtime.controller.goBackHistory();

    expect(runtime.state.currentPath).toBe("/home/user");
    expect(runtime.state.navigationHistory).toEqual([
      "/home",
      "/home/user",
      "/home/user/project",
    ]);
    expect(runtime.state.navigationIndex).toBe(1);

    await runtime.controller.goForwardHistory();

    expect(runtime.state.currentPath).toBe("/home/user/project");
    expect(runtime.state.navigationIndex).toBe(2);
  });

  it("navigates up to the parent path", async () => {
    const runtime = createRuntime();
    runtime.state.selectedDistro = "Ubuntu";
    runtime.state.currentPath = "/home/user/work";

    await runtime.controller.goUp();

    expect(runtime.state.currentPath).toBe("/home/user");
    expect(runtime.deps.listWslDirectories).toHaveBeenCalledWith("Ubuntu", "/home/user");
  });

  it("opens history and resets only non-embedded launcher instances", () => {
    const runtime = createRuntime();
    runtime.state.step = "browser";
    runtime.state.selectedDistro = "Ubuntu";

    runtime.controller.selectHistory(HISTORY_ENTRY, { embedded: false });

    expect(runtime.deps.onOpenHistory).toHaveBeenCalledWith(HISTORY_ENTRY);
    expect(runtime.state.step).toBe("home");
    expect(runtime.state.selectedDistro).toBe("");

    const embeddedRuntime = createRuntime();
    embeddedRuntime.state.step = "browser";
    embeddedRuntime.state.selectedDistro = "Ubuntu";
    embeddedRuntime.controller.selectHistory(HISTORY_ENTRY, { embedded: true });

    expect(embeddedRuntime.state.step).toBe("browser");
    expect(embeddedRuntime.state.selectedDistro).toBe("Ubuntu");
  });

  it("confirms a directory with the typed path and resets to home", () => {
    const runtime = createRuntime();
    runtime.state.step = "browser";
    runtime.state.selectedAgentId = "codex";
    runtime.state.selectedDistro = "Ubuntu";
    runtime.state.selectedPath = "/selected";
    runtime.state.pathInput = "  /typed/path  ";

    runtime.controller.confirmDirectory();

    expect(runtime.deps.onConfirm).toHaveBeenCalledWith("codex", "Ubuntu", "/typed/path");
    expect(runtime.state.step).toBe("home");
    expect(runtime.state.pathInput).toBe("/home");
  });

  it("opens the typed directory and closes the distro picker after selection", async () => {
    const runtime = createRuntime({
      getDefaultStartPathsByDistro: vi.fn(() => ({ Debian: "/home/debian" })),
    });
    runtime.state.selectedDistro = "Ubuntu";
    runtime.state.pathInput = "  /typed/path  ";

    await runtime.controller.openSelectedDirectory();

    expect(runtime.state.currentPath).toBe("/typed/path");
    expect(runtime.deps.listWslDirectories).toHaveBeenCalledWith("Ubuntu", "/typed/path");

    runtime.state.distroPickerOpen = true;
    runtime.controller.selectDistroAndClose("Debian");

    expect(runtime.state.selectedDistro).toBe("Debian");
    expect(runtime.state.currentPath).toBe("/home/debian");
    expect(runtime.state.distroPickerOpen).toBe(false);
  });

  it("deletes a history entry and leaves the dialog open on failure", async () => {
    const runtime = createRuntime();
    runtime.controller.promptDeleteHistory(HISTORY_ENTRY);

    await runtime.controller.confirmDeleteHistory();

    expect(runtime.deps.removeHistoryEntry).toHaveBeenCalledWith(HISTORY_ENTRY);
    expect(runtime.state.pendingDeleteEntry).toBeNull();

    const deleteError = new Error("locked");
    const failingRuntime = createRuntime({
      removeHistoryEntry: vi.fn(async () => {
        throw deleteError;
      }),
    });
    failingRuntime.controller.promptDeleteHistory(HISTORY_ENTRY);

    await failingRuntime.controller.confirmDeleteHistory();

    expect(failingRuntime.state.pendingDeleteEntry).toEqual(HISTORY_ENTRY);
    expect(failingRuntime.state.historyDeleteError).toBe(`Delete failed: ${deleteError}`);
    expect(failingRuntime.state.deletingHistoryEntry).toBe(false);
  });

  it("does not dismiss the delete dialog while deletion is pending", () => {
    const runtime = createRuntime();
    runtime.state.pendingDeleteEntry = HISTORY_ENTRY;
    runtime.state.historyDeleteError = "previous error";
    runtime.state.deletingHistoryEntry = true;

    runtime.controller.dismissDeleteHistoryDialog();

    expect(runtime.state.pendingDeleteEntry).toEqual(HISTORY_ENTRY);
    expect(runtime.state.historyDeleteError).toBe("previous error");
  });

  it("does not submit duplicate history delete requests while deletion is pending", async () => {
    const runtime = createRuntime();
    runtime.state.pendingDeleteEntry = HISTORY_ENTRY;
    runtime.state.deletingHistoryEntry = true;

    await runtime.controller.confirmDeleteHistory();

    expect(runtime.deps.removeHistoryEntry).not.toHaveBeenCalled();
    expect(runtime.state.pendingDeleteEntry).toEqual(HISTORY_ENTRY);
  });

  it("keeps the selected agent aligned with available agents", () => {
    const runtime = createRuntime({
      getDefaultAgentId: vi.fn(() => "codex"),
      getAvailableAgentIds: vi.fn(() => ["codex"]),
    });
    runtime.state.selectedAgentId = "missing";

    runtime.controller.syncSelectedAgentId();

    expect(runtime.state.selectedAgentId).toBe("codex");
  });

  it("normalizes parent paths for launcher directory navigation", () => {
    expect(getParentPath("/home/user/work")).toBe("/home/user");
    expect(getParentPath("/home")).toBe("/");
    expect(getParentPath("/")).toBe("/");
  });

  it("selects agents and picker state through controller actions", () => {
    const runtime = createRuntime();

    runtime.controller.openAgentPicker();
    runtime.controller.selectAgent("codex" satisfies AgentId);

    expect(runtime.state.selectedAgentId).toBe("codex");
    expect(runtime.state.agentPickerOpen).toBe(false);
  });
});
