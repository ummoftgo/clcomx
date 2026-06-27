import { describe, expect, it, vi } from "vitest";
import { bindLauncherSessionConfirm } from "./launcher-session-confirm";

describe("bindLauncherSessionConfirm", () => {
  it("direct runtimeKind를 title이 아닌 createSession의 runtimeKind 슬롯으로 전달한다", () => {
    const createSession = vi.fn();
    const confirm = bindLauncherSessionConfirm(createSession);

    confirm("codex", "Ubuntu-20.04", "/home/xenia/work/lc", "direct-codex");

    // title=undefined(기본값 사용), resumeToken=null, runtimeKind=direct-codex
    expect(createSession).toHaveBeenCalledWith(
      "codex",
      "Ubuntu-20.04",
      "/home/xenia/work/lc",
      undefined,
      null,
      "direct-codex",
    );
    // runtimeKind가 title 슬롯(4번째 인자)으로 새지 않았는지 명시 검증
    const [, , , titleArg] = createSession.mock.calls[0];
    expect(titleArg).toBeUndefined();
  });

  it("runtimeKind 미지정(pty 기본 경로)이면 runtimeKind를 undefined로 넘긴다", () => {
    const createSession = vi.fn();
    const confirm = bindLauncherSessionConfirm(createSession);

    confirm("claude", "Ubuntu-20.04", "/home/xenia/work/claudemx");

    expect(createSession).toHaveBeenCalledWith(
      "claude",
      "Ubuntu-20.04",
      "/home/xenia/work/claudemx",
      undefined,
      null,
      undefined,
    );
  });
});
