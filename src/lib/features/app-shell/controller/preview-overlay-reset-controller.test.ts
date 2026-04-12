import { describe, expect, it, vi } from "vitest";
import { createPreviewOverlayResetController } from "./preview-overlay-reset-controller";

describe("preview-overlay-reset-controller", () => {
  it("resets preview overlays through the injected app-shell actions", () => {
    const deps = {
      hideSessionLauncher: vi.fn(),
      closeSettingsPanel: vi.fn(),
      closeWindowDialog: vi.fn(),
      dismissCloseTabDialog: vi.fn(),
      dismissRenameDialog: vi.fn(),
    };

    const controller = createPreviewOverlayResetController(deps);
    controller.resetOverlays();

    expect(deps.hideSessionLauncher).toHaveBeenCalledTimes(1);
    expect(deps.closeSettingsPanel).toHaveBeenCalledTimes(1);
    expect(deps.closeWindowDialog).toHaveBeenCalledTimes(1);
    expect(deps.dismissCloseTabDialog).toHaveBeenCalledTimes(1);
    expect(deps.dismissRenameDialog).toHaveBeenCalledTimes(1);
  });
});
