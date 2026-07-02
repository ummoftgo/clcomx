import { By, type WebDriver } from "selenium-webdriver";
import {
  TEST_IDS,
  agentApprovalOptionTestId,
  agentToolLocationTestId,
  agentTranscriptItemTestId,
} from "../../src/lib/testids";
import { clickTestId, waitForTestId } from "./tauri";
import { setTextareaValue } from "./terminal";

/** agent composer textarea 값을 실제 입력 이벤트와 함께 설정한다. */
export async function setAgentComposerValue(driver: WebDriver, value: string) {
  const input = await waitForTestId(driver, TEST_IDS.agentComposerInput);
  await setTextareaValue(driver, input, value);
  return input;
}

/** agent composer에 값을 넣고 send 버튼으로 전송한다. */
export async function sendAgentComposerValue(driver: WebDriver, value: string) {
  await setAgentComposerValue(driver, value);
  await waitForAgentComposerSendEnabled(driver);
  await clickTestId(driver, TEST_IDS.agentComposerSend);
}

/** agent composer 전송 버튼이 활성화될 때까지 기다린다. */
export async function waitForAgentComposerSendEnabled(driver: WebDriver, timeoutMs = 10_000) {
  await driver.wait(async () => {
    const button = await waitForTestId(driver, TEST_IDS.agentComposerSend);
    return (await button.getAttribute("disabled")) === null;
  }, timeoutMs);
}

/** transcript 영역의 텍스트가 지정한 패턴과 맞을 때까지 기다린다. */
export async function waitForAgentTranscriptText(
  driver: WebDriver,
  pattern: RegExp,
  timeoutMs = 10_000,
) {
  const transcript = await waitForTestId(driver, TEST_IDS.agentTranscript);
  await driver.wait(async () => {
    const text = await transcript.getText();
    return pattern.test(text);
  }, timeoutMs);
  return transcript;
}

/** approval option id에 해당하는 버튼을 클릭한다. */
export async function clickAgentApprovalOption(driver: WebDriver, optionId: string) {
  const optionTestId = agentApprovalOptionTestId(optionId);
  const selector = `[data-option-testid="${optionTestId}"]`;
  const option = await driver.wait(async () => {
    const nodes = await driver.findElements(By.css(selector));
    for (const node of nodes) {
      try {
        if (await node.isDisplayed()) return node;
      } catch {
        // polling 중 stale node는 다음 루프에서 다시 조회한다.
      }
    }
    return null;
  }, 10_000);
  await driver.executeScript(
    `
      const el = arguments[0];
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    `,
    option,
  );
}

/** 특정 transcript item의 tool card status가 기대값이 될 때까지 기다린다. */
export async function waitForAgentToolStatus(
  driver: WebDriver,
  itemId: string,
  status: string,
  timeoutMs = 10_000,
) {
  const selector = `[data-item-testid="${agentTranscriptItemTestId(itemId)}"]`;
  await driver.wait(async () => {
    const nodes = await driver.findElements(By.css(selector));
    for (const node of nodes) {
      try {
        if ((await node.isDisplayed()) && (await node.getAttribute("data-status")) === status) {
          return true;
        }
      } catch {
        // polling 중 stale node는 다음 루프에서 다시 조회한다.
      }
    }
    return false;
  }, timeoutMs);
}

/** 특정 tool card의 location row를 펼친 뒤 클릭한다. */
export async function clickAgentToolLocation(
  driver: WebDriver,
  itemId: string,
  index = 0,
  timeoutMs = 10_000,
) {
  const itemSelector = `[data-item-testid="${agentTranscriptItemTestId(itemId)}"]`;
  const item = await driver.wait(async () => {
    const nodes = await driver.findElements(By.css(itemSelector));
    for (const node of nodes) {
      try {
        if (await node.isDisplayed()) return node;
      } catch {
        // polling 중 stale node는 다음 루프에서 다시 조회한다.
      }
    }
    return null;
  }, timeoutMs);

  const toggle = await item.findElement(By.css(`[data-testid="${TEST_IDS.agentToolCallToggle}"]`));
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await driver.executeScript(
      `
        const el = arguments[0];
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
      `,
      toggle,
    );
  }

  const locationSelector = `[data-testid="${agentToolLocationTestId(itemId, index)}"]`;
  const location = await driver.wait(async () => {
    const nodes = await driver.findElements(By.css(locationSelector));
    for (const node of nodes) {
      try {
        if (await node.isDisplayed()) return node;
      } catch {
        // polling 중 stale node는 다음 루프에서 다시 조회한다.
      }
    }
    return null;
  }, timeoutMs);
  await driver.executeScript(
    `
      const el = arguments[0];
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    `,
    location,
  );
}

/** 현재 표시 중인 특정 testid 요소 개수를 센다. */
export async function countVisibleTestIds(driver: WebDriver, testId: string): Promise<number> {
  const nodes = await driver.findElements(By.css(`[data-testid="${testId}"]`));
  let count = 0;
  for (const node of nodes) {
    try {
      if (await node.isDisplayed()) count += 1;
    } catch {
      // polling 중 stale node는 다음 루프에서 다시 조회한다.
    }
  }
  return count;
}
