# Agent-Centric Workspace Checkpoint

작성일: 2026-03-28
상태: WIP 체크포인트
브랜치 목적: tmux pane UI 중심에서 agent-centric workspace로 전환하는 중간 저장점

## 이번 체크포인트의 방향

이 브랜치는 `tmux pane 자체를 그대로 UI 중심에 두는 접근`에서 벗어나, `메인 에이전트 중심 + 하위 에이전트 관찰` 구조로 옮기기 위한 중간 저장점이다.

핵심 원칙:

- 메인 에이전트가 항상 중심
- 하위 에이전트는 좁은 트리에서 상태만 파악
- 필요할 때만 특정 하위 에이전트의 pane을 중앙에서 본다
- tmux는 실행 인프라이고, 제품 UI의 중심 개체는 아니다

## 현재까지 반영된 것

### 1. backend tmux snapshot 계약 확장

- `TmuxSessionSnapshot`에 `revision`, `capturedAt`, `activeWindowId`, `windows[]` 추가
- `TmuxPaneSnapshot`에 `windowId` 추가
- proxy structural state는 단발 capture 대신 topology settle retry를 거치게 변경
- tmux split/window 변화가 stale `panes:1`로 남는 문제를 줄이기 위한 기초 계약을 반영

관련 파일:

- [tmux.rs](/home/xenia/work/claudemx/.worktrees/feature-scratch/src-tauri/src/commands/tmux.rs)
- [tmux_proxy.py](/home/xenia/work/claudemx/.worktrees/feature-scratch/src-tauri/scripts/tmux_proxy.py)
- [tmux.ts](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/tmux.ts)

### 2. shared frontend tmux snapshot store 도입

- `sessionId -> TmuxSessionSnapshot` shared store 추가
- agent workspace는 이 shared snapshot을 기반으로 child agent를 파생
- `TmuxTerminal`은 local snapshot owner가 아니라 shared snapshot을 읽어 렌더

관련 파일:

- [tmux-snapshots.svelte.ts](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/stores/tmux-snapshots.svelte.ts)
- [App.svelte](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/App.svelte)
- [agent-workspace.svelte.ts](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/stores/agent-workspace.svelte.ts)
- [TmuxTerminal.svelte](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/components/TmuxTerminal.svelte)

### 3. agent-centric UI 1차 전환

- `CompactAgentTree` 추가
- agent workspace store 추가
- 하위 pane을 child agent node로 표시
- plain 탭에는 이 UI가 보이지 않게 분기

관련 파일:

- [CompactAgentTree.svelte](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/components/CompactAgentTree.svelte)
- [agent-workspace.svelte.ts](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/stores/agent-workspace.svelte.ts)
- [agent-workspace.ts](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/agent-workspace.ts)

### 4. 최근 UX 수정

- 우측 `ActivityPane` 제거
- 좌측 트리 클릭으로 중앙 runtime이 메인/root 또는 선택한 child agent pane으로 전환
- 이 전환은 `명시적 클릭`일 때만 일어나고, tmux active pane 변화가 자동으로 selection을 덮지 않게 변경
- agent-centric 모드에서는 중앙 raw terminal이 선택된 pane 하나만 렌더하고, 숨겨진 child pane terminal/focus/output buffering은 끊음

관련 파일:

- [App.svelte](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/App.svelte)
- [agent-workspace.svelte.ts](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/stores/agent-workspace.svelte.ts)
- [TmuxTerminal.svelte](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/components/TmuxTerminal.svelte)

## 현재 남아 있는 이슈

- [`TmuxTerminal.svelte`](/home/xenia/work/claudemx/.worktrees/feature-scratch/src/lib/components/TmuxTerminal.svelte) 의 pane `<section>` click a11y 경고 1건
- Rust tmux command 파일에 미사용 helper 경고가 남아 있음
- `npm run check:frontend`는 현재 dependency stack의 `svelte-check + TypeScript 6` 호환성 문제 때문에 앞단에서 `TypeError: forEachResolvedModule is not a function`를 출력함
  - 다만 `vite build`는 성공
- 이번 변경은 아직 수동 UX 검증을 충분히 거치지 않았고, 현재는 WIP 저장 목적의 체크포인트임

## 최근 검증 결과

성공:

- `cargo test --manifest-path src-tauri/Cargo.toml tmux -- --nocapture`
- `npm run test`
- `npx vite build`
- `bash scripts/build-dev.sh`

추가 메모:

- `build-dev.sh`는 최신 `clcomx.exe` launch까지 완료함
- `src-tauri/scripts/__pycache__/`는 검증 중 생성된 산출물이며 커밋 대상에서 제외 가능

## 다음 권장 작업

1. 좌측 트리에서 root/child를 클릭할 때 중앙 raw terminal 전환 UX를 실제 앱에서 재검증
2. tree의 selected state와 runtime active state를 시각적으로 더 명확히 분리할지 결정
3. a11y 경고와 Rust dead-code 경고 정리
4. 이 브랜치를 원격에 올릴지, 아니면 추가 정리 후 squash할지 결정
