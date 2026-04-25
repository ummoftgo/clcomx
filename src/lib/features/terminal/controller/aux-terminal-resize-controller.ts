export interface AuxTerminalResizeControllerDeps {
  getAuxVisible: () => boolean;
  getDefaultHeightPercent: () => number;
  getShellHeight: () => number | null;
  getAssistPanelHeight: () => number;
  getHeightPercent: () => number;
  setHeightPercent: (value: number) => void;
  markHeightCustomized: () => void;
}

interface AuxTerminalResizeHeightParams {
  startY: number;
  currentY: number;
  startPercent: number;
  shellHeight: number;
  assistPanelHeight: number;
  defaultHeightPercent: number;
}

const AUX_HEIGHT_MIN_PERCENT = 18;
const AUX_HEIGHT_MAX_PERCENT = 70;
const AUX_HEIGHT_FALLBACK_PERCENT = 28;
const AUX_PANEL_VERTICAL_GAP_PX = 12;

export function clampAuxHeightPercent(value: number, defaultHeightPercent: number) {
  const fallback = Number.isFinite(defaultHeightPercent)
    ? defaultHeightPercent
    : AUX_HEIGHT_FALLBACK_PERCENT;
  const target = Number.isFinite(value) ? value : fallback;
  return Math.min(
    AUX_HEIGHT_MAX_PERCENT,
    Math.max(AUX_HEIGHT_MIN_PERCENT, Math.round(target)),
  );
}

export function calculateAuxResizeHeightPercent({
  startY,
  currentY,
  startPercent,
  shellHeight,
  assistPanelHeight,
  defaultHeightPercent,
}: AuxTerminalResizeHeightParams) {
  const delta = startY - currentY;
  const availableHeight = Math.max(
    shellHeight - assistPanelHeight - AUX_PANEL_VERTICAL_GAP_PX,
    1,
  );
  const percentDelta = (delta / availableHeight) * 100;
  return clampAuxHeightPercent(startPercent + percentDelta, defaultHeightPercent);
}

export function createAuxTerminalResizeController(deps: AuxTerminalResizeControllerDeps) {
  let resizingAux = false;
  let auxResizePointerId: number | null = null;
  let auxResizeStartY = 0;
  let auxResizeStartPercent = 0;

  function clampHeightPercent(value: number) {
    return clampAuxHeightPercent(value, deps.getDefaultHeightPercent());
  }

  function cancelResizeTracking() {
    resizingAux = false;
    auxResizePointerId = null;
  }

  function stopResize() {
    cancelResizeTracking();
    window.removeEventListener("pointermove", handleResizeMove, true);
    window.removeEventListener("pointerup", stopResize, true);
    window.removeEventListener("pointercancel", stopResize, true);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }

  function handleResizeMove(event: PointerEvent) {
    if (!resizingAux || auxResizePointerId !== event.pointerId) {
      return;
    }

    const shellHeight = deps.getShellHeight();
    if (shellHeight === null) {
      return;
    }

    event.preventDefault();
    deps.setHeightPercent(
      calculateAuxResizeHeightPercent({
        startY: auxResizeStartY,
        currentY: event.clientY,
        startPercent: auxResizeStartPercent,
        shellHeight,
        assistPanelHeight: deps.getAssistPanelHeight(),
        defaultHeightPercent: deps.getDefaultHeightPercent(),
      }),
    );
    deps.markHeightCustomized();
  }

  function handleResizeStart(event: PointerEvent) {
    if (event.button !== 0 || !deps.getAuxVisible()) {
      return;
    }

    event.preventDefault();
    resizingAux = true;
    auxResizePointerId = event.pointerId;
    auxResizeStartY = event.clientY;
    auxResizeStartPercent = deps.getHeightPercent();
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handleResizeMove, true);
    window.addEventListener("pointerup", stopResize, true);
    window.addEventListener("pointercancel", stopResize, true);
  }

  return {
    cancelResizeTracking,
    clampHeightPercent,
    handleResizeStart,
    stopResize,
  };
}
