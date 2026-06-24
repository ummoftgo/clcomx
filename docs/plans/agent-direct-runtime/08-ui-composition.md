# UI Composition

## 목표

에이전트 응답을 terminal byte stream이 아니라 구조화된 transcript로 표시한다. 화면 경험은 Codex Desktop App이나 Claude Desktop App처럼 message, tool activity, approval, diff, command output이 구분되는 형태를 목표로 한다.

## 주요 화면

### Transcript Surface

- user message
- agent message
- reasoning/plan summary
- tool call card
- command output card
- file diff card
- approval card/modal
- error/retry notice

### Composer

- text input
- image paste attachment
- file/resource mention
- send/cancel button
- active runtime/provider indicator

### Tool Card

tool kind에 따라 icon과 compact summary를 다르게 표시한다.

- read/search/fetch: collapsed result summary
- edit/delete/move: affected path와 diff preview
- execute: command, cwd, stdout/stderr terminal embed
- think/plan: compact plan block

### Approval UI

- provider가 제시한 option을 그대로 보존한다.
- allow once, allow always, reject once, reject always, cancel 같은 action은 i18n key로 표시한다.
- approval request가 active인 동안 composer 상태와 cancel behavior를 명확히 한다.

## Terminal의 새 역할

xterm은 전체 agent 화면이 아니라 다음 경우에 사용한다.

- 보조 셸 dock
- command output card 내부 terminal embed
- legacy PTY fallback session
- raw diagnostic view

## i18n

새 UI text는 모두 locale file에 key로 추가한다.

예상 namespace:

- `agentRuntime.status.*`
- `agentRuntime.approval.*`
- `agentRuntime.toolKind.*`
- `agentRuntime.errors.*`
- `agentRuntime.fallback.*`

## Focus와 shortcut

기존 terminal focus와 assistant dock shortcut 회귀 위험이 높다. direct runtime UI는 다음 원칙을 지킨다.

- composer focus와 terminal embed focus를 분리한다.
- command output card의 terminal embed가 일반 app shortcut을 가로채지 않게 한다.
- 기존 Space toggle, tab movement, modal escape 동작은 별도 회귀 테스트로 보호한다.

## Responsive layout

- transcript는 tab content 영역을 기준으로 full-height flex layout을 사용한다.
- tool card는 nested card를 피하고, 반복 item card만 사용한다.
- 긴 command, path, model name은 wrapping 또는 horizontal scroll을 지정한다.
- terminal embed는 고정 높이와 resize handle을 가진다.
