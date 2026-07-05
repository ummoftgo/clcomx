import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../types";
import { invokeMock } from "../../test/mocks/tauri";
import {
  flushSettingsSave,
  getSettings,
  initializeSettings,
  normalizeSettings,
  updateSettings,
} from "./settings.svelte";

const EXAMPLE_DISTRO = "ExampleDistro";
const EXAMPLE_PATH = "/home/tester/work";

function flushTasks() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("settings store", () => {
  beforeEach(() => {
    initializeSettings(DEFAULT_SETTINGS);
  });

  it("normalizes missing nested settings with defaults", () => {
    const settings = normalizeSettings({
      interface: { uiScale: 135 },
      workspace: { defaultAgentId: "codex", defaultDistro: EXAMPLE_DISTRO },
      terminal: { fontSize: 16 },
    });

    expect(settings.interface.uiScale).toBe(135);
    expect(settings.interface.theme).toBe(DEFAULT_SETTINGS.interface.theme);
    expect(settings.workspace.defaultAgentId).toBe("codex");
    expect(settings.workspace.defaultDistro).toBe(EXAMPLE_DISTRO);
    expect(settings.terminal.fontSize).toBe(16);
    expect(settings.terminal.renderer).toBe(DEFAULT_SETTINGS.terminal.renderer);
    expect(settings.terminal.claudeFooterGhostingMitigation).toBe(
      DEFAULT_SETTINGS.terminal.claudeFooterGhostingMitigation,
    );
    expect(settings.terminal.claudeCliFlags.enableAutoMode).toBe(
      DEFAULT_SETTINGS.terminal.claudeCliFlags.enableAutoMode,
    );
    expect(settings.terminal.claudeTui).toBe(DEFAULT_SETTINGS.terminal.claudeTui);
    expect(settings.editor.fontFamily).toBe(DEFAULT_SETTINGS.terminal.fontFamily);
    expect(settings.editor.fontFamilyFallback).toBe(DEFAULT_SETTINGS.terminal.fontFamilyFallback);
    expect(settings.editor.fontSize).toBe(16);
    expect(settings.history.tabLimit).toBe(DEFAULT_SETTINGS.history.tabLimit);
  });

  it("persists nested setting updates through tauri invoke", async () => {
    updateSettings({
      workspace: {
        defaultAgentId: "codex",
        defaultDistro: EXAMPLE_DISTRO,
        defaultStartPathsByDistro: {
          [EXAMPLE_DISTRO]: EXAMPLE_PATH,
        },
      },
      interface: {
        uiScale: 125,
        windowDefaultCols: 132,
      },
      terminal: {
        renderer: "webgl",
        claudeFooterGhostingMitigation: false,
        claudeCliFlags: {
          enableAutoMode: false,
        },
        claudeTui: "fullscreen",
      },
      editor: {
        fontFamily: "Fira Code",
        fontFamilyFallback: "monospace",
        fontSize: 15,
      },
    });

    await flushTasks();

    expect(invokeMock).toHaveBeenCalledWith(
      "save_settings",
      expect.objectContaining({
        settings: expect.objectContaining({
          workspace: expect.objectContaining({
            defaultAgentId: "codex",
            defaultDistro: EXAMPLE_DISTRO,
            defaultStartPathsByDistro: expect.objectContaining({
              [EXAMPLE_DISTRO]: EXAMPLE_PATH,
            }),
          }),
          interface: expect.objectContaining({
            uiScale: 125,
            windowDefaultCols: 132,
          }),
          terminal: expect.objectContaining({
            renderer: "webgl",
            claudeFooterGhostingMitigation: false,
            claudeCliFlags: expect.objectContaining({
              enableAutoMode: false,
            }),
            claudeTui: "fullscreen",
          }),
          editor: expect.objectContaining({
            fontFamily: "Fira Code",
            fontFamilyFallback: "monospace",
            fontSize: 15,
          }),
        }),
      }),
    );

    expect(getSettings().interface.uiScale).toBe(125);
    expect(getSettings().interface.windowDefaultCols).toBe(132);
    expect(getSettings().terminal.renderer).toBe("webgl");
    expect(getSettings().terminal.claudeFooterGhostingMitigation).toBe(false);
    expect(getSettings().terminal.claudeCliFlags.enableAutoMode).toBe(false);
    expect(getSettings().terminal.claudeTui).toBe("fullscreen");
    expect(getSettings().editor.fontFamily).toBe("Fira Code");
    expect(getSettings().editor.fontFamilyFallback).toBe("monospace");
    expect(getSettings().editor.fontSize).toBe(15);
    expect(getSettings().workspace.defaultAgentId).toBe("codex");
    expect(getSettings().workspace.defaultDistro).toBe(EXAMPLE_DISTRO);
  });

  it("keeps editor settings independent after initialization", () => {
    initializeSettings({
      terminal: {
        fontFamily: "JetBrains Mono",
        fontFamilyFallback: "monospace",
        fontSize: 15,
      },
    });

    updateSettings({
      editor: {
        fontFamily: "Fira Code",
        fontSize: 17,
      },
    });

    updateSettings({
      terminal: {
        fontFamily: "Cascadia Code",
        fontSize: 13,
      },
    });

    expect(getSettings().editor.fontFamily).toBe("Fira Code");
    expect(getSettings().editor.fontFamilyFallback).toBe("monospace");
    expect(getSettings().editor.fontSize).toBe(17);
  });

  it("agentRuntime: 기본값은 전부 상속(null)이고 구독 인증은 꺼져 있다(FE-25 후속)", () => {
    const settings = normalizeSettings(null);

    expect(settings.agentRuntime).toEqual({
      fontSize: null,
      fontFamily: null,
      codeFontFamily: null,
      claudeAllowSubscriptionAuth: false,
    });
  });

  it("agentRuntime: 빈 문자열/공백/비유한 숫자는 null(상속)로 접는다", () => {
    const settings = normalizeSettings({
      agentRuntime: {
        fontSize: Number.NaN,
        fontFamily: "   ",
        codeFontFamily: "",
        claudeAllowSubscriptionAuth: true,
      },
    });

    expect(settings.agentRuntime.fontSize).toBeNull();
    expect(settings.agentRuntime.fontFamily).toBeNull();
    expect(settings.agentRuntime.codeFontFamily).toBeNull();
    expect(settings.agentRuntime.claudeAllowSubscriptionAuth).toBe(true);
  });

  it("agentRuntime: 지정 값은 정규화를 거쳐도 보존되고 updateSettings로 갱신된다", () => {
    const settings = normalizeSettings({
      agentRuntime: {
        fontSize: 16,
        fontFamily: "Pretendard",
        codeFontFamily: "JetBrains Mono",
        claudeAllowSubscriptionAuth: true,
      },
    });

    expect(settings.agentRuntime).toEqual({
      fontSize: 16,
      fontFamily: "Pretendard",
      codeFontFamily: "JetBrains Mono",
      claudeAllowSubscriptionAuth: true,
    });

    updateSettings({ agentRuntime: { fontSize: 18, claudeAllowSubscriptionAuth: true } });
    expect(getSettings().agentRuntime.fontSize).toBe(18);
    expect(getSettings().agentRuntime.claudeAllowSubscriptionAuth).toBe(true);

    // null 재지정(상속 복귀)도 반영된다.
    updateSettings({ agentRuntime: { fontSize: null } });
    expect(getSettings().agentRuntime.fontSize).toBeNull();
  });

  it("agentRuntime: flushSettingsSave가 구독 인증 토글 저장이 디스크에 반영된 뒤 resolve된다", async () => {
    invokeMock.mockClear();

    // 토글 직후 launch 레이스 방어: flush가 끝나면 save_settings가 최신 값(true)으로 호출돼 있어야 한다.
    updateSettings({ agentRuntime: { claudeAllowSubscriptionAuth: true } });
    await flushSettingsSave();

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "save_settings");
    expect(saveCalls.length).toBeGreaterThan(0);
    const lastSnapshot = saveCalls[saveCalls.length - 1]?.[1] as {
      settings: { agentRuntime: { claudeAllowSubscriptionAuth: boolean } };
    };
    expect(lastSnapshot.settings.agentRuntime.claudeAllowSubscriptionAuth).toBe(true);

    // revoke도 동일하게 flush 후 디스크 스냅샷이 false다.
    updateSettings({ agentRuntime: { claudeAllowSubscriptionAuth: false } });
    await flushSettingsSave();
    const revokeCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "save_settings");
    const revokeSnapshot = revokeCalls[revokeCalls.length - 1]?.[1] as {
      settings: { agentRuntime: { claudeAllowSubscriptionAuth: boolean } };
    };
    expect(revokeSnapshot.settings.agentRuntime.claudeAllowSubscriptionAuth).toBe(false);
  });

  it("agentRuntime: 저장 실패 시 flushSettingsSave가 reject된다(revoke 미반영 상태로 launch 진행 방지)", async () => {
    invokeMock.mockClear();
    invokeMock.mockRejectedValueOnce(new Error("disk full"));

    // revoke 저장이 실패하면 디스크(backend 권위)에는 stale opt-in이 남을 수 있다 —
    // flush 호출자(Claude launch 판정)는 이 reject로 진행을 중단해야 한다.
    updateSettings({ agentRuntime: { claudeAllowSubscriptionAuth: false } });
    await expect(flushSettingsSave()).rejects.toThrow("disk full");

    // 다음 저장이 성공하면 flush도 다시 resolve된다(복구).
    updateSettings({ agentRuntime: { claudeAllowSubscriptionAuth: false } });
    await expect(flushSettingsSave()).resolves.toBeUndefined();
  });
});
