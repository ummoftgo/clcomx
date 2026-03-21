import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_IDS } from "../../src/lib/testids";
import {
  clickTestId,
  startTauriSession,
  waitForAttributeValue,
  waitForTestId,
  type TauriSession,
} from "../helpers/tauri";
import { openMockWorkspaceSession } from "../helpers/launcher";
import { createStepLogger } from "../helpers/log";
import { confirmPendingImage, injectPendingImage, listCachedImages } from "../helpers/image";
import { openSettings, openSettingsSection } from "../helpers/settings";

describe.skipIf(process.platform !== "win32")("CLCOMX image-paste pack", () => {
  let session: TauriSession;
  const log = createStepLogger("image-paste");

  beforeAll(async () => {
    session = await startTauriSession();
  });

  afterAll(async () => {
    await session?.cleanup();
  });

  it("opens the image preview, inserts a cached image path into draft, and clears the cache", async () => {
    const { driver, stateDir } = session;
    const cacheDir = path.join(stateDir, "temp", "image");

    log.step("waiting for app root");
    await waitForTestId(driver, TEST_IDS.appRoot);

    log.step("opening first mock session");
    await openMockWorkspaceSession(driver);
    log.step("waiting for mock pty");
    try {
      await waitForAttributeValue(
        driver,
        TEST_IDS.terminalShell,
        "data-pty-id",
        (value) => value !== null && value !== "-1",
        10_000,
      );
    } catch (error) {
      const appRoot = await waitForTestId(driver, TEST_IDS.appRoot).catch(() => null);
      const terminalShell = await waitForTestId(driver, TEST_IDS.terminalShell).catch(() => null);
      const sessionCount = await appRoot?.getAttribute("data-session-count").catch(() => "<unavailable>");
      const ptyId = await terminalShell?.getAttribute("data-pty-id").catch(() => "<unavailable>");
      log.error("mock pty timeout", { sessionCount, ptyId });
      throw error;
    }
    log.step("mock pty ready");

    const terminalShell = await waitForTestId(driver, TEST_IDS.terminalShell);
    const sessionId = await terminalShell.getAttribute("data-session-id");
    expect(sessionId).toBeTruthy();
    log.step("session ready", { sessionId, cacheDir });

    log.step("opening draft");
    await clickTestId(driver, TEST_IDS.draftToggle);
    const draftTextarea = await waitForTestId(driver, TEST_IDS.draftTextarea);

    log.step("injecting pending image");
    try {
      const injectionMode = await injectPendingImage(driver, sessionId!);
      log.step("image modal visible", { injectionMode });
    } catch (error) {
      const terminalShellAfterInject = await waitForTestId(driver, TEST_IDS.terminalShell).catch(() => null);
      const pendingImage = await terminalShellAfterInject?.getAttribute("data-pending-image").catch(() => "<unavailable>");
      const hookRegistered = await terminalShellAfterInject?.getAttribute("data-test-hook-registered").catch(() => "<unavailable>");
      log.error("image injection timeout", { pendingImage, hookRegistered, sessionId });
      throw error;
    }

    log.step("confirming image save");
    await confirmPendingImage(driver);

    await driver.wait(async () => {
      const value = await draftTextarea.getAttribute("value");
      return value?.includes("clcomx_") && value.includes(".png");
    }, 10_000);
    const draftValue = await draftTextarea.getAttribute("value");
    log.step("draft received image path", { draftValue });

    await driver.wait(() => listCachedImages(stateDir).length === 1, 10_000);
    const cachedImages = listCachedImages(stateDir);
    expect(cachedImages).toHaveLength(1);
    const cachedImagePath = cachedImages[0];
    const stats = fs.statSync(cachedImagePath);
    expect(stats.size).toBeGreaterThan(0);
    log.step("cache file created", { cachedImagePath, bytes: stats.size });

    log.step("opening settings storage section");
    await openSettings(driver);
    await openSettingsSection(driver, "storage", TEST_IDS.settingsStorageFiles);

    await driver.wait(async () => {
      const filesText = await (await waitForTestId(driver, TEST_IDS.settingsStorageFiles)).getText();
      return filesText === "1";
    }, 10_000);
    const sizeText = await (await waitForTestId(driver, TEST_IDS.settingsStorageSize)).getText();
    log.step("storage stats updated", { files: 1, sizeText });

    log.step("clearing image cache");
    await clickTestId(driver, TEST_IDS.settingsStorageClearCache);

    await driver.wait(() => listCachedImages(stateDir).length === 0, 10_000);
    await driver.wait(async () => {
      const filesText = await (await waitForTestId(driver, TEST_IDS.settingsStorageFiles)).getText();
      return filesText === "0";
    }, 10_000);
    log.step("cache cleared");
  });
});
