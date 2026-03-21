import { By, type WebDriver, type WebElement } from "selenium-webdriver";
import {
  TEST_IDS,
  contextMenuItemTestId,
  tabMenuButtonTestId,
  tabTestId,
} from "../../src/lib/testids";
import { clickTestId, waitForTestId, waitForTestIdHidden } from "./tauri";

async function waitForVisibleContextMenu(driver: WebDriver, timeoutMs = 5_000): Promise<WebElement> {
  try {
    return await waitForTestId(driver, TEST_IDS.contextMenu, Math.min(timeoutMs, 1_500));
  } catch {
    let visibleMenu: WebElement | null = null;
    await driver.wait(async () => {
      const menus = await driver.findElements(By.css('[role="menu"]'));
      for (const menu of menus) {
        try {
          if (await menu.isDisplayed()) {
            visibleMenu = menu;
            return true;
          }
        } catch {
          // Ignore stale nodes while polling.
        }
      }
      return false;
    }, timeoutMs);

    if (!visibleMenu) {
      throw new Error("Timed out waiting for visible context menu");
    }

    return visibleMenu;
  }
}

async function waitForContextMenuHidden(driver: WebDriver, timeoutMs = 5_000): Promise<void> {
  try {
    await waitForTestIdHidden(driver, TEST_IDS.contextMenu, 1_000);
    return;
  } catch {
    await driver.wait(async () => {
      const menus = await driver.findElements(By.css('[role="menu"]'));
      if (menus.length === 0) return true;

      for (const menu of menus) {
        try {
          if (await menu.isDisplayed()) {
            return false;
          }
        } catch {
          // Ignore stale nodes while polling.
        }
      }
      return true;
    }, timeoutMs);
  }
}

function menuItemTextPattern(itemId: string): RegExp {
  switch (itemId) {
    case "move-right":
      return /(Move Right|오른쪽으로 이동)/i;
    case "move-left":
      return /(Move Left|왼쪽으로 이동)/i;
    case "close-tab":
      return /(Close tab|탭 닫기)/i;
    case "move-new-window":
      return /(Move To New Window|새 창으로 이동)/i;
    default:
      return new RegExp(itemId, "i");
  }
}

export async function openTabMenu(driver: WebDriver, sessionId: string) {
  try {
    await clickTestId(driver, tabMenuButtonTestId(sessionId));
    await waitForVisibleContextMenu(driver, 2_000);
    return;
  } catch {
    const tab = await waitForTestId(driver, tabTestId(sessionId));
    await driver.executeScript(
      `
        const el = arguments[0];
        const rect = el.getBoundingClientRect();
        const clientX = Math.round(rect.left + Math.min(24, rect.width / 2));
        const clientY = Math.round(rect.top + rect.height / 2);
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 2,
          buttons: 2,
        }));
      `,
      tab,
    );
    await waitForVisibleContextMenu(driver, 5_000);
  }
}

export async function getTabIds(driver: WebDriver) {
  const tabBar = await waitForTestId(driver, TEST_IDS.tabBar);
  const tabNodes = await tabBar.findElements(By.css('[data-testid^="tab-"]'));
  const ids: string[] = [];

  for (const node of tabNodes) {
    const testId = await node.getAttribute("data-testid");
    if (!testId) continue;
    if (testId.startsWith("tab-menu-") || testId.startsWith("tab-close-")) continue;
    ids.push(testId.replace(/^tab-/, ""));
  }

  return ids;
}

export async function waitForTab(driver: WebDriver, sessionId: string) {
  return waitForTestId(driver, tabTestId(sessionId));
}

export async function waitForContextMenuItem(driver: WebDriver, itemId: string) {
  try {
    return await waitForTestId(driver, contextMenuItemTestId(itemId), 1_500);
  } catch {
    const menu = await waitForVisibleContextMenu(driver, 5_000);
    const buttons = await menu.findElements(By.css("button"));
    const pattern = menuItemTextPattern(itemId);

    for (const button of buttons) {
      const text = await button.getText().catch(() => "");
      if (pattern.test(text)) {
        return button;
      }
    }

    throw new Error(`Unable to find context menu item: ${itemId}`);
  }
}

export async function selectContextMenuItem(driver: WebDriver, itemId: string) {
  const item = await waitForContextMenuItem(driver, itemId);
  await driver.executeScript(
    `
      const el = arguments[0];
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    `,
    item,
  );
  await waitForContextMenuHidden(driver, 5_000);
}
