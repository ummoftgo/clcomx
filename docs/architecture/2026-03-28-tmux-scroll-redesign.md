# Tmux Scroll Redesign Subtask

작성일: 2026-03-28
상태: 재설계 합의 완료, 구현 보류
우선순위: 높음

## 목적

tmux 런타임에서 스크롤 UX를 추가하되, 기존 pane geometry 안정성을 깨지 않는 구조로 다시 설계한다.

이번 문서는 이전 scroll 시도에서 반복 실패한 원인을 추적 가능한 형태로 고정하고, 다음 구현을 위한 제약과 테스트 우선 계획을 정리한다.

## 배경

현재 `feature-tmux-support` 계열 작업은 다음 상태까지 안정화됐다.

- tmux pane grid 렌더
- split / focus / kill
- pane geometry 보정
- pane 활성 표시와 flicker 1차 감소

하지만 scroll 기능은 여러 차례 시도했음에도 안정적으로 닫히지 않았다.

반복된 실패 증상:

- 휠 스크롤이 다른 pane에도 영향
- copy-mode 진입/이탈이 포커스나 타이밍에 따라 꼬임
- rail/thumb가 실제 상태와 맞지 않음
- scroll 시 pane redraw, flicker, geometry mismatch 재발

## 실패 원인 정리

### 1. phase 경계 위반

기존 작업 문서에서는 phase 1을 `visible screen only`로 고정하고, scroll/history/rail/copy-mode는 뒤로 미루도록 정리돼 있었다.

하지만 실제 구현은 geometry와 pane lifecycle이 완전히 닫히기 전에 scroll 관련 실험을 계속 섞었다.

그 결과:

- geometry 문제
- lifecycle 문제
- scroll 문제

가 한꺼번에 겹쳐 원인 분리가 어려워졌다.

### 2. 현재 렌더러는 scroll 렌더러가 아니다

현재 [`TmuxTerminal.svelte`](/home/xenia/work/claudemx/src/lib/components/TmuxTerminal.svelte)는 pane별 `screenText`를 받아 `reset + visible screen redraw` 하는 구조다.

이 구조는 split / restore / focus에는 맞지만, scroll처럼 연속 상태 변화가 많은 경로에는 맞지 않는다.

scroll 1틱마다 다음이 반복되기 쉽다.

- tmux command
- snapshot recapture
- pane redraw

그래서 flicker와 race가 쉽게 생긴다.

### 3. scroll state ownership이 분산돼 있었다

실패한 시도에서는 다음이 동시에 scroll 상태에 개입했다.

- tmux 자체 copy-mode state
- backend explicit snapshot emit
- proxy/controller state emit
- frontend optimistic copy-mode state
- frontend rail/thumb state

이 구조에서는 pane 수가 늘어나거나 state 반영 순서가 달라질 때 같은 증상이 반복될 수밖에 없다.

### 4. rail이 실제 scroll state를 기반으로 하지 않았다

현재 snapshot에는 pane별 실제 `scrollPosition`, `atBottom`, session-level scroll owner가 없다.

즉 rail/thumb는 실제 상태를 반영할 수 없고, 추정 UI가 될 수밖에 없다.

### 5. geometry와 scroll UI가 얽혀 있었다

scrollbar, rail, padding, gutter를 pane viewport 안쪽에서 해결하려고 하면 실제 content box가 바뀌고 `delta`가 다시 흔들린다.

지금 구조에서 geometry와 scroll UI를 동시에 만지면 같은 회귀가 다시 열릴 가능성이 높다.

## 외부 사례 조사 결론

가장 가까운 방향은 `tmux -CC` 기반 pane/session ownership을 tmux가 유지하고, 앱은 native shell 역할을 하는 방식이다.

비교 대상:

- iTerm2 tmux integration
- WindTerm tmux integration

반대로 WezTerm은 자체 multiplexer를 가지므로 scrollback/copy/search 전체를 앱이 소유한다. 이 프로젝트와는 모델이 다르다.

정리하면 이 프로젝트는 WezTerm식 로컬 scrollback 모델보다, tmux ownership을 유지하는 iTerm2/WindTerm 계열에 더 가깝다.

## 설계 결정

### 1. scroll source of truth는 backend 하나만 가진다

scroll/copy-mode semantics는 Rust backend가 소유한다.

역할 분리:

- Rust `tmux.rs`: scroll ownership, tmux command transaction, snapshot capture
- Python `tmux_proxy.py`: control mode transport adapter
- Svelte `TmuxTerminal.svelte`: intent routing + state rendering

frontend가 tmux semantics를 추정하지 않는다.

### 2. xterm local scrollback은 다시 쓰지 않는다

`scrollback: 0`은 유지한다.

다시 넣지 않을 것:

- xterm local scrollback
- `historyText` replay 기반 local scroll
- frontend optimistic copy-mode state

### 3. 한 번에 한 pane만 scroll owner가 된다

tmux 자체는 여러 pane이 동시에 copy-mode일 수 있지만, 앱 정책은 다르게 둔다.

앱 정책:

