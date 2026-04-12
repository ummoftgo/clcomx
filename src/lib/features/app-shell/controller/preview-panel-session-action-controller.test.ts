import { describe, expect, it, vi } from "vitest";
import { createPreviewPanelSessionActionController } from "./preview-panel-session-action-controller";

describe("preview-panel-session-action-controller", () => {
  it("opens tab rename for the active session only when one exists", () => {
    let activeSessionId: string | null = "session-1";
    const deps = {
      getActiveSessionId: vi.fn(() => activeSessionId),
      requestRenameTab: vi.fn(() => true),
      requestCloseTab: vi.fn(),
    };

    const controller = createPreviewPanelSessionActionController(deps);

    expect(controller.openRenameDialog()).toBe(true);
    expect(deps.requestRenameTab).toHaveBeenCalledWith("session-1");

    activeSessionId = null;
    expect(controller.openRenameDialog()).toBe(false);
    expect(deps.requestRenameTab).toHaveBeenCalledTimes(1);
  });

  it("opens tab close for the active session only when one exists", () => {
    let activeSessionId: string | null = "session-1";
    const deps = {
      getActiveSessionId: vi.fn(() => activeSessionId),
      requestRenameTab: vi.fn(() => true),
      requestCloseTab: vi.fn(),
    };

    const controller = createPreviewPanelSessionActionController(deps);

    expect(controller.openCloseDialog()).toBe(true);
    expect(deps.requestCloseTab).toHaveBeenCalledWith("session-1");

    activeSessionId = null;
    expect(controller.openCloseDialog()).toBe(false);
    expect(deps.requestCloseTab).toHaveBeenCalledTimes(1);
  });
});
