import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { By } from "selenium-webdriver";
import { TEST_IDS } from "../../src/lib/testids";
import { startTauriSession, waitForTestId, waitForTestIdHidden, type TauriSession } from "../helpers/tauri";
import {
  closeSettingsWithEscape,
  openSettings,
  openSettingsSection,
  replaceInputValue,
} from "../helpers/settings";
import { createStepLogger } from "../helpers/log";

describe.skipIf(process.platform !== "win32")("CLCOMX settings pack", () => {
  let session: TauriSession;
  const log = createStepLogger("settings");

  beforeAll(async () => {
    session = await startTauriSession();
  });

  afterAll(async () => {
    await session?.cleanup();
  });

  it("opens settings, navigates sections, and persists interface/history changes", async () => {
    const { driver, stateDir } = session;
    const settingsPath = path.join(stateDir, "setting.json");

    log.step("waiting for app root");
    await waitForTestId(driver, TEST_IDS.appRoot);
    log.step("opening settings");
    await openSettings(driver);
    await waitForTestId(driver, TEST_IDS.settingsNav);
    let body = await waitForTestId(driver, TEST_IDS.settingsBody);
    await waitForTestId(driver, TEST_IDS.settingsInterfaceUiScaleInput);
    log.step("interface section ready");

    const scaleInput = await body.findElement(By.css(`[data-testid="${TEST_IDS.settingsInterfaceUiScaleInput}"]`));
    await replaceInputValue(driver, scaleInput, "115");
    log.step("ui scale set", { value: 115 });

    log.step("opening history section");
    await openSettingsSection(driver, "history", TEST_IDS.settingsHistoryTabLimitInput);
    body = await waitForTestId(driver, TEST_IDS.settingsBody);
    const historyLimitInput = await body.findElement(By.css(`[data-testid="${TEST_IDS.settingsHistoryTabLimitInput}"]`));
    await replaceInputValue(driver, historyLimitInput, "7");
    log.step("history limit set", { value: 7 });

    try {
      await driver.wait(async () => {
        if (!fs.existsSync(settingsPath)) return false;
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        return parsed.interface?.uiScale === 115 && parsed.history?.tabLimit === 7;
      }, 10_000);
      log.step("settings persisted", { settingsPath });
    } catch (error) {
      const activeSectionId = await body.getAttribute("data-section-id").catch(() => "<unavailable>");
      const scaleValue = await scaleInput.getAttribute("value").catch(() => "<unavailable>");
      const historyValue = await historyLimitInput.getAttribute("value").catch(() => "<unavailable>");
      const fileContents = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "<missing>";
      log.error("persistence timeout", {
        activeSectionId,
        scaleValue,
        historyValue,
        settingsPath,
        fileContents,
      });
      throw error;
    }

    await closeSettingsWithEscape(driver);
    log.step("closed settings");
    await waitForTestIdHidden(driver, TEST_IDS.settingsModal, 5_000);
  });
});
