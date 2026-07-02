/**
 * Approval 표시 문자열 처리.
 *
 * provider가 준 raw 문자열은 그대로 표시하되, CLCOMX가 넣은 agentRuntime i18n key는 표시 직전에
 * 번역한 뒤 redaction을 적용한다. requestId/optionId 같은 routing 값은 이 경계를 타지 않는다.
 */

import { redactDisplayText } from "../service/display-redaction";

const AGENT_RUNTIME_I18N_KEY = /^agentRuntime\./;

/**
 * approval title/body/option label을 화면 표시용 문자열로 변환한다.
 * @param value provider raw 문자열 또는 CLCOMX agentRuntime i18n key.
 * @param translateKey 현재 locale의 i18n translate 함수.
 */
export function approvalDisplayText(
  value: string,
  translateKey: (key: string) => string,
): string {
  const translated = AGENT_RUNTIME_I18N_KEY.test(value) ? translateKey(value) : value;
  return redactDisplayText(translated);
}
