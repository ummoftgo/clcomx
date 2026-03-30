import { invoke } from "./tauri/core";

export async function loadCustomCss(): Promise<string> {
  try {
    return await invoke<string>("load_custom_css");
  } catch (error) {
    console.error("Failed to load custom.css override", error);
    return "";
  }
}
