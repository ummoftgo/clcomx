import { Terminal } from "@xterm/xterm";
import type { Settings } from "./types";
import { buildFontStack, serializeFontFamilyList } from "./font-family";

const TAB_BAR_HEIGHT = 36;
const MIN_WINDOW_WIDTH = 640;
const MIN_WINDOW_HEIGHT = 480;
const DEFAULT_SCROLLBAR_WIDTH = 14;
const DEFAULT_CELL_WIDTH = 8;
const DEFAULT_CELL_HEIGHT = 17;

type TerminalCoreMetrics = {
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: {
            width?: number;
            height?: number;
          };
        };
      };
    };
    viewport?: {
      scrollBarWidth?: number;
    };
  };
};

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

export async function measureWindowSizeForTerminal(settings: Settings): Promise<{
  width: number;
  height: number;
}> {
  if (document.fonts?.ready) {
    await document.fonts.ready.catch(() => {});
  }

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-20000px";
  host.style.top = "0";
  host.style.width = "2000px";
  host.style.height = "2000px";
  host.style.visibility = "hidden";
  host.style.pointerEvents = "none";
  host.style.overflow = "hidden";
  document.body.appendChild(host);

  let terminal: Terminal | null = null;
  const terminalFontFamily = buildFontStack(
    serializeFontFamilyList(settings.terminal.fontFamily, "\"JetBrains Mono\", \"Cascadia Code\", Consolas"),
    serializeFontFamilyList(settings.terminal.fontFamilyFallback, "\"Malgun Gothic\", NanumGothicCoding, monospace"),
  );

  try {
    terminal = new Terminal({
      cols: settings.interface.windowDefaultCols,
      rows: settings.interface.windowDefaultRows,
      fontSize: settings.terminal.fontSize,
      fontFamily: terminalFontFamily,
      scrollback: 10000,
      allowProposedApi: true,
    });

    terminal.open(host);
    await nextFrame();

    const metrics = terminal as Terminal & TerminalCoreMetrics;
    const cellWidth = metrics._core?._renderService?.dimensions?.css?.cell?.width ?? DEFAULT_CELL_WIDTH;
    const cellHeight = metrics._core?._renderService?.dimensions?.css?.cell?.height ?? DEFAULT_CELL_HEIGHT;
    const scrollBarWidth = metrics._core?.viewport?.scrollBarWidth ?? DEFAULT_SCROLLBAR_WIDTH;

    const terminalWidth = Math.ceil(settings.interface.windowDefaultCols * cellWidth + scrollBarWidth);
    const terminalHeight = Math.ceil(settings.interface.windowDefaultRows * cellHeight);

    return {
      width: Math.max(MIN_WINDOW_WIDTH, terminalWidth),
      height: Math.max(MIN_WINDOW_HEIGHT, terminalHeight + TAB_BAR_HEIGHT),
    };
  } finally {
    terminal?.dispose();
    host.remove();
  }
}
