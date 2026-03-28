# Tmux Snapshot Contract Redesign

작성일: 2026-03-28
상태: 설계 합의 완료
우선순위: 높음

## 배경

`agent-centric / hybrid workspace`로 방향을 바꿨지만, 그 위에서 하위 에이전트 감지와 active surface 추적이 제대로 보이려면 tmux 런타임 상태가 먼저 안정적으로 올라와야 한다.

현재는 다음 같은 증상이 반복됐다.

- split 뒤에도 `panes:1`로 남음
- active pane 전환과 child visibility가 서로 다른 시점에 움직임
- tmux window 변화는 구조적으로 UI에 표현할 수 없음

이 문서는 “tmux snapshot 계약” 자체를 다시 정의해서, 프론트가 하나의 정합한 상태를 보게 만드는 것을 목표로 한다.

## 현재 문제

### 1. split 뒤 fresh snapshot이 보장되지 않는다

`tmux_split_pane()`은 split 명령만 보내고, fresh snapshot을 직접 수집/emit하지 않는다. 이후 UI 반영은 proxy의 structural event 처리와 단발 snapshot capture에 의존한다.

관련 위치:

- [tmux.rs](/home/xenia/work/claudemx/.worktrees/feature-scratch/src-tauri/src/commands/tmux.rs#L1092)
- [tmux_proxy.py](/home/xenia/work/claudemx/.worktrees/feature-scratch/src-tauri/scripts/tmux_proxy.py#L235)

즉 split 직후 topology가 아직 settle되지 않았으면 stale snapshot이 그대로 emit될 수 있다.

### 2. snapshot schema가 pane-only다

현재 snapshot은 사실상 `activePaneId + session size + panes[]`만 가진다.

관련 위치:

- [tmux.rs](/home/xenia/work/claudemx/.worktrees/feature-scratch/src-tauri/src/commands/tmux.rs#L52)
- [tmux.ts](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/tmux.ts#L21)

빠진 것:

- `activeWindowId`
- `windows[]`
- `pane.windowId`
- monotonic `revision`
- `capturedAt`

그래서 backend는 `%window-add`, `%session-window-changed`를 감지하더라도, 프론트에 window 구조를 전달할 수 없다.

### 3. frontend가 tmux 상태를 세 군데서 따로 본다

현재 frontend는 다음 상태를 서로 다른 경로에서 읽는다.

- pane count: `TmuxTerminal` local `snapshot`
- active pane in session store: `session.tmuxActivePaneId`
- child visibility / selected agent node: `agent-workspace`

관련 위치:

- [TmuxTerminal.svelte](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/components/TmuxTerminal.svelte#L1030)
- [App.svelte](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/App.svelte#L850)
- [agent-workspace.svelte.ts](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/stores/agent-workspace.svelte.ts#L251)

즉 UI가 같은 tmux reality를 서로 다른 타이밍과 다른 shape로 보는 구조다.

### 4. state emit source가 여러 개다

현재 state는 다음 경로들에서 나올 수 있다.

- subscribe 직후 Rust direct emit
- proxy initial emit
- proxy structural emit
- resize direct emit

관련 위치:

- [tmux.rs](/home/xenia/work/claudemx/.worktrees/feature-scratch/src-tauri/src/commands/tmux.rs#L1016)
- [tmux.rs](/home/xenia/work/claudemx/.worktrees/feature-scratch/src-tauri/src/commands/tmux.rs#L1274)
- [tmux_proxy.py](/home/xenia/work/claudemx/.worktrees/feature-scratch/src-tauri/scripts/tmux_proxy.py#L307)
- [tmux_proxy.py](/home/xenia/work/claudemx/.worktrees/feature-scratch/src-tauri/scripts/tmux_proxy.py#L323)

그런데 event에 `revision`이 없어서 늦게 도착한 오래된 snapshot을 걸러낼 수 없다.

## 목표

- split / close / select / window change 이후 fresh topology snapshot이 일관되게 도착할 것
- frontend는 tmux 상태를 한 source에서만 읽을 것
- pane count, active pane, child visibility, selected node가 같은 snapshot 기준으로 움직일 것
- agent-centric UI가 tmux pane/window 구조를 신뢰 가능한 입력으로 사용할 수 있을 것

## 비목표

- 이 문서는 scroll / copy-mode를 다루지 않는다
- 이 문서는 tmux pane native remap UX를 개선하려는 문서가 아니다
- persistent transcript 저장 구조는 여기서 다루지 않는다

## 선택한 접근

선택한 방향은 `backend-authoritative snapshot + single frontend snapshot store`다.

핵심은 두 가지다.

- backend는 `window-aware`, `revision-aware` snapshot만 authoritative state로 emit한다
- frontend는 그 snapshot을 한 번만 ingest하고, 나머지 UI는 모두 그 shared snapshot을 파생해 쓴다

## 새 snapshot 계약

기존 `TmuxSessionSnapshot`을 확장한다.

### Session snapshot

- `sessionName`
- `revision`
- `capturedAt`
- `activeWindowId`
- `activePaneId`
- `width`
- `height`
- `windows: TmuxWindowSnapshot[]`
- `panes: TmuxPaneSnapshot[]`

### Window snapshot

- `windowId`
- `windowIndex`
- `windowName`
- `active`
- `paneIds: string[]`

### Pane snapshot

기존 필드에 다음을 추가한다.

- `windowId`

필수 의미:

- `windows[]`는 session-level topology를 설명한다
- `panes[]`는 pane-level runtime/detail을 설명한다
- `activeWindowId`, `activePaneId`는 항상 `windows[]`, `panes[]`와 정합해야 한다

## emit sequencing

### 원칙

authoritative state emit source는 논리적으로 하나만 둔다.

추천 경로:

```text
tmux control / structural event
  -> proxy capture
  -> Rust cache update
  -> clcomx:tmux/state emit
```

### command handler 역할

`split/select/kill/resize` command handler는 다음만 한다.

- tmux command 전송
- 필요하면 backend cache에 pending intent 메모
- authoritative snapshot emit는 직접 하지 않음

즉 handler가 direct emit를 날리고 proxy도 emit하는 이중 경로를 없앤다.

### structural snapshot capture

proxy의 structural event 처리도 단발 `capture_snapshot()`이 아니라 “settled topology capture”를 해야 한다.

즉 다음 조건이 안정될 때까지 짧게 retry한다.

- pane count
- active window / active pane
- session size

그 뒤 마지막 snapshot 하나만 backend cache에 반영한다.

## frontend state flow

frontend에도 canonical source는 하나만 둔다.

```text
clcomx:tmux/state
  -> tmux session snapshot store
     -> TmuxTerminal render
     -> agent-workspace derive child nodes
     -> App chrome visibility
```

### ownership

- `TmuxTerminal`
  - 사용자 intent 전송
  - shared snapshot 렌더
  - 더 이상 local snapshot owner가 아님
- `agent-workspace`
  - shared snapshot에서 child nodes와 selection을 파생
  - 더 이상 별도 tmux runtime truth를 가지지 않음
- `App`
  - `showAgentWorkspaceChrome`를 shared snapshot 또는 shared snapshot에서 파생된 agent tree 기준으로 계산

## migration 단계

### 1단계: backend contract 확장

- `TmuxSessionSnapshot`에 `revision`, `capturedAt`, `activeWindowId`, `windows[]` 추가
- `TmuxPaneSnapshot`에 `windowId` 추가
- proxy와 Rust capture script 모두 `list-windows` + `list-panes`를 함께 수집

### 2단계: authoritative emit path 단일화

- command handler direct emit 제거
- backend cache + single state emit path로 통일
- structural event capture를 retry/settle 방식으로 변경

### 3단계: frontend canonical snapshot store 추가

- `sessionId -> TmuxSessionSnapshot` shared store 도입
- `TmuxTerminal` local snapshot ownership 제거
- `agent-workspace`는 shared snapshot만 ingest

### 4단계: agent-centric UI 재연결

- compact agent tree visibility는 shared snapshot 파생 child surface 기준
- active node selection도 shared snapshot의 `activePaneId` 기준
- toolbar `panes:N`도 shared snapshot 기준

## 검증 기준

다음이 모두 같아야 한다.

- `TmuxTerminal` pane count
- agent tree child node count
- active pane highlight
- selected agent node

대표 시나리오:

1. single pane start
2. split pane once
3. split pane twice
4. change active pane
5. close pane
6. create / switch tmux window
7. reload / reattach

각 시나리오에서 stale snapshot이 늦게 와도, `revision`이 낮으면 frontend가 무시해야 한다.

## 결론

지금 `panes:1`이 계속 남는 이유는 단순 UI bug가 아니다.

- split 뒤 fresh snapshot 보장이 없고
- snapshot schema가 window를 못 담고
- frontend가 tmux reality를 여러 state graph로 따로 보기 때문이다

다음 구현은 증상 패치가 아니라, 이 문서의 순서대로 `backend snapshot contract -> single emit path -> single frontend snapshot store`를 만드는 방향으로 진행한다.
