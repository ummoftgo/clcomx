import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { Builder, By, Capabilities, until, type WebDriver, type WebElement } from "selenium-webdriver";

const DRIVER_PORT = 4444;
const DRIVER_URL = `http://127.0.0.1:${DRIVER_PORT}/`;

function resolveProjectRoot() {
  return process.cwd();
}

function resolveBinaryPath() {
  return process.env.CLCOMX_E2E_BINARY
    ?? path.join(resolveProjectRoot(), "src-tauri", "target", "debug", "clcomx.exe");
}

function resolveTauriDriverPath() {
  if (process.env.CLCOMX_TAURI_DRIVER) {
    return process.env.CLCOMX_TAURI_DRIVER;
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".cargo", "bin", "tauri-driver.exe"),
    path.join(home, ".cargo", "bin", "tauri-driver"),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function resolveEdgeDriverPath() {
  if (process.env.CLCOMX_EDGE_DRIVER && fs.existsSync(process.env.CLCOMX_EDGE_DRIVER)) {
    return process.env.CLCOMX_EDGE_DRIVER;
  }

  const projectRoot = resolveProjectRoot();
  const candidates = [
    path.join(projectRoot, ".tools", "windows", "e2e", "msedgedriver.exe"),
    path.join(projectRoot, "msedgedriver.exe"),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function prependPath(env: NodeJS.ProcessEnv, entry: string) {
  const currentPath = env.Path ?? env.PATH ?? "";
  const segments = currentPath.split(";").filter(Boolean);
  if (!segments.includes(entry)) {
    const next = [entry, ...segments].join(";");
    env.Path = next;
    env.PATH = next;
  }
}

async function waitForPort(port: number, timeoutMs: number, child?: ChildProcess) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (child?.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`tauri-driver exited before opening port ${port} (exit code ${child.exitCode})`);
    }

    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for tauri-driver on port ${port}`);
}

export interface TauriSession {
  driver: WebDriver;
  stateDir: string;
  cleanup: () => Promise<void>;
}

export interface StartTauriSessionOptions {
  stateDir?: string;
}

export function createE2eStateDir(prefix = "clcomx-e2e-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function startTauriSession(
  options: StartTauriSessionOptions = {},
): Promise<TauriSession> {
  if (process.platform !== "win32") {
    throw new Error("Tauri smoke E2E currently runs on Windows only.");
  }

  const application = resolveBinaryPath();
  if (!fs.existsSync(application)) {
    throw new Error(`CLCOMX debug binary not found: ${application}`);
  }

  const tauriDriverPath = resolveTauriDriverPath();
  if (!tauriDriverPath) {
    throw new Error("tauri-driver was not found. Install it before running E2E smoke tests.");
  }

  const edgeDriverPath = resolveEdgeDriverPath();
  if (!edgeDriverPath) {
    throw new Error(
      "msedgedriver.exe was not found. Run `npm run test:e2e:windows -- -InstallTools` first.",
    );
  }

  const stateDir = options.stateDir ?? createE2eStateDir();
  const env = {
    ...process.env,
    CLCOMX_TEST_MODE: "1",
    CLCOMX_STATE_DIR: stateDir,
  };
  prependPath(env, path.dirname(edgeDriverPath));

  const tauriDriverArgs = ["--native-driver", edgeDriverPath];

  const tauriDriver: ChildProcess = spawn(tauriDriverPath, tauriDriverArgs, {
    env,
    stdio: "inherit",
  });

  tauriDriver.once("error", (error) => {
    console.error("Failed to start tauri-driver", error);
  });

  await waitForPort(DRIVER_PORT, 15_000, tauriDriver);

  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application });

  const driver = await new Builder()
    .withCapabilities(capabilities)
    .usingServer(DRIVER_URL)
    .build();

  async function cleanup() {
    try {
      await driver.quit();
    } catch {}

    tauriDriver.kill();
  }

  return { driver, stateDir, cleanup };
}

export async function waitForWindowCount(
  driver: WebDriver,
  expectedCount: number,
  timeoutMs = 15_000,
): Promise<string[]> {
  let handles: string[] = [];
  await driver.wait(async () => {
    handles = await driver.getAllWindowHandles();
    return handles.length >= expectedCount;
  }, timeoutMs);
  return handles;
}

export async function getWindowHandleByLabel(
  driver: WebDriver,
  label: string,
  timeoutMs = 15_000,
): Promise<string> {
  let matchedHandle: string | null = null;

  await driver.wait(async () => {
    const handles = await driver.getAllWindowHandles();
    for (const handle of handles) {
      try {
        await driver.switchTo().window(handle);
        const appRoot = await waitForTestId(driver, "app-root", 2_000);
        const currentLabel = await appRoot.getAttribute("data-window-label");
        if (currentLabel === label) {
          matchedHandle = handle;
          return true;
        }
      } catch {
        // Ignore not-ready windows while polling.
      }
    }
    return false;
  }, timeoutMs);

  if (!matchedHandle) {
    throw new Error(`Timed out waiting for window handle with label: ${label}`);
  }

  await driver.switchTo().window(matchedHandle);
  return matchedHandle;
}

export async function waitForTestId(
  driver: WebDriver,
  testId: string,
  timeoutMs = 15_000,
): Promise<WebElement> {
  const selector = `[data-testid="${testId}"]`;
  let visibleElement: WebElement | null = null;

  await driver.wait(async () => {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      try {
        if (await element.isDisplayed()) {
          visibleElement = element;
          return true;
        }
      } catch {
        // Ignore stale or detached elements while polling.
      }
    }
    return false;
  }, timeoutMs);

  if (!visibleElement) {
    throw new Error(`Timed out waiting for visible element: ${selector}`);
  }

  return visibleElement;
}

export async function waitForTestIdHidden(
  driver: WebDriver,
  testId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const selector = `[data-testid="${testId}"]`;
  await driver.wait(async () => {
    try {
      const elements = await driver.findElements(By.css(selector));
      if (elements.length === 0) return true;

      for (const element of elements) {
        if (await element.isDisplayed()) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }, timeoutMs);
}

export async function clickElement(driver: WebDriver, element: WebElement): Promise<void> {
  await driver.executeScript(
    `
      const el = arguments[0];
      el.scrollIntoView({ block: 'center', inline: 'center' });
    `,
    element,
  );

  try {
    await element.click();
  } catch {
    await driver.executeScript(
      `
        const el = arguments[0];
        el.click();
      `,
      element,
    );
  }
}

export async function clickTestId(
  driver: WebDriver,
  testId: string,
  timeoutMs = 15_000,
): Promise<WebElement> {
  const element = await waitForTestId(driver, testId, timeoutMs);
  await clickElement(driver, element);
  return element;
}

export async function waitForAttributeValue(
  driver: WebDriver,
  testId: string,
  attribute: string,
  predicate: (value: string | null) => boolean,
  timeoutMs = 15_000,
) {
  const selector = `[data-testid="${testId}"]`;
  let matchedElement: WebElement | null = null;

  await driver.wait(async () => {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      try {
        if (!(await element.isDisplayed())) continue;
        const value = await element.getAttribute(attribute);
        if (predicate(value)) {
          matchedElement = element;
          return true;
        }
      } catch {
        // Ignore stale or detached elements while polling.
      }
    }
    return false;
  }, timeoutMs);

  if (!matchedElement) {
    throw new Error(`Timed out waiting for attribute ${attribute} on ${selector}`);
  }

  return matchedElement;
}
