import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Key } from "selenium-webdriver";
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
import { getAuxTerminalOutputSnapshot } from "../helpers/terminal";

describe.skipIf(process.platform !== "win32")("CLCOMX terminal-aux pack", () => {
  let session: TauriSession;
  const log = createStepLogger("terminal-aux");

  beforeAll(async () => {
    session = await startTauriSession();
  });

  afterAll(async () => {
    await session?.cleanup();
  });

  it("opens a per-tab auxiliary shell, keeps it alive while hidden, and reuses it when reopened", async () => {
    const { driver } = session;

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
    log.step("main session ready", { sessionId });

    log.step("opening auxiliary terminal");
    await clickTestId(driver, TEST_IDS.auxTerminalToggle);
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-aux-visible",
      (value) => value === "true",
      10_000,
    );
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-aux-pty-id",
      (value) => value !== null && value !== "-1",
      10_000,
    );
    const firstAuxPtyId = await terminalShell.getAttribute("data-aux-pty-id");
    expect(firstAuxPtyId).toBeTruthy();
    log.step("auxiliary terminal running", { auxPtyId: firstAuxPtyId });

    await driver.wait(async () => {
      const snapshot = await getAuxTerminalOutputSnapshot(driver, sessionId!);
      return snapshot?.data.includes("Agent: Shell") && snapshot.data.includes("Mock session ready.");
    }, 10_000);
    log.step("auxiliary shell output ready");

    log.step("typing space into auxiliary shell");
    const auxShell = await waitForTestId(driver, TEST_IDS.auxTerminalShell);
    const beforeSpace = await getAuxTerminalOutputSnapshot(driver, sessionId!);
    await auxShell.click();
    await driver.actions().sendKeys(Key.SPACE).perform();
    await driver.wait(async () => {
      const visible = await terminalShell.getAttribute("data-aux-visible");
      const snapshot = await getAuxTerminalOutputSnapshot(driver, sessionId!);
      return (
        visible === "true"
        && !!snapshot
        && !!beforeSpace
        && snapshot.seq > beforeSpace.seq
        && snapshot.data.length > beforeSpace.data.length
      );
    }, 10_000);
    log.step("space stays in auxiliary shell without toggling");

    log.step("hiding auxiliary terminal");
    await clickTestId(driver, TEST_IDS.auxTerminalToggle);
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-aux-visible",
      (value) => value === "false",
      10_000,
    );
    expect(await terminalShell.getAttribute("data-aux-pty-id")).toBe(firstAuxPtyId);
    log.step("auxiliary terminal hidden but still alive");

    log.step("reopening auxiliary terminal");
    await clickTestId(driver, TEST_IDS.auxTerminalToggle);
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-aux-visible",
      (value) => value === "true",
      10_000,
    );
    expect(await terminalShell.getAttribute("data-aux-pty-id")).toBe(firstAuxPtyId);
    log.step("auxiliary terminal reopened with same shell");
  });
});
