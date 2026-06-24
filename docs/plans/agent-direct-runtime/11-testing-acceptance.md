# Testing and Acceptance

## 원칙

앱 실행은 구현 slice가 문서, cleanup, adapter fixture test를 통과한 뒤 마지막 검증으로 수행한다. direct runtime은 protocol mapping 오류가 UX 회귀로 이어지기 쉬우므로 fixture 기반 테스트를 먼저 둔다.

## Unit tests

### Normalized model

- message replace/append 순서
- tool call upsert
- approval request/resolution lifecycle
- cancelled turn이 pending approval을 닫는지
- provider raw id 보존

### Codex adapter

- thread start/resume mapping
- agent message delta와 completed item reconcile
- command output delta routing
- approval request/response mapping
- interleaved turn stream이 turn id별로 분리되는지
- app-server process exit 처리

### Claude ACP adapter

- initialize/session new/session load flow
- `session/prompt` accepted response와 `session/update` 분리
- ACP message chunk/update replace semantics
- tool call content chunk append
- permission option과 outcome mapping
- stdout invalid JSON framing error

## Tauri tests

- stdio JSON-RPC process start/stop
- provider별 startup command allowlist 검증
- newline-delimited message framing
- stderr와 stdout 분리
- bounded queue overflow event
- shutdown timeout 후 kill

## Frontend tests

- transcript message rendering
- direct runtime metadata 저장/복원 표시
- tool card collapsed/expanded 상태
- command output terminal embed
- approval modal option rendering
- i18n key 누락 방지
- focus/shortcut 회귀: composer, terminal embed, modal, assistant dock

## E2E scenarios

- direct Codex 새 세션에서 prompt 전송 후 streaming response 표시
- direct Claude ACP 새 세션에서 prompt 전송 후 `session/update` transcript 표시
- approval 요청 표시와 allow/reject 응답
- cancel 중 pending approval cleanup
- direct runtime 실패 후 legacy PTY fallback 선택
- 기존 PTY session open이 깨지지 않는지

## Acceptance checklist

- Codex와 Claude 모두 새 session, resume/load, prompt, stream, tool call, approval, cancel, error, process exit 문서/테스트가 있다.
- xterm terminal-first 화면이 legacy path로 계속 동작한다.
- 새 UI text는 locale key로 관리된다.
- provider id가 저장소와 debug view에서 추적 가능하다.
- raw protocol log가 기본 비활성화이며 redaction 정책이 있다.
