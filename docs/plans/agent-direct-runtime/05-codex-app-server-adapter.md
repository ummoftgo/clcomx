# Codex App Server Adapter

## 목표

Codex를 terminal TUI로 실행하지 않고 app-server protocol을 통해 thread, turn, message, approval, command output을 직접 수신한다.

## 연결 방식

우선순위:

1. 로컬 subprocess로 `codex app-server --experimental --listen stdio://` 실행
2. 필요 시 websocket listen은 후속 검증 대상으로 둔다.
3. `codex exec` JSONL SDK 경로는 fallback 또는 test fixture 참고로만 사용한다.

구현 시 `codex app-server generate-ts` 또는 upstream schema를 사용해 protocol type을 생성한다. 수동 string literal protocol 구현은 drift 위험이 크다.

## Session mapping

| Codex concept | CLCOMX model |
|---|---|
| `thread/start` | `session_started` |
| `thread/resume` | `session_loaded` |
| `ThreadStartedNotification` | provider `threadId` 저장 |
| `turn/start` | active turn 생성 |
| turn status notification | `session_status_changed`, `turn_completed` |
| `AgentMessageDeltaNotification` | `agent_message_delta` |
| `ItemStartedNotification` / `ItemCompletedNotification` | message/tool/file/command card upsert |
| approval server request | `approval_requested` |
| command/process output delta | `command_output_delta` |

## Event routing

Codex app-server는 한 process에서 여러 thread/turn event가 섞일 수 있다. adapter는 다음 key로 라우팅한다.

- app-server connection id
- thread id
- turn id
- item id 또는 request id

interleaved stream은 Codex SDK test에서 중요한 사례로 다뤄진다. CLCOMX adapter test도 두 thread 또는 두 turn이 동시에 stream될 때 delta가 섞이지 않는지 검증해야 한다.

## Approval

Codex approval request는 CLCOMX `ApprovalRequest`로 변환한다.

- command 실행 승인
- patch/file change 승인
- permission profile 또는 sandbox escalation
- MCP/tool user input request

응답은 provider request id로 되돌린다. UI가 닫히거나 turn cancel이 발생하면 provider에 명시적인 deny/cancel 응답을 보낸다.

## Command output

명령 실행 output은 전체 terminal surface가 아니라 tool card 내부 terminal embed로 렌더링한다.

- stdout/stderr stream 구분을 보존한다.
- ANSI sequence는 terminal embed에서만 처리한다.
- 장기 output은 bounded buffer와 "open full terminal log" 행동으로 분리한다.

## Error handling

- initialize 실패: session status `failed`, legacy PTY fallback 제안
- schema mismatch: adapter startup error로 표시하고 runtime disabled
- app-server process exit: `process_exited`, active turn failed
- queue/backpressure: UI에 recoverable warning 표시, pending approval은 자동 방치하지 않음

## 구현 전 체크

- 로컬 `codex --version`과 generated type version을 문서에 남긴다.
- `codex app-server --help`의 experimental flag 요구 여부를 확인한다.
- app-server auth token 또는 websocket auth를 사용할 경우 저장 위치와 redaction 정책을 `09-permissions-security.md`에 반영한다.
