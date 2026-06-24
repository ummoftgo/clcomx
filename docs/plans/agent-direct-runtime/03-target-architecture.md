# Target Architecture

## 패턴

Hexagonal architecture를 적용한다. UI와 저장소는 내부 공통 agent model만 바라보고, Codex app-server와 Claude ACP는 provider adapter로 격리한다.

```text
Svelte UI
  -> Agent Session Store
  -> Agent Event Router
  -> Agent Runtime Port
      -> Codex App Server Adapter
      -> Claude ACP Adapter
      -> Legacy PTY Adapter
  -> Tauri Process Runtime
      -> WSL subprocess / stdio / websocket / PTY
```

## 주요 구성

### Agent Runtime Port

provider별 구현을 숨기는 TypeScript-facing interface다.

- `startSession(params)`
- `resumeSession(params)`
- `sendPrompt(sessionId, input)`
- `cancelTurn(sessionId, turnId)`
- `respondApproval(requestId, decision)`
- `subscribeEvents(sessionId)`
- `shutdown(sessionId)`

### Provider Adapter

provider protocol을 CLCOMX 공통 이벤트로 변환한다.

- Codex adapter: app-server JSON-RPC와 typed schema를 사용한다.
- Claude adapter: ACP stdio JSON-RPC와 `claude-agent-acp`를 사용한다.
- Legacy PTY adapter: 현재 PTY flow를 공통 모델의 `terminal_output_delta` event로 감싼다.

### Event Router

모든 provider event는 router를 통과한다. router는 provider, workspace, session id, turn id, request id를 기준으로 UI store와 pending request table에 전달한다.

### Session Store

transcript, tool card 상태, approval request, process 상태, provider 원본 id를 보존한다. 저장소는 direct runtime metadata와 legacy PTY metadata를 분리한다.

### Tauri Process Runtime

Rust backend가 agent subprocess lifecycle, stdio framing, stderr log capture, process termination, bounded queue, backpressure를 담당한다.

## 데이터 흐름

### 새 세션

1. UI가 agent, distro, workdir, runtime type을 선택한다.
2. Session Store가 local session shell을 만든다.
3. Tauri Process Runtime이 provider process를 시작한다.
4. Adapter가 protocol initialize/session start를 수행한다.
5. provider session id가 store에 저장된다.
6. UI가 transcript surface로 전환된다.

### 프롬프트

1. UI composer가 text/image/resource input을 만든다.
2. Runtime Port가 provider-specific prompt request로 변환한다.
3. Adapter가 accepted response와 stream update를 분리 처리한다.
4. Event Router가 message/tool/approval/delta/completion event를 session store에 적용한다.
5. UI는 store 변화만 렌더링한다.

### 취소

1. UI가 active turn cancel을 요청한다.
2. Adapter가 provider cancel method를 호출한다.
3. pending approval이 있으면 cancel outcome으로 닫는다.
4. store는 turn status를 `cancelled` 또는 provider가 보고한 terminal state로 갱신한다.

## 설계 원칙

- provider 원본 event와 id를 잃지 않는다.
- renderer는 provider-specific type을 직접 import하지 않는다.
- 모든 user-visible label은 i18n key로 설계한다.
- terminal UI는 삭제하지 않고 explicit terminal card와 fallback runtime에 남긴다.
- app launch 전에는 adapter fixture와 store test로 protocol mapping을 검증한다.
