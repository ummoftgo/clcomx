import { describe, expect, it } from "vitest";
import { resolveSessionShellLoader } from "./session-shell-loader";

describe("session-shell-loader", () => {
  it("resolves the standard session shell loader for normal mode", () => {
    const loader = resolveSessionShellLoader(false);

    expect(loader).toBe(resolveSessionShellLoader(false));
  });

  it("resolves a different loader for preview mode", () => {
    const previewLoader = resolveSessionShellLoader(true);
    const standardLoader = resolveSessionShellLoader(false);

    expect(previewLoader).not.toBe(standardLoader);
  });
});
