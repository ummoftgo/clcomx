import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_IDS } from "../../src/lib/testids";
import {
  startTauriSession,
  waitForAttributeValue,
  waitForTestId,
  waitForTestIdHidden,
  type TauriSession,
} from "../helpers/tauri";
import { openMockWorkspaceSession } from "../helpers/launcher";
import { createStepLogger } from "../helpers/log";
import {
  clickDraftInsert,
  clickDraftSend,
  getTerminalOutputSnapshot,
  openDraft,
  sendDraftWithCtrlEnter,
  setTextareaValue,
} from "../helpers/terminal";

describe.skipIf(process.platform !== "win32")("CLCOMX terminal-input pack", () => {
  let session: TauriSession;
  const log = createStepLogger("terminal-input");

  beforeAll(async () => {
    session = await startTauriSession();
  });

  afterAll(async () => {
    await session?.cleanup();
  });

  it("supports draft multiline send, insert without submit, and mock output verification", async () => {
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
    log.step("mock pty ready");

    const terminalShell = await waitForTestId(driver, TEST_IDS.terminalShell);
    const sessionId = await terminalShell.getAttribute("data-session-id");
    expect(sessionId).toBeTruthy();
    log.step("session ready", { sessionId });

    log.step("opening draft for multiline send");
    const draftTextarea = await openDraft(driver);
    await setTextareaValue(driver, draftTextarea, "hello\nworld");
    log.step("draft multiline value set");

    log.step("sending draft with ctrl+enter");
    await sendDraftWithCtrlEnter(driver, draftTextarea);
    await waitForTestIdHidden(driver, TEST_IDS.draftTextarea, 10_000);
    log.step("draft hidden after submit");

    await driver.wait(async () => {
      const snapshot = await getTerminalOutputSnapshot(driver, sessionId!);
      return snapshot?.data.includes("hello\nworld")
        && snapshot.data.includes("[mock claude] request received");
    }, 10_000);
    const submitSnapshot = await getTerminalOutputSnapshot(driver, sessionId!);
    expect(submitSnapshot?.data).toContain("hello\nworld");
    expect(submitSnapshot?.data).toContain("[mock claude] request received");
    expect(submitSnapshot?.data).not.toContain("hello\\");
    log.step("multiline submit reflected in output");

    log.step("reopening draft for insert");
    const insertTextarea = await openDraft(driver);
    await setTextareaValue(driver, insertTextarea, "partial");
    log.step("draft insert value set");

    log.step("clicking insert");
    await clickDraftInsert(driver);
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-draft-open",
      (value) => value === "true",
      10_000,
    );
    const clearedValue = await insertTextarea.getAttribute("value");
    expect(clearedValue).toBe("");

    await driver.wait(async () => {
      const snapshot = await getTerminalOutputSnapshot(driver, sessionId!);
      return snapshot?.data.includes("partial");
    }, 10_000);
    const insertSnapshot = await getTerminalOutputSnapshot(driver, sessionId!);
    expect(insertSnapshot?.data).toContain("partial");

    const receivedCount = (insertSnapshot?.data.match(/\[mock claude\] request received/g) ?? []).length;
    expect(receivedCount).toBe(1);
    log.step("insert reflected without extra submit");

    log.step("sending empty-safe draft through button");
    await setTextareaValue(driver, insertTextarea, "button send");
    await clickDraftSend(driver);
    await waitForTestIdHidden(driver, TEST_IDS.draftTextarea, 10_000);
    await driver.wait(async () => {
      const snapshot = await getTerminalOutputSnapshot(driver, sessionId!);
      return snapshot?.data.includes("button send");
    }, 10_000);
    const buttonSnapshot = await getTerminalOutputSnapshot(driver, sessionId!);
    expect(buttonSnapshot?.data).toContain("button send");
    const finalReceivedCount = (buttonSnapshot?.data.match(/\[mock claude\] request received/g) ?? []).length;
    expect(finalReceivedCount).toBe(2);
    log.step("send button reflected in output");
  });
});
