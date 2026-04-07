import { describe, expect, it, vi } from "vitest";
import type { SessionCore } from "../../../types";
import {
  applySessionAuxState,
  clearSessionResumeFallback,
  registerSessionPty,
  type SessionRuntimeDependencies,
} from "./session-runtime";

function createDeps(overrides: Partial<SessionRuntimeDependencies> = {}): SessionRuntimeDependencies {
  return {
    setSessionPtyId: vi.fn(),
    persistSessionPty: vi.fn(async () => {}),
    recordTabHistory: vi.fn(),
    setSessionAuxState: vi.fn(),
    persistSessionAuxState: vi.fn(async () => {}),
    setSessionResumeToken: vi.fn(),
    persistSessionResumeToken: vi.fn(async () => {}),
    persistWorkspace: vi.fn(),
    reportError: vi.fn(),
    ...overrides,
  };
}

function createSession(): Pick<
  SessionCore,
  "agentId" | "resumeToken" | "title" | "distro" | "workDir"
> {
  return {
    agentId: "claude",
    resumeToken: "resume-1",
    title: "Demo",
    distro: "Ubuntu",
    workDir: "/workspace/demo",
  };
}

describe("session-runtime", () => {
  it("registers session PTY and records history", async () => {
    const deps = createDeps();

    await registerSessionPty(deps, "session-1", createSession(), 42);

    expect(deps.setSessionPtyId).toHaveBeenCalledWith("session-1", 42);
    expect(deps.persistSessionPty).toHaveBeenCalledWith("session-1", 42);
    expect(deps.recordTabHistory).toHaveBeenCalledWith(
      "claude",
      "Ubuntu",
      "/workspace/demo",
      "Demo",
      "resume-1",
    );
  });

  it("logs PTY persistence failures but still records history", async () => {
    const error = new Error("persist failed");
    const deps = createDeps({
      persistSessionPty: vi.fn(async () => {
        throw error;
      }),
    });

    await registerSessionPty(deps, "session-1", createSession(), 7);

    expect(deps.reportError).toHaveBeenCalledWith("Failed to register session PTY", error);
    expect(deps.recordTabHistory).toHaveBeenCalled();
  });

  it("applies and persists auxiliary terminal state", async () => {
    const deps = createDeps();

    await applySessionAuxState(deps, "session-1", {
      auxPtyId: -1,
      auxVisible: false,
      auxHeightPercent: 28,
    });

    expect(deps.setSessionAuxState).toHaveBeenCalledWith("session-1", -1, false, 28);
    expect(deps.persistSessionAuxState).toHaveBeenCalledWith("session-1", null, false, 28);
  });

  it("logs auxiliary terminal persistence failures after updating local state", async () => {
    const error = new Error("aux persist failed");
    const deps = createDeps({
      persistSessionAuxState: vi.fn(async () => {
        throw error;
      }),
    });

    await applySessionAuxState(deps, "session-1", {
      auxPtyId: 9,
      auxVisible: true,
      auxHeightPercent: 32,
    });

    expect(deps.setSessionAuxState).toHaveBeenCalledWith("session-1", 9, true, 32);
    expect(deps.reportError).toHaveBeenCalledWith(
      "Failed to persist auxiliary terminal state",
      error,
    );
  });

  it("clears invalid resume tokens and persists workspace afterwards", async () => {
    const deps = createDeps();

    await clearSessionResumeFallback(deps, "session-1");

    expect(deps.setSessionResumeToken).toHaveBeenCalledWith("session-1", null);
    expect(deps.persistSessionResumeToken).toHaveBeenCalledWith("session-1", null);
    expect(deps.persistWorkspace).toHaveBeenCalled();
  });

  it("logs resume-token persistence failures and still persists workspace", async () => {
    const error = new Error("resume persist failed");
    const deps = createDeps({
      persistSessionResumeToken: vi.fn(async () => {
        throw error;
      }),
    });

    await clearSessionResumeFallback(deps, "session-1");

    expect(deps.setSessionResumeToken).toHaveBeenCalledWith("session-1", null);
    expect(deps.reportError).toHaveBeenCalledWith(
      "Failed to clear invalid resume token",
      error,
    );
    expect(deps.persistWorkspace).toHaveBeenCalled();
  });
});