- scroll owner pane은 한 번에 하나
- 새 pane에서 scroll하면 이전 scroll owner는 backend가 정리

이 exclusivity policy는 frontend가 아니라 backend가 강제한다.

### 4. rail은 실제 scroll state가 생기기 전까지 단순 조작 UI로 제한한다

초기 rail 정책:

- 항상 보이는 얇은 rail 허용 가능
- click upper half => scroll up
- click lower half => scroll down
- copy-mode active 정도만 표시

아직 하지 않을 것:

- 정밀 thumb 위치
- absolute scroll position indicator
- drag thumb

이건 snapshot에 실제 scroll 위치가 들어온 뒤에만 가능하다.

### 5. geometry 경로는 그대로 둔다

scroll 구현 때문에 pane viewport geometry를 바꾸지 않는다.

금지:

- viewport 내부 padding
- rail 때문에 content box 축소
- scroll UI 때문에 `delta` 보정 추가

scroll UI는 geometry에 영향 없는 레이어로 다룬다.

## 권장 아키텍처

### Backend-owned atomic scroll command

scroll 관련 동작은 잘게 쪼갠 여러 command가 아니라 원자 command로 묶는다.

권장 command surface:

- `tmux_scroll_pane(sessionId, paneId, direction)`
- `tmux_cancel_scroll_mode(sessionId, paneId)`

`tmux_scroll_pane` 내부 책임:

1. 현재 scroll owner 파악
2. target이 아니고 copy-mode인 pane 정리
3. target pane를 필요 시 copy-mode 진입
4. up/down 명령 수행
5. snapshot 재수집
6. state emit

핵심은 scroll 1회 동작을 backend transaction 하나로 보장하는 것이다.

### Snapshot 확장

MVP에서 최소 필요 상태:

- pane별 `inCopyMode`
- session-level `copyModePaneId`

후속 확장 후보:

- pane별 `scrollPosition`
- pane별 `atBottom`

## 구현 전에 고정할 제약

- scroll state owner는 backend 하나만
- proxy와 backend explicit emit 중 scroll state path는 논리적으로 하나만
- frontend는 optimistic scroll state를 두지 않음
- xterm local scrollback 금지
- geometry-affecting rail/padding/gutter 금지
- rail은 실제 scroll position 없이는 정밀 thumb 금지

## 테스트 우선 계획

구현보다 먼저 자동 검증 축을 만든다.

### 1. backend 단위 테스트

대상:

- scroll owner 전환 로직
- target pane 외 copy-mode 정리 정책
- cancel on input 정책
- snapshot state mapping

최소 검증:

- 한 pane scroll 시 다른 pane이 owner로 남지 않음
- cancel 후 `copyModePaneId == null`
- split 상태에서도 target pane만 scroll owner가 됨

### 2. frontend 최소 행위 테스트

대상:

- wheel / `PageUp` / `PageDown` intent routing
- 일반 입력 전 cancel path 호출
- rail click이 up/down intent로만 매핑되는지

중요한 점:

frontend는 scroll state를 계산하지 않고 intent만 보낸다는 점을 테스트로 고정한다.

### 3. 수동 검증 체크리스트

필수 시나리오:

1. 단일 pane에서 휠 업/다운
2. split pane 상태에서 한 pane만 scroll
3. 다른 pane으로 포커스 이동 후 다시 scroll
4. copy-mode 중 일반 문자 입력 후 shell 입력 복귀
5. rail 클릭으로 up/down 이동
6. scroll 도중 geometry `delta` 유지

### 4. 종료 조건

다음이 모두 만족돼야 다음 단계로 넘어간다.

- 한 pane의 scroll이 다른 pane에 영향을 주지 않는다
- copy-mode 진입/이탈이 포커스 loss/gain에 의존하지 않는다
- 일반 입력이 항상 shell 입력으로 안정 복귀한다
- split 상태에서도 같은 증상이 반복되지 않는다
- scroll 구현이 geometry `delta`를 다시 깨지 않는다

## 구현 순서 제안

1. scroll 관련 현재 실패 내역을 이 문서 기준으로 고정
2. backend atomic scroll contract 추가
3. backend 단위 테스트 추가
4. frontend에서 optimistic state 제거
5. wheel / key / rail intent를 backend contract에만 연결
6. 수동 검증으로 split pane isolation 확인
7. 필요 시 snapshot에 real scroll position 추가

## 이번 단계에서 하지 않을 것

- local scrollback 복원
- rail thumb drag
- 정확한 scroll thumb 위치 표시
- copy-mode selection / search / copy UX
- geometry 보정을 동반하는 scroll UI

## 참고 문서

기존 작업 메모:

- `docs/plans/2026-03-25-tmux-visible-screen-only-stabilization-design.md`
- `docs/plans/2026-03-27-tmux-stabilization-research-design.md`
- `docs/plans/2026-03-27-tmux-copy-mode-scroll-design.md`
- `docs/plans/2026-03-28-tmux-scroll-redesign.md`

이 문서는 위 문서들의 결론을, git에 추적되는 위치로 다시 정리한 기준 문서다.
