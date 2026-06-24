# Persistence and Migration

## 목표

기존 PTY session history를 보존하면서 direct runtime session metadata를 추가한다. migration은 되돌릴 수 있어야 하며, 기존 사용자의 recent history가 깨지면 안 된다.

## 저장 모델

Session record에 runtime type을 추가한다.

```ts
type SessionRuntimeKind = "pty" | "direct-codex" | "direct-claude";

interface AgentRuntimeMetadata {
  sessionRuntimeKind: SessionRuntimeKind;
  provider: "codex" | "claude" | "legacy-pty";
  providerSessionId?: string;
  providerThreadId?: string;
  lastTurnId?: string;
  providerResumeToken?: string;
  protocolVersion?: string;
  adapterVersion?: string;
  providerVersion?: string;
  canResume?: boolean;
  canLoad?: boolean;
}
```

## Transcript persistence

초기 단계는 full transcript persistence를 강제하지 않는다. 우선 다음 metadata를 저장한다.

- provider session/thread id
- last known turn id
- session runtime kind
- workdir/distro
- provider version
- resume/load 가능 여부

full transcript cache는 후속 단계로 둔다. 단, ACP `session/load` replay와 Codex `thread/read`가 가능한 경우 UI 복원은 provider replay를 우선 사용한다.

## Migration

- 기존 session record에 runtime metadata가 없으면 `sessionRuntimeKind: "pty"`로 해석한다.
- 기존 resume token은 legacy PTY resume token으로 유지한다.
- direct runtime 실패 시 기존 PTY 새 세션 또는 resume fallback을 선택할 수 있다.
- 자동 변환은 하지 않는다. 사용자가 새 direct runtime session을 열 때부터 새 metadata를 저장한다.

## 호환성

- 오래된 앱이 새 metadata를 무시해도 기존 PTY session을 열 수 있어야 한다.
- direct runtime metadata가 깨진 경우 session open 실패가 아니라 fallback 선택지를 표시한다.
- provider session id와 CLCOMX tab id를 혼동하지 않는다.

## 데이터 정리

direct runtime 실험 중 생성된 protocol debug log는 session 삭제 시 함께 삭제한다. provider 자체 session store는 provider가 관리하므로 CLCOMX가 임의 삭제하지 않는다.
