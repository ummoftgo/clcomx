import { vi } from "vitest";

function createDefaultInvokeImplementation() {
  return async (command: string) => {
    switch (command) {
      case "list_monospace_fonts":
        return ["Pretendard", "Malgun Gothic", "JetBrains Mono"];
      case "list_available_editors":
        return [
          { id: "vscode", label: "VS Code" },
          { id: "cursor", label: "Cursor" },
          { id: "phpstorm", label: "PhpStorm" },
        ];
      case "resolve_terminal_path":
        return {
          raw: "src/App.svelte:12:3",
          wslPath: "/home/tester/workspace/src/App.svelte",
          copyText: "/home/tester/workspace/src/App.svelte:12:3",
          windowsPath: "\\\\wsl.localhost\\clcomx-test\\home\\tester\\workspace\\src\\App.svelte",
          line: 12,
          column: 3,
          isDirectory: false,
        };
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
