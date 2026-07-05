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
  buildSeedTranscriptCacheSnapshot,
  clickAgentApprovalOption,
  clickAgentToolLocation,
  countVisibleTestIds,
  seedResumeKeysFile,
  seedTranscriptCacheFile,
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

/**
 * E2E-13a/13b 공용: 단일 direct 세션 탭을 가진 `workspace.json`을 `stateDir`에 시드한다.
 * E2E-12(`restores a scrubbed ...`)와 동일한 형태를 따르되, canResume/canLoad를 파라미터로 받아
 * hybrid 복원(캐시+resume) 대 read-only(캐시만, resume 불가) 시나리오를 구분한다.
 */
function writeSeededDirectWorkspace(
  stateDir: string,
  options: {
    sessionId: string;
    agentId: "codex" | "claude";
    canResume: boolean;
    canLoad: boolean;
    providerThreadId?: string;
  },
): void {
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
                sessionId: options.sessionId,
                agentId: options.agentId,
                distro: process.env.CLCOMX_TEST_DISTRO ?? "clcomx-test",
                workDir: "/home/tester/workspace",
                title: "direct hybrid restore",
                pinned: false,
                locked: false,
                resumeToken: null,
                ptyId: null,
                runtimeKind: options.agentId === "codex" ? "direct-codex" : "direct-claude",
                agentRuntime: {
                  sessionRuntimeKind: options.agentId === "codex" ? "direct-codex" : "direct-claude",
                  provider: options.agentId,
                  protocolVersion: options.agentId === "codex" ? "codex-app-server" : "acp",
                  adapterVersion: "seeded",
                  providerVersion: "seeded",
                  providerThreadId: options.providerThreadId,
                  canResume: options.canResume,
                  canLoad: options.canLoad,
                },
              },
            ],
            activeSessionId: options.sessionId,
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

  it("E2E-13a: restores cached history immediately and resumes the mock provider on cold restart", async () => {
    const stateDir = createE2eStateDir("clcomx-e2e-agent-hybrid-restore-");
    const sessionId = "direct-hybrid-resume-session";

    // 암호화 재개 id + 캐시가 모두 있는 하이브리드 복원 상태를 시드한다. workspace.json의
    // provider id는 backend가 로드 경로에서도 scrub하므로(store.rs read 경로 방어) 폴백 소스가
    // 될 수 없다 — 재개 id는 test-mode 고정 앱 키로 암호화한 **실제 저장소 파일**로 시드해
    // 앱의 TB-5 복호화 → resume 경로를 그대로 검증한다. canLoad=false로 replay 없는
    // resume(thread/resume)을 태워 캐시가 read-only로 유지된 채 세션이 이어진다(10 §4.4a —
    // replay 없는 재개는 provider가 히스토리를 재방출하지 않으므로 캐시를 유지).
    writeSeededDirectWorkspace(stateDir, {
      sessionId,
      agentId: "codex",
      canResume: true,
      canLoad: false,
      providerThreadId: "t-mock",
    });
    seedResumeKeysFile(stateDir, sessionId, {
      providerThreadId: "t-mock",
      canResume: true,
      canLoad: false,
    });
    seedTranscriptCacheFile(
      stateDir,
      sessionId,
      buildSeedTranscriptCacheSnapshot("cached reply from before restart"),
    );

    session = await startTauriSession({ stateDir });
    const { driver } = session;

    log.step("waiting for hybrid restore (cache + resume) direct workspace");
    await waitForTestId(driver, TEST_IDS.appRoot);
    await waitForTestId(driver, TEST_IDS.agentRuntimeShell);
    await waitForTestIdHidden(driver, TEST_IDS.terminalShell, 5_000);

    log.step("checking cached history renders immediately");
    const transcriptBeforeResume = await waitForAgentTranscriptText(
      driver,
      /cached reply from before restart/,
      10_000,
    );
    expect(await transcriptBeforeResume.getText()).toContain("cached reply from before restart");

    // hybrid 복원은 resume가 성공하므로 restoreUnavailable/historyReadOnly notice 둘 다 뜨지 않는다.
    const restoreNotices = await driver.findElements(
      By.css(`[data-testid="${TEST_IDS.agentRestoreUnavailableNotice}"]`),
    );
    expect(restoreNotices.length).toBe(0);
    const readOnlyNotices = await driver.findElements(
      By.css(`[data-testid="${TEST_IDS.agentHistoryReadOnlyNotice}"]`),
    );
    expect(readOnlyNotices.length).toBe(0);

    const metadata = await waitForTestId(driver, TEST_IDS.agentRuntimeMetadata);
    expect(await metadata.getText()).toContain("codex");

    log.step("sending prompt after resume to confirm the session stayed usable");
    await sendAgentComposerValue(driver, "hello after hybrid restore");
    const transcriptAfterPrompt = await waitForAgentTranscriptText(
      driver,
      /Mock Codex response: hello after hybrid restore/,
      10_000,
    );
    expect(await transcriptAfterPrompt.getText()).toContain(
      "Mock Codex response: hello after hybrid restore",
    );
    log.step("hybrid cold restart resumed and accepted a follow-up prompt");
  });

  it("E2E-13b: shows read-only cached history and starts a fresh usable session when resume/load are both unsupported", async () => {
    const stateDir = createE2eStateDir("clcomx-e2e-agent-readonly-restore-");
    const sessionId = "direct-readonly-history-session";

    // canResume=false && canLoad=false → buildResumeConfig가 undefined를 반환해 resume를 시도하지 않는다.
    // 캐시가 있으므로 store.isReadOnlyHydrated가 true가 되어 historyReadOnly affordance로 낮아진다
    // (AgentTranscriptSurface.svelte의 `!resume && store.isReadOnlyHydrated` 분기).
    writeSeededDirectWorkspace(stateDir, {
      sessionId,
      agentId: "codex",
      canResume: false,
      canLoad: false,
      providerThreadId: "t-mock",
    });
    seedTranscriptCacheFile(
      stateDir,
      sessionId,
      buildSeedTranscriptCacheSnapshot("read-only cached reply, resume unsupported"),
    );

    session = await startTauriSession({ stateDir });
    const { driver } = session;

    log.step("waiting for read-only cached history restore");
    await waitForTestId(driver, TEST_IDS.appRoot);
    await waitForTestId(driver, TEST_IDS.agentRuntimeShell);
    await waitForTestIdHidden(driver, TEST_IDS.terminalShell, 5_000);

    const transcript = await waitForAgentTranscriptText(
      driver,
      /read-only cached reply, resume unsupported/,
      10_000,
    );
    expect(await transcript.getText()).toContain("read-only cached reply, resume unsupported");

    log.step("checking historyReadOnly affordance");
    const readOnlyNotice = await waitForTestId(driver, TEST_IDS.agentHistoryReadOnlyNotice);
    expect(await readOnlyNotice.getText()).toMatch(
      /Showing previous conversation \(read-only\)|이전 대화 \(읽기 전용\)/i,
    );
    // canResume=false && canLoad=false는 복원 실패가 아니라 "새 세션으로 이어감"이므로
    // restoreUnavailable(복원 불가) notice는 뜨지 않는다 — historyReadOnly가 대신한다.
    const restoreNotices = await driver.findElements(
      By.css(`[data-testid="${TEST_IDS.agentRestoreUnavailableNotice}"]`),
    );
    expect(restoreNotices.length).toBe(0);

    // composer는 fresh 세션이 시작을 마칠 때까지(store.status가 ready/idle/running이 되기 전) 비활성이다.
    // historyReadOnly notice가 이미 떠 있는 시점에서 composer가 아직 활성화 전인지 best-effort로 확인한다.
    const composerInput = await waitForTestId(driver, TEST_IDS.agentComposerInput);
    const disabledAtNoticeTime = await composerInput.getAttribute("disabled");
    log.step("composer disabled attribute at historyReadOnly notice time", {
      disabledAtNoticeTime,
    });

    // 이 새 세션은 정상적으로 fresh start가 가능하므로(캐시는 read-only 표시일 뿐) composer는
    // start 완료 후 활성화되고 정상적으로 prompt를 보낼 수 있어야 한다(read-only 캐시 아래로 이어감).
    await sendAgentComposerValue(driver, "hello after read-only restore");
    const transcriptAfterPrompt = await waitForAgentTranscriptText(
      driver,
      /Mock Codex response: hello after read-only restore/,
      10_000,
    );
    expect(await transcriptAfterPrompt.getText()).toContain(
      "Mock Codex response: hello after read-only restore",
    );
    log.step("read-only cached history shown, composer usable for the new session below it");
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
