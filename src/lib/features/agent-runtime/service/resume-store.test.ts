import { describe, expect, it, vi } from "vitest";
vi.mock("../../../tauri/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
import { invoke } from "../../../tauri/core";
import { saveResumeKeys, loadResumeKeys, clearResumeKeys } from "./resume-store";

describe("resume-store 래퍼", () => {
  it("커맨드 이름/인자를 그대로 넘긴다", async () => {
    await saveResumeKeys("H", { providerThreadId: "t", canResume: true, canLoad: false });
    expect(invoke).toHaveBeenCalledWith("agent_runtime_save_resume_keys", {
      sessionHandle: "H",
      keys: { providerThreadId: "t", canResume: true, canLoad: false },
    });
    await loadResumeKeys("H");
    expect(invoke).toHaveBeenCalledWith("agent_runtime_load_resume_keys", { sessionHandle: "H" });
    await clearResumeKeys("H");
    expect(invoke).toHaveBeenCalledWith("agent_runtime_clear_resume_keys", { sessionHandle: "H" });
  });
});
