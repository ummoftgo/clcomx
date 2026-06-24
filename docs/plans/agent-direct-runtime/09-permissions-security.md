# Permissions and Security

## 신뢰 경계

Direct runtime은 terminal 출력보다 더 많은 구조화 권한 정보를 받는다. 따라서 provider, adapter, UI, user decision의 경계를 명확히 해야 한다.

```text
Provider process
  -> Adapter
  -> CLCOMX permission store
  -> User approval UI
  -> Adapter response
```

## 승인 원칙

- provider가 permission request를 보내면 CLCOMX는 request id와 option id를 보존한다.
- UI가 표시하지 않은 option을 임의로 선택하지 않는다.
- turn cancel, session shutdown, process exit은 pending approval을 cancelled/failed로 닫는다.
- 자동 허용은 별도 설정과 audit trail이 준비되기 전까지 도입하지 않는다.
- direct runtime startup command는 provider adapter allowlist를 통과한 executable + argv만 허용한다.

## 민감 정보

redaction 대상:

- API key, OAuth token, session cookie
- command environment
- runtime startup command env
- auth 관련 stdout/stderr
- MCP server credential
- file content raw log

## 로그 정책

- protocol raw message는 기본 저장하지 않는다.
- debug raw log는 opt-in이며 redaction 후 저장한다.
- 사용자에게 보이는 transcript는 provider가 표시 목적으로 보낸 content와 CLCOMX가 생성한 summary만 포함한다.
- stderr diagnostic은 기본 collapsed 상태로 둔다.

## MCP와 client tool

ACP와 Codex app-server는 MCP/client tool 흐름을 가질 수 있다. CLCOMX가 client tool을 제공하는 경우:

- tool 이름, 입력 schema, 권한 수준을 문서화한다.
- file write, command execution, network fetch는 user approval 또는 provider permission과 연결한다.
- tool result는 transcript에 표시 가능한 summary와 raw data를 분리한다.

## Sandbox

CLCOMX는 provider의 sandbox/approval policy를 UI에 표시한다. 앱 자체가 provider sandbox를 우회해서 명령을 실행하지 않는다.

- Codex permission profile과 sandbox mode를 session metadata에 표시한다.
- Claude Agent SDK permission mode를 session metadata에 표시한다.
- legacy PTY fallback은 provider terminal policy에 맡기되, CLCOMX UI는 direct runtime과 같은 수준의 구조화 보장을 제공하지 않는다고 표시한다.

## 브랜드/제품 표시

Claude Agent SDK 문서는 제품이 Claude Code 또는 Anthropic 제품처럼 보이지 않아야 한다고 안내한다. CLCOMX UI는 agent provider를 표시하되, Claude Code/Anthropic 공식 앱처럼 오인될 수 있는 branding, ASCII art, visual copy를 사용하지 않는다.
