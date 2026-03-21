import { Key, type WebDriver } from "selenium-webdriver";
import {
  TEST_IDS,
  launcherDirectoryTestId,
  launcherDistroTestId,
} from "../../src/lib/testids";
import {
  clickTestId,
  waitForAttributeValue,
  waitForTestId,
  waitForTestIdHidden,
} from "./tauri";
import { createStepLogger } from "./log";

const log = createStepLogger("launcher");

export async function openMockWorkspaceSession(driver: WebDriver) {
  log.step("waiting for session launcher");
  await waitForTestId(driver, TEST_IDS.sessionLauncher);
  log.step("clicking new session");
  await clickTestId(driver, TEST_IDS.launcherNewSession);
  log.step("selecting distro");
  await clickTestId(driver, launcherDistroTestId("clcomx-test"));

  log.step("selecting /home/tester");
  await clickTestId(driver, launcherDirectoryTestId("/home/tester"));
  await waitForAttributeValue(
    driver,
    TEST_IDS.launcherPathInput,
    "value",
    (value) => value === "/home/tester",
  );
  log.step("navigating into /home/tester");
  await (await waitForTestId(driver, TEST_IDS.launcherPathInput)).sendKeys(Key.ENTER);

  log.step("selecting /home/tester/workspace");
  await clickTestId(driver, launcherDirectoryTestId("/home/tester/workspace"));
  log.step("confirming session");
  await clickTestId(driver, TEST_IDS.launcherOpenHere);
  log.step("session confirm clicked");
  await waitForTestIdHidden(driver, TEST_IDS.sessionLauncher, 10_000);
  log.step("launcher hidden");
}
