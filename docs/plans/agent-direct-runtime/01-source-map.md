# Source Map

확인일: 2026-06-24

## 사용 가능한 근거

### OpenAI Codex

- 저장소: https://github.com/openai/codex
- 최신 확인 릴리스: `rust-v0.142.0`, 2026-06-22T22:19:53Z
- 로컬 CLI: `codex-cli 0.142.0`
- 핵심 근거:
  - `codex-rs/app-server-protocol`: app-server protocol type, JSON schema, TypeScript generation source
  - `codex-rs/app-server-client`: in-process app-server client, lifecycle, bootstrap, backpressure, shutdown 정책
  - `sdk/python/tests/test_app_server_streaming.py`: streaming delta, turn completion, interleaved turn routing 사례
  - `sdk/typescript/src/thread.ts`, `sdk/typescript/src/events.ts`: public SDK의 thread/turn event 형태

Codex 계획은 CLI terminal 출력 파싱이 아니라 app-server protocol을 1차 근거로 삼는다. `codex exec`/TypeScript SDK JSONL event는 fallback 또는 fixture 참고 자료로만 사용한다.

### Agent Client Protocol

- 문서: https://agentclientprotocol.com/get-started/introduction
- 저장소: https://github.com/agentclientprotocol/agent-client-protocol
- 최신 확인 schema 릴리스: `schema-v1.16.0`, 2026-06-24T14:10:13Z
- 계획 기준 protocol 문서: `docs/protocol/v2/*`
- 핵심 근거:
  - `docs/protocol/v2/overview.mdx`: JSON-RPC 2.0, client/agent 역할, method/notification 구분
  - `docs/protocol/v2/transports.mdx`: stdio transport, newline-delimited JSON-RPC, stdout purity 규칙
  - `docs/protocol/v2/session-setup.mdx`: `session/new`, `session/load`, `session/resume`
  - `docs/protocol/v2/prompt-lifecycle.mdx`: `session/prompt`, `session/update`, running/idle 상태
  - `docs/protocol/v2/tool-calls.mdx`: `tool_call_update`, `tool_call_content_chunk`, `session/request_permission`

ACP 계획은 v2 문서를 기준으로 작성한다. schema 릴리스 태그와 protocol 문서 버전은 서로 다른 축이므로, 구현 시점에는 schema package와 adapter가 실제로 지원하는 protocol version을 다시 확인해야 한다.

### Claude Agent / ACP Adapter

- 공식 SDK 문서: https://code.claude.com/docs/en/agent-sdk/overview
- ACP adapter 저장소: https://github.com/agentclientprotocol/claude-agent-acp
- 최신 확인 릴리스: `v0.50.0`, 2026-06-23T15:45:47Z
- npm package: `@agentclientprotocol/claude-agent-acp@0.50.0`
- deprecated 이전 package: `@zed-industries/claude-code-acp@0.16.2`
- 로컬 CLI: `2.1.187 (Claude Code)`
- 핵심 근거:
  - Claude Agent SDK는 Claude Code의 도구 실행, session, permission, MCP, hook, subagent 기능을 library interface로 노출한다.
  - `claude-agent-acp`는 Claude Agent SDK를 ACP agent로 감싸며 context mention, image, tool permission, todo list, terminal, slash command, client MCP를 지원한다.

Claude 계획은 `claude -p --output-format stream-json`을 주 경로로 삼지 않는다. stream-json은 진단 또는 fallback으로만 남긴다.

## 제외 자료

- Claude Code 유출본, 비공식 decompiled source, 출처 불명 mirror
- 라이선스가 명확하지 않은 fork 또는 gist
- 최신 공식 protocol과 맞지 않는 오래된 블로그의 wire shape
- UX를 베끼기 위한 브랜드/시각 요소 복제 자료

## 구현 전 재확인 체크

- `codex app-server --help`에서 `generate-ts`, `generate-json-schema`, `--listen` 옵션 확인
- `codex app-server generate-ts` 결과를 `src/lib/features/agent-runtime/generated/codex-app-server/`의 생성 타입과 비교
- `@agentclientprotocol/claude-agent-acp`와 ACP schema version 호환성 확인
- `@zed-industries/claude-code-acp`는 rename/deprecated 상태이므로 새 의존성에 추가하지 않는다.
- Anthropic Agent SDK 약관과 branding guideline 확인: 제품이 Claude Code 또는 Anthropic 제품처럼 보이면 안 된다.
