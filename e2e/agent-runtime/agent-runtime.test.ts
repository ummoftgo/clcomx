import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { By } from "selenium-webdriver";
import { TEST_IDS, tabTestId } from "../../src/lib/testids";
import {
  clickTestId,
  createE2eStateDir,
  startTauriSession,
  waitForAttributeValue,
  waitForTestId,
  waitForTestIdHidden,
  type TauriSession,
} from "../helpers/tauri";
import { openHistoryEntryByIndex, openMockWorkspaceSession } from "../helpers/launcher";
import { getTabIds, openTabMenu, selectContextMenuItem } from "../helpers/tabs";
import { waitForEditorPickerItem } from "../helpers/terminal";
import { createStepLogger } from "../helpers/log";
import { analyzeRawProtocolDebugLog } from "../../src/lib/features/agent-runtime/service/debug-log-analyzer";
import {
  clickAgentApprovalOption,
  clickAgentToolLocation,
  countVisibleTestIds,
  sendAgentComposerValue,
  waitForAgentTranscriptText,
  waitForAgentToolStatus,
} from "../helpers/agent-runtime";

interface EditorOpenEvent {
  editorId?: string;
  windowsPath?: string;
  line?: number | null;
  column?: number | null;
  isDirectory?: boolean;
}

function readEditorOpenEvents(stateDir: string): EditorOpenEvent[] {
  const logPath = path.join(stateDir, "editor-open-events.jsonl");
  if (!fs.existsSync(logPath)) return [];

  return fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EditorOpenEvent);
}

/** test-mode real launch가 실제 spawn할 fake Windows editor script를 만든다. */
function writeFakeEditorScript(stateDir: string): string {
  const scriptPath = path.join(stateDir, "fake-cursor.cmd");
  fs.writeFileSync(scriptPath, '@echo off\r\n>>"%CLCOMX_FAKE_EDITOR_LOG%" echo %*\r\n');
  return scriptPath;
}

