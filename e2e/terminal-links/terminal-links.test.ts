import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_IDS } from "../../src/lib/testids";
import { openMockWorkspaceSession } from "../helpers/launcher";
import { createStepLogger } from "../helpers/log";
import {
  openFileMenuForSession,
  openUrlMenuForSession,
  waitForContextMenuItem,
  waitForEditorPickerItem,
} from "../helpers/terminal";
import {
  startTauriSession,
  waitForAttributeValue,
  waitForTestId,
  type TauriSession,
} from "../helpers/tauri";

function toWslMountedPath(windowsPath: string) {
  const normalized = windowsPath.replace(/\\/g, "/");
  return normalized.replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`);
}

describe.skipIf(process.platform !== "win32")("CLCOMX terminal-links pack", () => {
  let session: TauriSession;
  const log = createStepLogger("terminal-links");

  beforeAll(async () => {
    session = await startTauriSession();
  });

  afterAll(async () => {
    await session?.cleanup();
  });

  it("opens URL and file context menus for terminal links", async () => {
    const { driver, stateDir } = session;

    log.step("waiting for app root");
    await waitForTestId(driver, TEST_IDS.appRoot);

    log.step("opening mock session");
    await openMockWorkspaceSession(driver);
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-pty-id",
      (value) => value !== null && value !== "-1",
      10_000,
    );

    const terminalShell = await waitForTestId(driver, TEST_IDS.terminalShell);
    const sessionId = await terminalShell.getAttribute("data-session-id");
    expect(sessionId).toBeTruthy();
    log.step("terminal ready", { sessionId });

    log.step("opening URL context menu");
    await openUrlMenuForSession(driver, sessionId!, "https://example.com/docs");
    expect(await (await waitForContextMenuItem(driver, "open-link-in-browser")).isDisplayed()).toBe(true);
    expect(await (await waitForContextMenuItem(driver, "copy-link")).isDisplayed()).toBe(true);
    log.step("url menu rendered");

    const realFilePath = path.join(stateDir, "sample-link.ts");
    fs.writeFileSync(realFilePath, "export const value = 42;\n", "utf8");
    const wslFilePath = `${toWslMountedPath(realFilePath)}:12:3`;

    log.step("opening file context menu", { wslFilePath });
    await openFileMenuForSession(driver, sessionId!, wslFilePath);
    expect(await (await waitForContextMenuItem(driver, "open-file")).isDisplayed()).toBe(true);
    expect(await (await waitForContextMenuItem(driver, "open-in-other-editor")).isDisplayed()).toBe(true);
    expect(await (await waitForContextMenuItem(driver, "copy-path")).isDisplayed()).toBe(true);
    log.step("file menu rendered");

    log.step("opening editor picker from file menu");
    await (await waitForContextMenuItem(driver, "open-in-other-editor")).click();
    await waitForTestId(driver, TEST_IDS.editorPickerModal);
    expect(await (await waitForEditorPickerItem(driver, "vscode")).isDisplayed()).toBe(true);
    log.step("editor picker rendered");
  });
});
