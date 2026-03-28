import { Key, type WebDriver, type WebElement } from "selenium-webdriver";
import { TEST_IDS, contextMenuItemTestId, editorPickerItemTestId } from "../../src/lib/testids";
import { clickTestId, waitForTestId } from "./tauri";

export interface TerminalOutputSnapshot {
  data: string;
  seq: number;
}

export interface TerminalViewportState {
  viewportY: number;
  baseY: number;
  rows: number;
  cols: number;
}

export interface TerminalBufferSnapshot extends TerminalViewportState {
  cursorX: number;
  cursorY: number;
  lines: string[];
}

export async function openUrlMenuForSession(driver: WebDriver, sessionId: string, url: string) {
  await driver.executeAsyncScript(
    `
      const [sessionId, url, done] = arguments;
      const hook = window.__clcomxTestHooks?.terminals?.[sessionId];
      if (!hook?.openUrlMenu) {
        done({ ok: false, error: 'Missing terminal openUrlMenu test hook' });
        return;
      }

      try {
        hook.openUrlMenu(url);
        done({ ok: true });
      } catch (error) {
        done({ ok: false, error: String(error) });
      }
    `,
    sessionId,
    url,
  ).then((result: { ok: boolean; error?: string }) => {
    if (!result?.ok) {
      throw new Error(result?.error ?? "Failed to open URL menu");
    }
  });
}

export async function openFileMenuForSession(driver: WebDriver, sessionId: string, rawPath: string) {
  await driver.executeAsyncScript(
    `
      const [sessionId, rawPath, done] = arguments;
      const hook = window.__clcomxTestHooks?.terminals?.[sessionId];
      if (!hook?.openFileMenu) {
        done({ ok: false, error: 'Missing terminal openFileMenu test hook' });
        return;
      }

      Promise.resolve(hook.openFileMenu(rawPath))
        .then(() => done({ ok: true }))
        .catch((error) => done({ ok: false, error: String(error) }));
    `,
    sessionId,
    rawPath,
  ).then((result: { ok: boolean; error?: string }) => {
    if (!result?.ok) {
      throw new Error(result?.error ?? "Failed to open file menu");
    }
  });
}

export async function waitForContextMenuItem(driver: WebDriver, itemId: string) {
  return waitForTestId(driver, contextMenuItemTestId(itemId));
}

export async function waitForEditorPickerItem(driver: WebDriver, editorId: string) {
  return waitForTestId(driver, editorPickerItemTestId(editorId));
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

export async function getAuxTerminalOutputSnapshot(
  driver: WebDriver,
  sessionId: string,
): Promise<TerminalOutputSnapshot | null> {
  return driver.executeAsyncScript(
    `
      const sessionId = arguments[0];
      const done = arguments[arguments.length - 1];
      const hook = window.__clcomxTestHooks?.terminals?.[sessionId];
      if (!hook?.getAuxOutputSnapshot) {
        done(null);
        return;
      }

      Promise.resolve(hook.getAuxOutputSnapshot())
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

export async function getTerminalViewportState(
  driver: WebDriver,
  sessionId: string,
): Promise<TerminalViewportState | null> {
  return driver.executeAsyncScript(
    `
      const sessionId = arguments[0];
      const done = arguments[arguments.length - 1];
      const hook = window.__clcomxTestHooks?.terminals?.[sessionId];
      if (!hook?.getViewportState) {
        done(null);
        return;
      }

      try {
        done(hook.getViewportState());
      } catch (error) {
        done({ __error: String(error) });
      }
    `,
    sessionId,
  ).then((result: TerminalViewportState | { __error: string } | null) => {
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(result.__error);
    }
    return result;
  });
}

export async function getTerminalBufferSnapshot(
  driver: WebDriver,
  sessionId: string,
): Promise<TerminalBufferSnapshot | null> {
  return driver.executeAsyncScript(
    `
      const sessionId = arguments[0];
      const done = arguments[arguments.length - 1];
      const hook = window.__clcomxTestHooks?.terminals?.[sessionId];
      if (!hook?.getBufferSnapshot) {
        done(null);
        return;
      }

      try {
        done(hook.getBufferSnapshot());
      } catch (error) {
        done({ __error: String(error) });
      }
    `,
    sessionId,
  ).then((result: TerminalBufferSnapshot | { __error: string } | null) => {
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(result.__error);
    }
    return result;
  });
}