/** fake editor process가 받은 argv 로그가 기대 조건을 만족할 때까지 기다린다. */
async function waitForFakeEditorArgs(
  session: TauriSession,
  logPath: string,
  predicate: (text: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  let matched = "";
  await session.driver.wait(() => {
    if (!fs.existsSync(logPath)) return false;
    matched = fs.readFileSync(logPath, "utf8");
    return predicate(matched);
  }, timeoutMs);

  return matched;
}

/** test-mode external editor open payload가 기록될 때까지 기다린다. */
async function waitForEditorOpenEvent(
  session: TauriSession,
  predicate: (event: EditorOpenEvent) => boolean,
  timeoutMs = 10_000,
): Promise<EditorOpenEvent> {
  let matched: EditorOpenEvent | undefined;
  await session.driver.wait(async () => {
    matched = readEditorOpenEvents(session.stateDir).find(predicate);
    return matched !== undefined;
  }, timeoutMs);

  if (!matched) {
    throw new Error("Timed out waiting for editor open event");
  }
  return matched;
}

describe.skipIf(process.platform !== "win32")("CLCOMX agent-runtime pack", () => {
  let session: TauriSession | undefined;
  const log = createStepLogger("agent-runtime");

  afterEach(async () => {
    await session?.cleanup();
    session = undefined;
  });

  it("opens a direct Codex mock session and renders a prompt response", async () => {
    session = await startTauriSession();
    const { driver, stateDir } = session;

    log.step("waiting for app root");
    await waitForTestId(driver, TEST_IDS.appRoot);

    log.step("opening direct codex mock session");
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });

    await waitForTestId(driver, TEST_IDS.agentRuntimeShell);
    const metadata = await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);
    expect(await metadata.getText()).toContain("codex");
    log.step("direct runtime metadata ready");

    await sendAgentComposerValue(driver, "hello direct runtime");
    const transcript = await waitForAgentTranscriptText(
      driver,
      /Mock Codex response: hello direct runtime/,
      10_000,
    );
    expect(await transcript.getText()).toContain("Mock Codex response: hello direct runtime");
    expect(fs.existsSync(path.join(stateDir, "agent-runtime-debug.log"))).toBe(false);
    log.step("direct runtime prompt response rendered");
  });

  it("opens a direct Claude mock session and renders a prompt response", async () => {
    session = await startTauriSession();
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "claude",
      useDirectRuntime: true,
    });

    const metadata = await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);
    expect(await metadata.getText()).toContain("claude");

    await sendAgentComposerValue(driver, "hello claude runtime");
    const transcript = await waitForAgentTranscriptText(
      driver,
      /Mock Claude response/,
      10_000,
    );
    expect(await transcript.getText()).toContain("Mock Claude response");
    log.step("direct claude prompt response rendered");
  });

  it("handles a Claude request_permission allow decision", async () => {
    session = await startTauriSession();
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "claude",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "approval please");
    await waitForTestId(driver, TEST_IDS.agentApprovalInlineCard);
    await clickAgentApprovalOption(driver, "allow");
    await waitForAgentToolStatus(driver, "tc-permission-3", "completed", 10_000);
    log.step("claude permission allow completed");
  });

  it("handles a Codex command approval allow decision", async () => {
    session = await startTauriSession();
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "approval allow");
    await waitForTestId(driver, TEST_IDS.agentApprovalModal);
    await clickAgentApprovalOption(driver, "allow_once");
    await waitForTestIdHidden(driver, TEST_IDS.agentApprovalModal, 10_000);
    await waitForAgentToolStatus(driver, "cmd-approval-1", "completed", 10_000);
    log.step("codex approval allow completed");
  });

  it("handles a Codex command approval reject decision", async () => {
    session = await startTauriSession();
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "approval reject");
    await waitForTestId(driver, TEST_IDS.agentApprovalModal);
    await clickAgentApprovalOption(driver, "reject_once");
    await waitForTestIdHidden(driver, TEST_IDS.agentApprovalModal, 10_000);
    await waitForAgentToolStatus(driver, "cmd-approval-1", "failed", 10_000);
    log.step("codex approval reject completed");
  });

  it("cancels a pending Codex inline approval with the stop button", async () => {
    session = await startTauriSession();
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "approval inline cancel");
    await waitForTestId(driver, TEST_IDS.agentApprovalInlineCard);
    await clickTestId(driver, TEST_IDS.agentComposerSend);
    await waitForTestIdHidden(driver, TEST_IDS.agentApprovalInlineCard, 10_000);
    await waitForAgentToolStatus(driver, "cmd-approval-1", "failed", 10_000);
    log.step("codex pending inline approval cancelled by stop");
  });

  it("opens a Codex tool location in the internal editor", async () => {
    const stateDir = createE2eStateDir("clcomx-e2e-agent-location-");
    fs.writeFileSync(
      path.join(stateDir, "setting.json"),
      JSON.stringify(
        {
          interface: {
            fileOpenTarget: "internal",
            fileOpenMode: "default",
            defaultEditorId: "",
          },
        },
        null,
        2,
      ),
    );
    session = await startTauriSession({ stateDir });
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "location please");
    await waitForAgentToolStatus(driver, "cmd-location-1", "completed", 10_000);
    await clickAgentToolLocation(driver, "cmd-location-1", 0);
    await waitForAttributeValue(
      driver,
      TEST_IDS.internalEditorShell,
      "data-active-path",
      (value) => value?.endsWith("/src/lib/example.ts") === true,
      10_000,
    );
    await waitForAttributeValue(
      driver,
      TEST_IDS.internalEditorShell,
      "data-active-line",
      (value) => value === "12",
      10_000,
    );
    await waitForAttributeValue(
      driver,
      TEST_IDS.internalEditorShell,
      "data-active-column",
      (value) => value === "4",
      10_000,
    );
    log.step("codex tool location opened in internal editor");
  });

  it("opens a Codex tool location through the configured external editor", async () => {
    const stateDir = createE2eStateDir("clcomx-e2e-agent-location-external-");
    fs.writeFileSync(
      path.join(stateDir, "setting.json"),
      JSON.stringify(
        {
          interface: {
            fileOpenTarget: "external",
            fileOpenMode: "default",
            defaultEditorId: "cursor",
          },
        },
        null,
        2,
      ),
    );
    session = await startTauriSession({ stateDir });
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "location please");
    await waitForAgentToolStatus(driver, "cmd-location-1", "completed", 10_000);
    await clickAgentToolLocation(driver, "cmd-location-1", 0);

    const event = await waitForEditorOpenEvent(session, (entry) => entry.editorId === "cursor");
    expect(event.windowsPath).toMatch(
      /\\wsl\.localhost\\clcomx-test\\home\\tester\\workspace\\src\\lib\\example\.ts$/,
    );
    expect(event.line).toBe(12);
    expect(event.column).toBe(4);
    expect(event.isDirectory).toBe(false);
    log.step("codex tool location reached external editor command");
  });

  it("launches a configured external editor process with goto args for a Codex tool location", async () => {
    const stateDir = createE2eStateDir("clcomx-e2e-agent-location-real-editor-");
    const fakeEditorPath = writeFakeEditorScript(stateDir);
    const fakeEditorLog = path.join(stateDir, "fake-editor-args.txt");
    fs.writeFileSync(
      path.join(stateDir, "setting.json"),
      JSON.stringify(
        {
          interface: {
            fileOpenTarget: "external",
            fileOpenMode: "default",
            defaultEditorId: "cursor",
          },
        },
        null,
        2,
      ),
    );
    session = await startTauriSession({
      stateDir,
      env: {
        CLCOMX_TEST_MODE_EDITOR_REAL_LAUNCH: "1",
        CLCOMX_WIN_EDITOR_CURSOR_PATH: fakeEditorPath,
        CLCOMX_FAKE_EDITOR_LOG: fakeEditorLog,
      },
    });
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "location please");
    await waitForAgentToolStatus(driver, "cmd-location-1", "completed", 10_000);
    await clickAgentToolLocation(driver, "cmd-location-1", 0);

    const event = await waitForEditorOpenEvent(session, (entry) => entry.editorId === "cursor");
    expect(event.line).toBe(12);
    expect(event.column).toBe(4);

    const fakeEditorArgs = await waitForFakeEditorArgs(
      session,
      fakeEditorLog,
      (text) => text.includes("--goto") && text.includes(":12:4"),
    );
    expect(fakeEditorArgs).toContain("--goto");
    expect(fakeEditorArgs).toMatch(
      /\\wsl\.localhost\\clcomx-test\\home\\tester\\workspace\\src\\lib\\example\.ts:12:4/,
    );
    log.step("codex tool location launched fake external editor process with goto args");
  });

  it("opens a Codex tool location through the external editor picker", async () => {
    const stateDir = createE2eStateDir("clcomx-e2e-agent-location-picker-");
    fs.writeFileSync(
      path.join(stateDir, "setting.json"),
      JSON.stringify(
        {
          interface: {
            fileOpenTarget: "external",
            fileOpenMode: "picker",
            defaultEditorId: "code",
          },
        },
        null,
        2,
      ),
    );
    session = await startTauriSession({ stateDir });
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "location please");
    await waitForAgentToolStatus(driver, "cmd-location-1", "completed", 10_000);
    await clickAgentToolLocation(driver, "cmd-location-1", 0);

    await waitForTestId(driver, TEST_IDS.editorPickerModal);
    await (await waitForEditorPickerItem(driver, "cursor")).click();

    const event = await waitForEditorOpenEvent(session, (entry) => entry.editorId === "cursor");
    expect(event.windowsPath).toMatch(
      /\\wsl\.localhost\\clcomx-test\\home\\tester\\workspace\\src\\lib\\example\.ts$/,
    );
    expect(event.line).toBe(12);
    expect(event.column).toBe(4);
    expect(event.isDirectory).toBe(false);
    log.step("codex tool location picker reached external editor command");
  });

  it("preserves direct runtime host when reopening from recent history", async () => {
    session = await startTauriSession();
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);
    const [directTabId] = await getTabIds(driver);
    expect(directTabId).toBeTruthy();

    await openTabMenu(driver, directTabId);
    await selectContextMenuItem(driver, "close-tab");
    const closeDialog = await waitForTestId(driver, TEST_IDS.closeTabDialog);
    const confirmButton = await closeDialog.findElement(
      By.xpath(".//button[contains(., 'Close tab') or contains(., '탭 닫기')]"),
    );
    await driver.executeScript(
      `
        const el = arguments[0];
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
      `,
      confirmButton,
    );
    await waitForTestIdHidden(driver, TEST_IDS.closeTabDialog, 10_000);

    await waitForTestId(driver, TEST_IDS.sessionLauncher);
    const recentList = await waitForTestId(driver, TEST_IDS.launcherRecentList);
    const recentText = await recentList.getText();
    expect(recentText).toContain("Codex");
    expect(recentText).toMatch(/Direct|다이렉트/);

    await openHistoryEntryByIndex(driver, 0);
    const metadata = await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);
    expect(await metadata.getText()).toContain("codex");
    log.step("direct runtime recent history reopened as direct host");
  });

  it("restores a scrubbed direct workspace as a fresh direct session with a restore notice", async () => {
    const stateDir = createE2eStateDir("clcomx-e2e-agent-cold-restore-");
    fs.writeFileSync(
      path.join(stateDir, "workspace.json"),
      JSON.stringify(
        {
          windows: [
            {
              label: "main",
              name: "main",
              role: "main",
              tabs: [
                {
                  sessionId: "direct-restore-session",
                  agentId: "codex",
                  distro: process.env.CLCOMX_TEST_DISTRO ?? "clcomx-test",
                  workDir: "/home/tester/workspace",
                  title: "direct restore",
                  pinned: false,
                  locked: false,
                  resumeToken: null,
                  ptyId: null,
                  runtimeKind: "direct-codex",
                  agentRuntime: {
                    sessionRuntimeKind: "direct-codex",
                    provider: "codex",
                    protocolVersion: "codex-app-server",
                    adapterVersion: "seeded",
                    providerVersion: "seeded",
                    canResume: true,
                    canLoad: true,
                  },
                },
              ],
              activeSessionId: "direct-restore-session",
              x: 0,
              y: 0,
              width: 1024,
              height: 720,
              maximized: false,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    session = await startTauriSession({ stateDir });
    const { driver } = session;

    log.step("waiting for scrubbed direct workspace restore");
    await waitForTestId(driver, TEST_IDS.appRoot);
    await waitForTestId(driver, TEST_IDS.agentRuntimeShell);
    await waitForTestIdHidden(driver, TEST_IDS.terminalShell, 5_000);

    log.step("checking restore-unavailable notice");
    const restoreNotice = await waitForTestId(driver, TEST_IDS.agentRestoreUnavailableNotice);
    expect(await restoreNotice.getText()).toMatch(
      /Previous conversation could not be restored|이전 대화를 복원할 수 없습니다/i,
    );

    const metadata = await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);
    expect(await metadata.getText()).toContain("codex");

    await sendAgentComposerValue(driver, "hello after cold restore");
    const transcript = await waitForAgentTranscriptText(
      driver,
      /Mock Codex response: hello after cold restore/,
      10_000,
    );
    expect(await transcript.getText()).toContain("Mock Codex response: hello after cold restore");
    log.step("scrubbed direct workspace restored as fresh direct session");
  });

  it("writes raw protocol debug logs only when enabled and redacts secret-shaped content", async () => {
    session = await startTauriSession({
      env: {
        CLCOMX_AGENT_DEBUG_LOG: "1",
      },
    });
    const { driver, stateDir } = session;
    const debugLogPath = path.join(stateDir, "agent-runtime-debug.log");

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "OPENAI_API_KEY=sk-e2e-secret");
    await waitForAgentTranscriptText(driver, /Mock Codex response/, 10_000);
    await sendAgentComposerValue(driver, "approval allow");
    await waitForTestId(driver, TEST_IDS.agentApprovalModal);
    await clickAgentApprovalOption(driver, "allow_once");
    await waitForTestIdHidden(driver, TEST_IDS.agentApprovalModal, 10_000);
    await waitForAgentToolStatus(driver, "cmd-approval-2", "completed", 10_000);

    await driver.wait(() => fs.existsSync(debugLogPath), 10_000);
    const logText = fs.readFileSync(debugLogPath, "utf8");
    const analysis = analyzeRawProtocolDebugLog(logText);
    const logEntries = logText
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { direction?: string; seq?: unknown });
    const inboundEntries = logEntries.filter((entry) => entry.direction === "in");
    expect(logText).toContain('"direction":"out"');
    expect(logText).toContain('"direction":"in"');
    expect(inboundEntries.length).toBeGreaterThan(0);
    expect(inboundEntries.every((entry) => Number.isInteger(entry.seq))).toBe(true);
    expect(analysis.terminalMarkers.map((marker) => marker.turnKey)).toEqual(
      expect.arrayContaining(["codex:t-mock:turn-mock-1", "codex:t-mock:turn-mock-2"]),
    );
    expect(analysis.lateEvents).toEqual([]);
    expect(logText).toContain("[REDACTED]");
    expect(logText).not.toContain("sk-e2e-secret");
    log.step("raw protocol debug log is opt-in and redacted", { debugLogPath });
  });

  it("detects an ACP late session/update candidate from raw protocol debug logs", async () => {
    session = await startTauriSession({
      env: {
        CLCOMX_AGENT_DEBUG_LOG: "1",
      },
    });
    const { driver, stateDir } = session;
    const debugLogPath = path.join(stateDir, "agent-runtime-debug.log");

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "claude",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "late update please");
    await waitForAgentTranscriptText(driver, /Mock Claude response/, 10_000);

    let logText = "";
    let analysis: ReturnType<typeof analyzeRawProtocolDebugLog> | undefined;
    await driver.wait(() => {
      if (!fs.existsSync(debugLogPath)) return false;
      logText = fs.readFileSync(debugLogPath, "utf8");
      analysis = analyzeRawProtocolDebugLog(logText);
      return analysis.lateEvents.some(
        (event) =>
          event.provider === "claude-acp" && event.lateMethod === "session/update:plan_update",
      );
    }, 10_000);

    expect(analysis?.terminalMarkers.some((marker) => marker.provider === "claude-acp")).toBe(true);
    expect(analysis?.lateEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claude-acp",
          terminalMethod: "session/prompt:response",
          lateMethod: "session/update:plan_update",
        }),
      ]),
    );
    expect(logText).toContain("session/prompt");
    expect(logText).toContain("session/update");
    log.step("ACP raw protocol debug log late candidate detected", { debugLogPath });
  });

  it("keeps a post-start fatal runtime error on the notice path without fallback", async () => {
    session = await startTauriSession();
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);

    await sendAgentComposerValue(driver, "fatal runtime error please");
    await waitForAgentTranscriptText(
      driver,
      /An error occurred\.|오류가 발생했습니다\./,
      10_000,
    );
    expect(await countVisibleTestIds(driver, TEST_IDS.agentRuntimeFallback)).toBe(0);
    log.step("post-start fatal runtime error stayed on notice path");
  });

  it("shows fallback choices when direct runtime start fails and opens legacy PTY on request", async () => {
    session = await startTauriSession({
      env: {
        CLCOMX_AGENT_RUNTIME_MOCK_FAIL: "1",
      },
    });
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });

    const fallback = await waitForTestId(driver, TEST_IDS.agentRuntimeFallback);
    expect(await fallback.getText()).toMatch(/direct runtime|다이렉트 런타임/i);
    log.step("fallback panel visible");

    await clickTestId(driver, TEST_IDS.agentRuntimeFallbackPty);
    await waitForTestIdHidden(driver, TEST_IDS.agentRuntimeFallback, 10_000);
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-agent-id",
      (value) => value === "codex",
      10_000,
    );
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-pty-id",
      (value) => value !== null && value !== "-1",
      10_000,
    );
    log.step("legacy PTY fallback opened");
  });

  it("opens a legacy PTY session when direct runtime is not selected", async () => {
    session = await startTauriSession();
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "claude",
      useDirectRuntime: false,
    });
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-agent-id",
      (value) => value === "claude",
      10_000,
    );
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-pty-id",
      (value) => value !== null && value !== "-1",
      10_000,
    );
    await waitForTestIdHidden(driver, TEST_IDS.agentRuntimeShell, 5_000);
    log.step("legacy pty session opened without direct runtime toggle");
  });

  it("keeps a direct runtime shell mounted while switching to a PTY tab", async () => {
    session = await startTauriSession();
    const { driver } = session;

    await waitForTestId(driver, TEST_IDS.appRoot);
    await openMockWorkspaceSession(driver, {
      agentId: "codex",
      useDirectRuntime: true,
    });
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);
    const [directTabId] = await getTabIds(driver);
    expect(directTabId).toBeTruthy();

    await clickTestId(driver, TEST_IDS.newTabButton);
    await waitForTestId(driver, TEST_IDS.sessionLauncher);
    await openMockWorkspaceSession(driver, { agentId: "claude" });
    await waitForAttributeValue(
      driver,
      TEST_IDS.terminalShell,
      "data-pty-id",
      (value) => value !== null && value !== "-1",
      10_000,
    );
    expect(await countVisibleTestIds(driver, TEST_IDS.terminalShell)).toBeGreaterThanOrEqual(1);

    const directShellsWhileHidden = await driver.findElements(
      By.css(`[data-testid="${TEST_IDS.agentRuntimeShell}"]`),
    );
    expect(directShellsWhileHidden.length).toBeGreaterThanOrEqual(1);

    await clickTestId(driver, tabTestId(directTabId));
    await waitForTestId(driver, TEST_IDS.agentRuntimeShell);
    await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);
    log.step("direct runtime shell survived PTY tab switch", { directTabId });
  });
});
