import fs from "node:fs";
import path from "node:path";
import { type WebDriver } from "selenium-webdriver";
import { TEST_IDS } from "../../src/lib/testids";
import { TEST_BRIDGE_EVENTS } from "../../src/lib/testing/test-bridge";
import { clickTestId, waitForAttributeValue, waitForTestId, waitForTestIdHidden } from "./tauri";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2pYQ0AAAAASUVORK5CYII=";

export function imageCacheDirForState(stateDir: string) {
  return path.join(stateDir, "temp", "image");
}

export function listCachedImages(stateDir: string) {
  const cacheDir = imageCacheDirForState(stateDir);
  if (!fs.existsSync(cacheDir)) {
    return [];
  }

  return fs
    .readdirSync(cacheDir)
    .filter((entry) => entry.toLowerCase().endsWith(".png"))
    .map((entry) => path.join(cacheDir, entry));
}

export async function injectPendingImage(
  driver: WebDriver,
  sessionId: string,
  base64 = ONE_BY_ONE_PNG_BASE64,
  mimeType = "image/png",
) {
  await waitForAttributeValue(
    driver,
    TEST_IDS.terminalShell,
    "data-test-hook-registered",
    (value) => value === "true",
    10_000,
  );

  const mode = await driver.executeScript(
    `
      const hooks = window.__clcomxTestHooks?.terminals ?? {};
      const hook = hooks[arguments[0]];
      if (hook?.openPendingImage) {
        hook.openPendingImage({
          base64: arguments[1],
          mimeType: arguments[2],
        });
        return 'hook';
      }

      window.dispatchEvent(new CustomEvent(arguments[3], {
        detail: {
          sessionId: arguments[0],
          base64: arguments[1],
          mimeType: arguments[2],
        },
      }));
      return 'event';
    `,
    sessionId,
    base64,
    mimeType,
    TEST_BRIDGE_EVENTS.openPendingImage,
  );

  await waitForAttributeValue(
    driver,
    TEST_IDS.terminalShell,
    "data-pending-image",
    (value) => value === "true",
    10_000,
  );

  await waitForTestId(driver, TEST_IDS.imagePasteModal);
  return mode;
}

export async function confirmPendingImage(driver: WebDriver) {
  await clickTestId(driver, TEST_IDS.imagePasteConfirm);
  await waitForTestIdHidden(driver, TEST_IDS.imagePasteModal, 10_000);
}
