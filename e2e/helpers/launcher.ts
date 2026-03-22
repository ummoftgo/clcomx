import { Key, type WebDriver } from "selenium-webdriver";
import {
  TEST_IDS,
  launcherAgentTestId,
  launcherHistoryItemTestId,
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
const TEST_DISTRO = process.env.CLCOMX_TEST_DISTRO ?? "clcomx-test";
const TEST_HOME = process.env.CLCOMX_TEST_HOME ?? "/home/tester";

export interface OpenMockWorkspaceSessionOptions {
  agentId?: string;
  distro?: string;
  workDir?: string;
}

async function setInputValue(driver: WebDriver, testId: string, value: string) {
  const element = await waitForTestId(driver, testId);
  await driver.executeScript(
    `
      const el = arguments[0];
      const nextValue = String(arguments[1] ?? '');
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.focus();

      const prototype = el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor?.set) {
        descriptor.set.call(el, nextValue);
      } else {
        el.value = nextValue;
      }

      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    `,
    element,
    value,
  );
  return element;
}

export async function openHistoryEntryByIndex(driver: WebDriver, index: number) {
  log.step("opening history entry", { index });
  await clickTestId(driver, launcherHistoryItemTestId(index));
}

export async function openMockWorkspaceSession(
  driver: WebDriver,
  options: OpenMockWorkspaceSessionOptions = {},
) {
  const agentId = options.agentId ?? "claude";
  const distro = options.distro ?? TEST_DISTRO;
  const workDir = options.workDir ?? `${TEST_HOME}/workspace`;

  log.step("waiting for session launcher");
  await waitForTestId(driver, TEST_IDS.sessionLauncher);
  log.step("clicking new session");
  await clickTestId(driver, TEST_IDS.launcherNewSession);
  await waitForTestId(driver, TEST_IDS.launcherPathInput);

  log.step("opening agent picker", { agentId });
  await clickTestId(driver, TEST_IDS.launcherAgentTrigger);
  await waitForTestId(driver, TEST_IDS.launcherAgentPicker);
  await clickTestId(driver, launcherAgentTestId(agentId));
  await waitForTestIdHidden(driver, TEST_IDS.launcherAgentPicker, 5_000);

  log.step("opening distro picker", { distro });
  await clickTestId(driver, TEST_IDS.launcherDistroTrigger);
  await waitForTestId(driver, TEST_IDS.launcherDistroPicker);
  await clickTestId(driver, launcherDistroTestId(distro));
  await waitForTestIdHidden(driver, TEST_IDS.launcherDistroPicker, 5_000);

  log.step("navigating to workDir", { workDir });
  const pathInput = await setInputValue(driver, TEST_IDS.launcherPathInput, workDir);
  await pathInput.sendKeys(Key.ENTER);
  await waitForAttributeValue(
    driver,
    TEST_IDS.launcherPathInput,
    "value",
    (value) => value === workDir,
    10_000,
  );

  log.step("confirming session");
  await clickTestId(driver, TEST_IDS.launcherOpenHere);
  log.step("session confirm clicked");
  await waitForTestIdHidden(driver, TEST_IDS.sessionLauncher, 10_000);
  log.step("launcher hidden");
}
