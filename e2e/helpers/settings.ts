import { Key, type WebDriver, type WebElement } from "selenium-webdriver";
import { TEST_IDS, settingsNavSectionTestId } from "../../src/lib/testids";
import { waitForTestId } from "./tauri";

export async function openSettings(driver: WebDriver) {
  await (await waitForTestId(driver, TEST_IDS.settingsButton)).click();
  await waitForTestId(driver, TEST_IDS.settingsModal);
}

export async function closeSettingsWithEscape(driver: WebDriver) {
  await driver.actions().sendKeys(Key.ESCAPE).perform();
}

export async function openSettingsSection(
  driver: WebDriver,
  sectionId: string,
  readyTestId?: string,
) {
  await (await waitForTestId(driver, settingsNavSectionTestId(sectionId))).click();
  if (readyTestId) {
    await waitForTestId(driver, readyTestId);
  }
}

export async function replaceInputValue(driver: WebDriver, element: WebElement, value: string) {
  await driver.executeScript(
    `
      const el = arguments[0];
      const nextValue = String(arguments[1] ?? '');
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.focus();

      const prototype = el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : Object.getPrototypeOf(el);

      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor?.set) {
        descriptor.set.call(el, nextValue);
      } else {
        el.value = nextValue;
      }

      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    `,
    element,
    value,
  );
  await driver.sleep(50);
}
