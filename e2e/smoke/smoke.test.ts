import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Key } from "selenium-webdriver";
import { TEST_IDS } from "../../src/lib/testids";
import {
  startTauriSession,
  waitForAttributeValue,
  waitForTestId,
  type TauriSession,
} from "../helpers/tauri";
import { openMockWorkspaceSession } from "../helpers/launcher";
import { createStepLogger } from "../helpers/log";

describe.skipIf(process.platform !== "win32")("CLCOMX smoke", () => {
  let session: TauriSession;
  const log = createStepLogger("smoke");

  beforeAll(async () => {
    session = await startTauriSession();
  });

  afterAll(async () => {
    await session?.cleanup();
  });

  it("starts in isolated test mode, opens a mock session, and shows settings", async () => {
    const { driver, stateDir } = session;

    log.step("waiting for app root");
    await waitForTestId(driver, TEST_IDS.appRoot);
    log.step("waiting for launcher");
    await waitForTestId(driver, TEST_IDS.sessionLauncher);

    log.step("opening mock workspace session");
    await openMockWorkspaceSession(driver);

    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-pty-id",
      (value) => value !== null && value !== "-1",
    );
    log.step("mock pty ready");

    log.step("opening settings");
    await (await waitForTestId(driver, TEST_IDS.settingsButton)).click();
    await waitForTestId(driver, TEST_IDS.settingsModal);
    log.step("closing settings with escape");
    await driver.actions().sendKeys(Key.ESCAPE).perform();

    const workspacePath = path.join(stateDir, "workspace.json");
    const historyPath = path.join(stateDir, "tab_history.json");

    expect(fs.existsSync(workspacePath)).toBe(true);
    expect(fs.existsSync(historyPath)).toBe(true);
    log.step("state files created", { workspacePath, historyPath });
  });
});
