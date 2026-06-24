# ADR-001: Direct Agent Runtime

## Status

Proposed

## Context

CLCOMX는 현재 `claude`와 `codex` CLI를 WSL PTY에서 실행하고 xterm.js에 byte stream을 렌더링한다. 이 방식은 기존 CLI/TUI를 빠르게 감쌀 수 있지만, agent message, tool call, approval, diff, command output, session/turn id를 구조화하기 어렵다.

Codex는 app-server protocol과 SDK test를 공개하고 있고, Claude 쪽은 ACP와 `claude-agent-acp`를 통해 editor/client가 agent와 JSON-RPC로 통신하는 모델이 공개되어 있다. 두 provider 모두 terminal text보다 직접 protocol event를 사용하는 쪽이 데스크톱 앱식 UI에 적합하다.

## Decision

CLCOMX는 direct agent runtime을 새 runtime family로 도입한다.

- Codex는 app-server protocol adapter로 연결한다.
- Claude는 ACP adapter로 연결한다.
- UI와 persistence는 provider adapter가 만든 normalized agent event만 소비한다.
- 기존 PTY/xterm runtime은 삭제하지 않고 legacy/fallback/보조 터미널 역할로 유지한다.

## Consequences

Positive:

- agent message, tool call, approval, command output을 구조화해 표시할 수 있다.
- provider session/turn/message/tool id를 보존할 수 있다.
- 여러 thread/turn stream을 명확히 라우팅할 수 있다.
- terminal marker 의존도가 줄어든다.

Negative:

- adapter, event router, process runtime, persistence migration이 추가되어 구조가 복잡해진다.
- upstream protocol drift에 대응해야 한다.
- 두 provider의 capability 차이를 UI와 store가 흡수해야 한다.

Risks:

- Codex app-server experimental surface가 바뀔 수 있다.
- ACP version과 `claude-agent-acp` package version이 맞지 않을 수 있다.
- pending approval cleanup을 잘못 처리하면 agent process가 응답 대기 상태로 멈출 수 있다.
- terminal fallback과 direct transcript가 공존하면서 focus/shortcut 회귀가 생길 수 있다.
