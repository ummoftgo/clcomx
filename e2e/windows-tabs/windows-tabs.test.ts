import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { By } from "selenium-webdriver";
import { TEST_IDS } from "../../src/lib/testids";
import {
  startTauriSession,
  waitForAttributeValue,
  waitForTestId,
  waitForTestIdHidden,
  type TauriSession,
} from "../helpers/tauri";
import { openMockWorkspaceSession } from "../helpers/launcher";
import { getTabIds, openTabMenu, selectContextMenuItem, waitForContextMenuItem } from "../helpers/tabs";
import { createStepLogger } from "../helpers/log";

describe.skipIf(process.platform !== "win32")("CLCOMX windows-tabs pack", () => {
  let session: TauriSession;
  const log = createStepLogger("windows-tabs");

  beforeAll(async () => {
    session = await startTauriSession();
  });

  afterAll(async () => {
    await session?.cleanup();
  });

  it("opens multiple tabs and exposes tab actions including close confirmation for live tabs", async () => {
    const { driver } = session;

    log.step("waiting for app root");
    await waitForTestId(driver, TEST_IDS.appRoot);
    log.step("opening first mock session");
    await openMockWorkspaceSession(driver);

    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-pty-id",
      (value) => value !== null && value !== "-1",
    );
    log.step("first session ready");

    log.step("opening launcher for second session");
    await (await waitForTestId(driver, TEST_IDS.newTabButton)).click();
    await waitForTestId(driver, TEST_IDS.sessionLauncher);
    log.step("opening second mock session");
    await openMockWorkspaceSession(driver);
    log.step("second mock session flow completed");
    try {
      await waitForAttributeValue(
        driver,
        TEST_IDS.appRoot,
        "data-session-count",
        (value) => value !== null && Number(value) >= 2,
        10_000,
      );
    } catch (error) {
      const appRoot = await waitForTestId(driver, TEST_IDS.appRoot);
      const sessionCount = await appRoot.getAttribute("data-session-count").catch(() => "<unavailable>");
      const tabIds = await getTabIds(driver).catch(() => []);
      log.error("session count timeout", { sessionCount, tabIds });
      throw error;
    }
    log.step("session count is at least 2");

    await driver.wait(async () => (await getTabIds(driver)).length >= 2, 10_000);
    const tabIds = await getTabIds(driver);
    log.step("tab ids", tabIds);
    expect(tabIds.length).toBeGreaterThanOrEqual(2);

    log.step("opening tab menu");
    await openTabMenu(driver, tabIds[0]);
    const menuItem = await waitForContextMenuItem(driver, "move-right");
    expect(await menuItem.isDisplayed()).toBe(true);
    log.step("move right item visible");

    await selectContextMenuItem(driver, "close-tab");
    log.step("close item clicked");

    const closeDialog = await waitForTestId(driver, TEST_IDS.closeTabDialog);
    expect(await closeDialog.isDisplayed()).toBe(true);
    log.step("close dialog visible");

    const cancelButton = await closeDialog.findElement(By.xpath(".//button[contains(., 'Cancel') or contains(., '취소')]"));
    await driver.executeScript(
      `
        const el = arguments[0];
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
      `,
      cancelButton,
    );
    log.step("close dialog cancel clicked");
    await waitForTestIdHidden(driver, TEST_IDS.closeTabDialog, 5_000);
    log.step("close dialog hidden");
  });
});
