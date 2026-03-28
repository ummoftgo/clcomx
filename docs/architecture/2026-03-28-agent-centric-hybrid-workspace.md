# Agent-Centric Hybrid Workspace Redesign

작성일: 2026-03-28
상태: 설계 합의 완료
우선순위: 높음

## 목적

`tmux pane` 자체를 제품 UI의 중심으로 두는 대신, WSL 안에서 실행되는 메인 에이전트와 하위 에이전트의 상태, 활동, 최근 출력/대화를 이해하기 쉬운 형태로 보여주는 방향으로 제품 구조를 재정의한다.

핵심 목표는 다음과 같다.

- 사용자가 메인 에이전트 작업에 계속 집중할 수 있을 것
- 하위 에이전트가 생성되면 구조와 상태를 빠르게 파악할 수 있을 것
- 특정 에이전트가 무엇을 했는지 스크롤로 읽을 수 있을 것
- `tmux`는 실행 인프라로 남기되, UI 중심 개체는 아니게 만들 것

## 문제 재정의

기존 tmux 브랜치는 `pane/session`을 네이티브 UI로 직접 재현하는 방향이었다.

하지만 실제 사용자 목적은 다음과 더 가깝다.

- 하위 에이전트가 몇 개 떠 있는지
- 누가 어떤 작업을 하고 있는지
- 특정 에이전트가 직전에 무엇을 했는지
- 필요할 때 현재 live output을 볼 수 있는지

즉, 사용자가 필요로 하는 것은 `tmux pane 조작`이 아니라 `agent activity observability`다.

## 왜 방향을 바꾸는가

### 1. tmux는 좋은 런타임이지만 좋은 UI 도메인은 아니다

`tmux`는 세션 분기, 복구, attach/detach, pane 단위 실행에는 적합하다.

반면 UI 중심 도메인으로 올리면 다음 문제가 구조적으로 따라온다.

- copy-mode / scroll ownership
- control mode event ordering
- pane geometry / scroll UI 충돌
- `pane`와 실제 `agent task` 의미의 불일치

### 2. 제품 중심 개체가 잘못 잡혀 있었다

기존 tmux UI는 `pane`가 1급 개체였다.

새 설계에서는 다음이 1급 개체가 된다.

- `Agent Session`
- `Agent Node`
- `Activity Event`

이 모델은 `tmux` 외 다른 런타임으로 확장되더라도 유지 가능하다.

### 3. 스크롤 요구도 재분리해야 한다

스크롤은 두 가지 서로 다른 요구를 섞지 않아야 한다.

- `live raw terminal scroll`
- `과거 작업/대화 열람용 timeline scroll`

이 둘을 같은 UI/상태 모델로 풀려고 하면 다시 복잡도가 올라간다.

## 설계 결정

### 1. UI의 1급 개체는 Agent Session과 Agent Node다

#### Agent Session

현재의 탭/세션을 재해석한 상위 개체다.

최소 속성:

- `sessionId`
- `runtimeMode`: `plain | tmux`
- `agentId`
- `distro`
- `workDir`
- `title`
- `resumeToken`
- `tmuxSessionName`
- `pinned`
- `locked`

#### Agent Node

런타임에서 감지된 하위 에이전트 개체다.

최소 속성:

- `id`
- `sessionId`
- `parentId`
- `label`
- `status`
- `surfaceRef`
- `startedAt`
- `lastActiveAt`

### 2. tmux는 실행 인프라로만 남긴다

`tmux`는 다음 역할만 맡는다.

- 하위 실행 surface 분기
- 세션 복구
- runtime 상태 수집
- raw live view 제공

`tmux pane`는 더 이상 제품 UI의 주인공이 아니다.

### 3. 하위 에이전트 생성은 1차에서 앱이 직접 하지 않는다

1차에서는 에이전트가 런타임에서 만든 하위 에이전트를 감지해 등록한다.

즉:

- 앱이 “새 하위 에이전트 생성” 버튼을 제공하지는 않음
- 런타임 이벤트를 보고 `Agent Node`를 등록
- 사용자는 생성된 하위 에이전트를 관찰하고 선택할 수 있음

### 4. 메인 포커스는 항상 메인 에이전트다

하위 에이전트 트리는 존재하되, 메인 에이전트를 밀어내지 않는다.

메인 에이전트가 제품 중심이라는 원칙을 유지한다.

## 추천 UI 구조

추천안은 `Hybrid Activity Workspace`다.

### 메인 레이아웃

- `Main Focus Pane`
  - 메인 에이전트 중심 `activity timeline + live detail`
- `Compact Agent Tree`
  - 좁은 폭의 하위 에이전트 상태 트리
- `Detail Switch`
  - 필요할 때만 하위 에이전트의 최근 출력/상세 보기
- `Raw Runtime View`
  - 기본 숨김
  - debug/고급 보기로만 제공

### Compact Agent Tree 원칙

하위 에이전트 트리는 넓지 않아야 한다.

