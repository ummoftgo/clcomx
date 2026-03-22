import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createE2eStateDir,
  getWindowHandleByLabel,
  startTauriSession,
  waitForAttributeValue,
  waitForTestId,
  waitForWindowCount,
  type TauriSession,
} from "../helpers/tauri";
import { TEST_IDS } from "../../src/lib/testids";
import { createStepLogger } from "../helpers/log";
import { getTerminalViewportState } from "../helpers/terminal";

describe.skipIf(process.platform !== "win32")("CLCOMX workspace-restore pack", () => {
  const TEST_DISTRO = process.env.CLCOMX_TEST_DISTRO ?? "clcomx-test";
  const stateDir = createE2eStateDir("clcomx-e2e-workspace-restore-");
  let session: TauriSession | null = null;
  const log = createStepLogger("workspace-restore");

  beforeAll(async () => {
    const workspacePath = path.join(stateDir, "workspace.json");
    fs.writeFileSync(
      workspacePath,
      JSON.stringify(
        {
          windows: [
            {
              label: "main",
              name: "main",
              role: "main",
              tabs: [
                {
                  sessionId: "main-session",
                  agentId: "claude",
                  distro: TEST_DISTRO,
                  workDir: "/home/tester/workspace",
                  title: "workspace",
                  pinned: false,
                  locked: false,
                  resumeToken: null,
                  ptyId: null,
                },
              ],
              activeSessionId: "main-session",
              x: 0,
              y: 0,
              width: 1024,
              height: 720,
              maximized: false,
            },
            {
              label: "window-1",
              name: "window-1",
              role: "secondary",
              tabs: [
                {
                  sessionId: "secondary-session",
                  agentId: "claude",
                  distro: TEST_DISTRO,
                  workDir: "/home/tester/projects",
                  title: "projects",
                  pinned: false,
                  locked: false,
                  resumeToken: null,
                  ptyId: null,
                },
              ],
              activeSessionId: "secondary-session",
              x: 80,
              y: 80,
              width: 900,
              height: 680,
              maximized: false,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    session = await startTauriSession({ stateDir });
  });

  afterAll(async () => {
    await session?.cleanup();
  });

  async function expectRestoredWindows(currentSession: TauriSession) {
    const { driver } = currentSession;
    log.step("waiting for windows");
    const handles = await waitForWindowCount(driver, 2, 15_000);
    expect(handles.length).toBeGreaterThanOrEqual(2);
    log.step("window handles", handles);

    log.step("switching to main");
    await getWindowHandleByLabel(driver, "main", 15_000);
    await waitForTestId(driver, TEST_IDS.appRoot);
    await waitForAttributeValue(
      driver,
      TEST_IDS.appRoot,
      "data-session-count",
      (value) => value === "1",
      10_000,
    );
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-pty-id",
      (value) => value !== null && value !== "-1",
      10_000,
    );
    log.step("main restored");

    log.step("switching to window-1");
    await getWindowHandleByLabel(driver, "window-1", 15_000);
    await waitForTestId(driver, TEST_IDS.appRoot);
    await waitForAttributeValue(
      driver,
      TEST_IDS.appRoot,
      "data-session-count",
      (value) => value === "1",
      10_000,
    );
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-pty-id",
      (value) => value !== null && value !== "-1",
      10_000,
    );
    log.step("secondary restored");
  }

  it("restores main and secondary windows from workspace.json and reattaches mock PTYs", async () => {
    await expectRestoredWindows(session!);

    const workspacePath = path.join(stateDir, "workspace.json");
    expect(fs.existsSync(workspacePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(workspacePath, "utf8"));
    expect(parsed.windows.map((window: { label: string }) => window.label)).toEqual(
      expect.arrayContaining(["main", "window-1"]),
    );

    log.step("restarting app with same state dir", { stateDir });
    await session?.cleanup();
    session = await startTauriSession({ stateDir });
    await expectRestoredWindows(session!);
  });

  it("keeps restored long-output sessions pinned to the bottom of scrollback", async () => {
    await session?.cleanup();
    session = null;

    const longStateDir = createE2eStateDir("clcomx-e2e-workspace-scroll-restore-");
    const workspacePath = path.join(longStateDir, "workspace.json");
    fs.writeFileSync(
      workspacePath,
      JSON.stringify(
        {
          windows: [
            {
              label: "main",
              name: "main",
              role: "main",
              tabs: [
                {
                  sessionId: "long-session",
                  agentId: "claude",
                  distro: TEST_DISTRO,
                  workDir: "/home/tester/workspace",
                  title: "long-session",
                  pinned: false,
                  locked: false,
                  resumeToken: "__clcomx_test_long_output_stream__",
                  ptyId: null,
                },
              ],
              activeSessionId: "long-session",
              x: 0,
              y: 0,
              width: 1024,
              height: 720,
              maximized: false,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    let longSession = await startTauriSession({ stateDir: longStateDir });
    try {
      const { driver } = longSession;
      log.step("waiting for long-output restore window");
      await waitForTestId(driver, TEST_IDS.appRoot);
      await waitForAttributeValue(
        driver,
        TEST_IDS.terminalShell,
        "data-pty-id",
        (value) => value !== null && value !== "-1",
        10_000,
      );

      const terminalShell = await waitForTestId(driver, TEST_IDS.terminalShell);
      const sessionId = await terminalShell.getAttribute("data-session-id");
      expect(sessionId).toBe("long-session");

      const immediateViewport = await getTerminalViewportState(driver, sessionId!);
      log.step("immediate viewport", immediateViewport);
      expect(immediateViewport).not.toBeNull();
      expect(immediateViewport?.viewportY).toBe(immediateViewport?.baseY);

      await driver.sleep(2400);

      const delayedViewport = await getTerminalViewportState(driver, sessionId!);
      log.step("delayed viewport", delayedViewport);
      expect(delayedViewport).not.toBeNull();
      expect(delayedViewport?.viewportY).toBe(delayedViewport?.baseY);
    } finally {
      await longSession.cleanup();
    }
  });
});
