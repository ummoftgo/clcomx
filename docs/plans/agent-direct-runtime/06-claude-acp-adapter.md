# Claude ACP Adapter

## 목표

Claude는 terminal TUI 출력이 아니라 ACP agent로 연결한다. CLCOMX는 ACP client가 되고 `claude-agent-acp` process를 subprocess로 실행한다.

## 연결 방식

기본 transport는 ACP stdio다.

- `@agentclientprotocol/claude-agent-acp`를 npm dependency로 고정한다.
- CLCOMX가 dependency package의 `claude-agent-acp` bin(`dist/index.js`)을 adapter process로 launch한다.
- stdin/stdout은 newline-delimited JSON-RPC 2.0 message만 오간다.
- stderr는 log stream으로 분리한다.
- stdout에 ACP message가 아닌 text가 섞이면 protocol error로 처리한다.

## Lifecycle

1. `initialize`로 protocol version과 capability를 협상한다.
2. 필요하면 `authenticate`를 수행한다.
3. 새 대화는 `session/new`를 호출한다.
4. 기존 대화는 capability 확인 후 `session/load` 또는 `session/resume`를 사용한다.
5. prompt는 `session/prompt`로 보낸다.
6. 실제 출력과 상태는 `session/update` notification에서 처리한다.

## Session mapping

| ACP concept | CLCOMX model |
|---|---|
| `session/new` result `sessionId` | provider `sessionId` 저장 |
| `session/load` replay | transcript 재구성 |
| `session/prompt` accepted response | prompt accepted 상태 |
| `state_update: running` | `session_status_changed: running` |
| `state_update: requires_action` | `session_status_changed: requires_action` |
| `state_update: idle` | `session_status_changed: idle`, 필요 시 `turn_completed` |
| `user_message` | `user_message` replace/upsert |
| `agent_message` / chunk | `agent_message` replace/append |
| `plan_update` | `plan_updated` |
| `tool_call_update` | `tool_call_updated` |
| `tool_call_content_chunk` | `tool_call_content_delta` |
| `session/request_permission` | `approval_requested` |

## Upsert 규칙

ACP message와 tool call은 id 기준 upsert다. adapter가 반드시 지켜야 할 규칙:

- message update의 `content`가 있으면 기존 content를 교체한다.
- chunk는 현재 content 뒤에 append한다.
- update가 chunk 뒤에 오면 update가 기존 chunk content를 대체한다.
- 같은 `messageId` 또는 `toolCallId` 안에서는 수신 순서를 보존한다.

## Prompt content

CLCOMX composer는 ACP capability에 맞춰 content type을 제한한다.

- text: 기본 지원
- image: capability와 adapter 지원 확인 후 활성화
- resource/file mention: absolute path 요구 사항을 지킨다.

상대 경로는 UI에서 보여줄 수 있지만 ACP wire에는 absolute path 또는 file URI로 정규화한다.

## Permission

ACP agent는 `session/request_permission`으로 user decision을 요청한다. UI는 option list를 그대로 표시하되 label은 i18n key로 감싼다.

turn cancel 중 pending permission이 있으면 `cancelled` outcome을 응답한다. 응답하지 않은 permission request가 process shutdown 뒤에 남지 않도록 runtime이 pending table을 정리한다.

## Fallback

ACP adapter 실행 실패, capability 부족, schema mismatch가 발생하면 사용자가 legacy PTY Claude session으로 열 수 있게 fallback action을 제공한다. fallback은 자동 실행하지 않고 명시적 선택으로 처리한다.