보여줄 정보:

- 짧은 라벨
- 트리 깊이
- 상태 아이콘/점
- 현재 작업 요약 한 줄 또는 짧은 배지

보여주지 않아도 되는 것:

- 긴 transcript
- pane geometry
- raw terminal 내용 전체

### 중앙 영역

중앙은 “읽는 곳”이어야 한다.

초기에는 다음을 중심으로 둔다.

- 메인 에이전트 activity timeline
- 선택된 에이전트의 최근 활동 로그
- 스크롤 가능한 과거 출력/작업 기록

## 데이터 흐름

### Plain runtime

```text
PTY
  -> pty-output / pty snapshot
  -> activity normalizer
  -> Agent Registry
  -> Activity Timeline
```

### Tmux runtime

```text
tmux -CC
  -> tmux_proxy.py
  -> tmux.rs session cache / snapshot
  -> agent detector / event normalizer
  -> Agent Registry
  -> Activity Timeline

tmux.rs snapshot
  -> optional raw runtime detail view
```

### 중요한 분리

- `Agent Registry`는 제품 상태
- `tmux snapshot`은 런타임 상태
- `Activity Timeline`은 읽기 중심의 사용자 상태

이 셋을 분리한다.

## 하위 에이전트 감지 전략

### 1차

`tmux surface` 또는 runtime 이벤트 기반으로 하위 작업 단위를 감지한다.

초기 구현 목표:

- 새 surface/pane/session 감지
- `current_command`, `current_path`, 생성 시점 기반으로 `Agent Node` 등록
- 부모 세션과 연결

### 2차

출력 패턴이나 런처 규약이 있으면 더 정확한 라벨과 상태를 붙인다.

### 하지 않을 것

- 1차부터 message-level 의미 파싱
- LLM 추론에 의존한 과한 agent meaning reconstruction

## 스크롤 정책

### 제품 중심 스크롤

메인 스크롤 요구는 `Activity Timeline`이 담당한다.

- 과거 작업/대화 읽기
- 최근 출력 추적
- 특정 에이전트 활동 확인

### Raw runtime 스크롤

raw terminal 또는 tmux live view는 보조 기능이다.

- plain runtime: 기존 PTY/xterm 경로 유지
- tmux runtime: backend-owned scroll 유지 가능

즉, scroll UX의 핵심은 raw pane이 아니라 timeline이다.

## 영속 저장 정책

현재 `workspace.json`과 `tab_history.json`은 transcript 저장소가 아니다.

따라서 1차에서는:

- `workspace` / `history`에는 세션 메타만 저장
- transcript 영속화는 하지 않음

2차에서 transcript를 남기려면:

- `workspace.json`이 아니라 별도 append-only store 사용
- 세션별 로그 파일 또는 SQLite 고려

## 단계별 구현 계획

### Phase 1: 모델 정리

- `runtimeMode`를 main 브랜치 세션/히스토리/워크스페이스 모델로 정식 반영
- `Agent Session` / `Agent Node` / `Activity Event` 타입 추가
- 기존 탭 모델을 agent-session 관점으로 재해석

### Phase 2: Agent Registry

- 하위 에이전트 감지기 추가
- session별 agent tree store 추가
- 상태(`running`, `idle`, `done`, `error`) 최소 집합 구현

### Phase 3: Hybrid UI

- `Compact Agent Tree` 추가
- `Activity Timeline` 추가
- 메인 에이전트 중심 레이아웃으로 전환

### Phase 4: Raw View Downgrade

- 현재 tmux pane UI는 주 화면이 아닌 보조/debug view로 이동
- 필요 시 펼쳐서 확인 가능하게만 유지

### Phase 5: Persistent Transcript

- 필요 시 별도 transcript store 도입
- restore/history와 분리된 append-only 로그로 관리

## 성공 기준

다음이 만족되면 1차 목표 달성으로 본다.

- 메인 에이전트 작업이 화면 중심에 유지된다
- 하위 에이전트가 생성되면 자동으로 좁은 트리에 나타난다
- 하위 에이전트 수와 상태를 즉시 파악할 수 있다
- 특정 에이전트의 최근 활동을 스크롤로 읽을 수 있다
- 사용자가 tmux pane 구조를 몰라도 전체 흐름을 이해할 수 있다

## 비목표

1차에서는 다음을 목표로 두지 않는다.

- tmux pane의 완전한 네이티브 UI 재현
- pane geometry를 제품 핵심으로 유지하는 것
- 정교한 copy-mode / rail UX를 제품 중심 기능으로 만드는 것
- message bubble 수준의 대화 구조화
- 앱이 하위 에이전트를 직접 생성/제어하는 것

## 결론

이 프로젝트에서 중요한 것은 `tmux`를 잘 보여주는 것이 아니라 `에이전트가 무엇을 했는지`를 잘 보여주는 것이다.

따라서 장기 기본 방향은 `tmux-centric UI`가 아니라 `agent-centric hybrid workspace`다.
