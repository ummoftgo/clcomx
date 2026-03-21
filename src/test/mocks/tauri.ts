import { vi } from "vitest";

function createDefaultInvokeImplementation() {
  return async (command: string) => {
    switch (command) {
      case "list_monospace_fonts":
        return ["Pretendard", "Malgun Gothic", "JetBrains Mono"];
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
