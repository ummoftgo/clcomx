import { vi } from "vitest";

function normalizeMockHomeDir(homeDir: unknown) {
  if (typeof homeDir !== "string") {
    return "/home/tester";
  }

  const trimmed = homeDir.trim();
  return trimmed || "/home/tester";
}

function buildMockWindowsPath(wslPath: string) {
  return `\\\\wsl.localhost\\clcomx-test${wslPath.replace(/\//g, "\\")}`;
}

function createDefaultInvokeImplementation() {
  return async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "list_monospace_fonts":
        return ["Pretendard", "Malgun Gothic", "JetBrains Mono"];
      case "list_available_editors":
        return [
          { id: "vscode", label: "VS Code" },
          { id: "cursor", label: "Cursor" },
          { id: "phpstorm", label: "PhpStorm" },
        ];
      case "resolve_terminal_path": {
        const raw = String(args?.raw ?? "src/App.svelte:12:3");
        const homeDir = normalizeMockHomeDir(args?.homeDir);

        if (raw === "~" || raw.startsWith("~/")) {
          const wslPath = raw === "~" ? homeDir : `${homeDir}${raw.slice(1)}`;
          return {
            kind: "resolved",
            path: {
              raw,
              wslPath,
              copyText: wslPath,
              windowsPath: buildMockWindowsPath(wslPath),
              line: null,
              column: null,
              isDirectory: raw === "~" || raw.endsWith("/"),
            },
          };
        }

        if (raw === "index.ts") {
          return {
            kind: "candidates",
            raw: "index.ts",
            candidates: [
              {
                raw: "index.ts",
                wslPath: `${homeDir}/workspace/src/front/index.ts`,
                copyText: `${homeDir}/workspace/src/front/index.ts:12:3`,
                windowsPath: buildMockWindowsPath(`${homeDir}/workspace/src/front/index.ts`),
                line: 12,
                column: 3,
                isDirectory: false,
              },
              {
                raw: "index.ts",
                wslPath: `${homeDir}/workspace/src/shared/index.ts`,
                copyText: `${homeDir}/workspace/src/shared/index.ts:8:1`,
                windowsPath: buildMockWindowsPath(`${homeDir}/workspace/src/shared/index.ts`),
                line: 8,
                column: 1,
                isDirectory: false,
              },
            ],
          };
        }

        return {
          kind: "resolved",
          path: {
            raw,
            wslPath: `${homeDir}/workspace/src/App.svelte`,
            copyText: `${homeDir}/workspace/src/App.svelte:12:3`,
            windowsPath: buildMockWindowsPath(`${homeDir}/workspace/src/App.svelte`),
            line: 12,
            column: 3,
            isDirectory: false,
          },
        };
      }
      case "open_in_editor":
        return undefined;
      case "get_image_cache_stats":
        return { path: "/tmp/image", files: 0, bytes: 0 };
      case "open_image_cache_folder":
        return "/tmp/image";
      case "clear_image_cache":
        return 0;
      case "save_settings":
      case "save_workspace":
        return undefined;
      default:
        return undefined;
    }
  };
}

export const invokeMock = vi.fn(createDefaultInvokeImplementation());

export function resetTauriMocks() {
  invokeMock.mockReset();
  invokeMock.mockImplementation(createDefaultInvokeImplementation());
}
