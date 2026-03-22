import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Key } from "selenium-webdriver";
import { TEST_IDS } from "../../src/lib/testids";
import { summarizeResumeToken } from "../../src/lib/agents";
import {
  startTauriSession,
  createE2eStateDir,
  waitForAttributeValue,
  waitForTestId,
  type TauriSession,
} from "../helpers/tauri";
import { openHistoryEntryByIndex, openMockWorkspaceSession } from "../helpers/launcher";
import { createStepLogger } from "../helpers/log";
import { getTerminalOutputSnapshot } from "../helpers/terminal";

describe.skipIf(process.platform !== "win32")("CLCOMX smoke", () => {
  let session: TauriSession;
  const log = createStepLogger("smoke");
  const TEST_DISTRO = process.env.CLCOMX_TEST_DISTRO ?? "clcomx-test";
  const TEST_HOME = process.env.CLCOMX_TEST_HOME ?? "/home/tester";

  beforeAll(async () => {
    session = await startTauriSession();
  });

  afterAll(async () => {
    await session?.cleanup();
  });

  it("starts in isolated test mode, opens a mock session, and shows settings", async () => {
    const { driver, stateDir } = session;

    log.step("waiting for app root");
    await waitForTestId(driver, TEST_IDS.appRoot);
    log.step("waiting for launcher");
    await waitForTestId(driver, TEST_IDS.sessionLauncher);

    log.step("opening mock workspace session");
    await openMockWorkspaceSession(driver);

    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-pty-id",
      (value) => value !== null && value !== "-1",
    );
    log.step("mock pty ready");

    log.step("opening settings");
    await (await waitForTestId(driver, TEST_IDS.settingsButton)).click();
    await waitForTestId(driver, TEST_IDS.settingsModal);
    log.step("closing settings with escape");
    await driver.actions().sendKeys(Key.ESCAPE).perform();

    const workspacePath = path.join(stateDir, "workspace.json");
    const historyPath = path.join(stateDir, "tab_history.json");

    expect(fs.existsSync(workspacePath)).toBe(true);
    expect(fs.existsSync(historyPath)).toBe(true);
    log.step("state files created", { workspacePath, historyPath });
  });

  it("supports agent selection for codex and renders recent history metadata", async () => {
    await session.cleanup();
    session = await startTauriSession();
    let { driver } = session;

    log.step("opening launcher for codex session");
    await (await waitForTestId(driver, TEST_IDS.newTabButton)).click();
    await waitForTestId(driver, TEST_IDS.sessionLauncher);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      distro: TEST_DISTRO,
      workDir: `${TEST_HOME}/projects`,
    });

    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-agent-id",
      (value) => value === "codex",
      10_000,
    );
    const sessionId = await (await waitForTestId(driver, TEST_IDS.terminalShell)).getAttribute("data-session-id");
    const codexOutput = await getTerminalOutputSnapshot(driver, sessionId!);
    expect(codexOutput?.data).toContain("Agent: Codex");
    log.step("codex session launched", { sessionId });

    await session.cleanup();
    const seededStateDir = createE2eStateDir("clcomx-e2e-history-");
    const historyPath = path.join(seededStateDir, "tab_history.json");
    fs.writeFileSync(
      historyPath,
      JSON.stringify(
        {
          items: [
            {
              agentId: "codex",
              distro: TEST_DISTRO,
              workDir: `${TEST_HOME}/projects`,
              title: "codex history",
              resumeToken: "019c9fe6-12fa-7272-a1b0-e541b71f608c",
              lastOpenedAt: new Date("2026-03-22T00:00:00.000Z").toISOString(),
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    session = await startTauriSession({ stateDir: seededStateDir });
    driver = session.driver;

    log.step("waiting for seeded history app root");
    await waitForTestId(driver, TEST_IDS.appRoot);
    log.step("waiting for seeded recent list");
    const recentList = await waitForTestId(driver, TEST_IDS.launcherRecentList);
    const recentText = await recentList.getText();
    const expectedSummary = summarizeResumeToken("019c9fe6-12fa-7272-a1b0-e541b71f608c");
    log.step("seeded recent list text", { recentText, expectedSummary });
    expect(recentText).toContain("Codex");
    expect(recentText).toContain(expectedSummary);
    log.step("recent history metadata rendered", { recentText });

    await openHistoryEntryByIndex(driver, 0);
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-agent-id",
      (value) => value === "codex",
      10_000,
    );
    log.step("history reopened codex session");
  });
});
