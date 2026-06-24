# Tauri Process Runtime

## 목표

Rust/Tauri backend가 direct agent process의 lifecycle과 transport framing을 책임진다. frontend는 protocol message를 직접 subprocess stdout에서 읽지 않는다.

## Runtime 종류

- `pty`: 기존 portable PTY 기반 terminal runtime
- `jsonrpc-stdio`: ACP와 Codex stdio app-server용 newline-delimited JSON-RPC runtime
- `websocket`: Codex app-server websocket 검증 후 optional runtime

`agent_runtime_*` command는 direct runtime 전용이다. 기존 PTY runtime은 현재 `pty_*` command를 계속 사용한다.

## Tauri command v1 계약

- `agent_runtime_start(params: AgentRuntimeStartParams) -> RuntimeId`
- `agent_runtime_send(runtimeId: RuntimeId, message: JsonRpcMessage) -> void`
- `agent_runtime_cancel(runtimeId: RuntimeId, target: AgentRuntimeCancelTarget) -> void`
- `agent_runtime_shutdown(runtimeId: RuntimeId) -> void`
- `agent_runtime_get_snapshot(runtimeId: RuntimeId) -> AgentRuntimeSnapshot`

```ts
type RuntimeId = number;
type JsonRpcId = string | number | null;

type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type AgentRuntimeStartParams =
  | {
      transportKind: "jsonrpc-stdio";
      provider: "codex";
      distro: string;
      workDir: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      transportKind: "jsonrpc-stdio";
      provider: "claude";
      distro: string;
      workDir: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      transportKind: "websocket";
      provider: "codex";
      distro: string;
      workDir: string;
      url: string;
      authToken?: string;
    };

type AgentRuntimeCancelTarget =
  | { type: "request"; requestId: string }
  | { type: "turn"; turnId: string }
  | { type: "process" };

interface AgentRuntimeSnapshot {
  runtimeId: RuntimeId;
  provider: "codex" | "claude";
  status: "starting" | "running" | "exited" | "failed";
  startedAt: number;
  exitedAt?: number;
  pendingRequestIds: string[];
}
```

`transportKind`는 process/transport 실행 방식이고, session persistence의 `SessionRuntimeKind`와 구분한다.
`command`, `args`, `env`는 provider adapter가 생성한 값만 허용한다. Rust command handler는 provider별 allowlist를 검증하고, renderer/UI가 임의 실행 파일이나 shell string을 직접 넘길 수 없게 한다.

## Tauri event v1 계약

- `agent-runtime-message`: JSON-RPC response/notification/request
- `agent-runtime-stderr`: stderr log line
- `agent-runtime-exit`: process exit code/signal
- `agent-runtime-error`: framing 또는 runtime error
- `agent-runtime-backpressure`: bounded queue saturation

```ts
type AgentRuntimeEvent =
  | { type: "message"; runtimeId: RuntimeId; message: JsonRpcMessage }
  | { type: "stderr"; runtimeId: RuntimeId; line: string }
  | { type: "exit"; runtimeId: RuntimeId; code?: number; signal?: string }
  | { type: "error"; runtimeId: RuntimeId; message: string; recoverable: boolean }
  | { type: "backpressure"; runtimeId: RuntimeId; droppedMessages: number };
```

## Framing

stdio JSON-RPC runtime 규칙:

- stdout은 UTF-8 newline-delimited JSON-RPC만 허용한다.
- embedded newline이 있는 message는 protocol error로 처리한다.
- stderr는 log로 캡처하되 transcript에는 기본 표시하지 않는다.
- invalid JSON은 provider adapter까지 올리지 않고 runtime error로 분류한다.

## Process lifecycle

- process start와 protocol initialize를 분리한다.
- process exit은 모든 pending request를 실패로 닫는다.
- shutdown은 graceful stdin close 후 timeout이면 kill한다.
- queue는 bounded로 두고 overflow 시 명시적인 error event를 낸다.
- startup command는 shell string이 아니라 executable + argv 배열로 실행한다.

## WSL/Windows 경계

현재 PTY는 Windows process `wsl.exe`를 통해 WSL CLI를 실행한다. direct runtime도 우선 같은 경계를 유지한다.

- Windows Tauri backend가 `wsl.exe -d <distro> -e ...`로 provider process를 띄운다.
- cwd는 WSL path를 사용한다.
- Windows UI에 보여주는 file path는 기존 file-link 변환 규칙을 재사용한다.
- ACP absolute path 요구 사항 때문에 adapter 입력 직전 path canonicalization을 수행한다.

## Logging

- protocol message raw log는 기본 비활성화한다.
- debug 모드에서만 redacted raw log를 저장한다.
- API key, auth token, command env, file contents는 redaction 대상이다.
- stderr는 session diagnostic panel에서 opt-in으로 확인한다.
