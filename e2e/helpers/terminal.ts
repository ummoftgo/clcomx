import { Key, type WebDriver, type WebElement } from "selenium-webdriver";
import { TEST_IDS } from "../../src/lib/testids";
import { clickTestId, waitForTestId } from "./tauri";

export interface TerminalOutputSnapshot {
  data: string;
  seq: number;
}

export async function openDraft(driver: WebDriver) {
  await clickTestId(driver, TEST_IDS.draftToggle);
  return waitForTestId(driver, TEST_IDS.draftTextarea);
}

export async function setTextareaValue(driver: WebDriver, element: WebElement, value: string) {
  await driver.executeScript(
    `
      const el = arguments[0];
      const nextValue = String(arguments[1] ?? '');
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.focus();

      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
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
}

export async function sendDraftWithCtrlEnter(driver: WebDriver, element: WebElement) {
  await element.click();
  await driver.actions().keyDown(Key.CONTROL).sendKeys(Key.ENTER).keyUp(Key.CONTROL).perform();
}

export async function clickDraftInsert(driver: WebDriver) {
  await clickTestId(driver, TEST_IDS.draftInsertButton);
}

export async function clickDraftSend(driver: WebDriver) {
  await clickTestId(driver, TEST_IDS.draftSendButton);
}

export async function getTerminalOutputSnapshot(
  driver: WebDriver,
  sessionId: string,
): Promise<TerminalOutputSnapshot | null> {
  return driver.executeAsyncScript(
    `
      const sessionId = arguments[0];
      const done = arguments[arguments.length - 1];
      const hook = window.__clcomxTestHooks?.terminals?.[sessionId];
      if (!hook?.getOutputSnapshot) {
        done(null);
        return;
      }

      Promise.resolve(hook.getOutputSnapshot())
        .then((value) => done(value ?? null))
        .catch((error) => done({ __error: String(error) }));
    `,
    sessionId,
  ).then((result: TerminalOutputSnapshot | { __error: string } | null) => {
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(result.__error);
    }
    return result;
  });
}
