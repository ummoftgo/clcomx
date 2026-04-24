# Next Refactor Plan

작성일: 2026-04-25
상태: active
용도: 남은 리팩토링 후보를 현재 코드 기준으로 정리한 단일 작업 계획

주의:
- 이 문서는 로컬 작업 계획입니다.
- 이전 `.agent-works`의 임시 분석/리뷰 문서를 대체합니다.
- 코드 변경 전에 이 문서를 기준으로 작업 범위와 제외 범위를 다시 확인합니다.
- 커밋은 사용자가 명시적으로 요청할 때만 진행합니다.

## 현재 상태 요약

최근 리팩토링 흐름은 대형 Svelte 컴포넌트에서 도메인 책임을 `features/*` 하위 controller, state, view로 옮기는 방향이었습니다.

완료된 주요 흐름:
- `App.svelte`의 startup, window close, rename, move, preview overlay 관련 controller 분리
- `Terminal.svelte`의 main runtime, aux runtime core, editor integration, embedded editor surface, assist/aux/draft stack 분리
- session, session-tabs, launcher, workspace autosave 등의 feature 경계 정리

현재 큰 파일:
- `src/lib/components/Terminal.svelte` 약 1673줄
- `src/lib/editor/navigation.ts` 약 1406줄
- `src/lib/features/launcher/view/SessionLauncher.svelte` 약 1405줄
- `src/lib/preview/runtime.ts` 약 1259줄
- `src/App.svelte` 약 1133줄

현재 판단:
- 다음 최우선 대상은 `Terminal.svelte`입니다.
- `App.svelte`는 controller 분리가 많이 진행되어 이제 dialog/view stack 분리가 다음 후보입니다.
- `preview/runtime.ts`는 크지만 preview shim으로 고립되어 있어 Terminal 다음 순서가 적절합니다.
- `navigation.ts`와 `SessionLauncher.svelte`는 크지만 현재 응집도가 비교적 높아 우선순위를 낮춥니다.

## 우선순위 1: Terminal overlay/modal stack 분리

목표:
- `src/lib/components/Terminal.svelte`에 남은 overlay, modal, terminal runtime view 조립을 terminal feature view로 이동합니다.

대상:
- `src/lib/components/Terminal.svelte`
- 새 후보: `src/lib/features/terminal/view/TerminalRuntimeSurface.svelte`
- 새 후보: `src/lib/features/terminal/view/TerminalOverlayStack.svelte`
- 기존 활용: `src/lib/features/terminal/view/TerminalInterruptConfirmModal.svelte`
- 기존 활용: `src/lib/features/terminal/view/TerminalAssistStack.svelte`

옮길 수 있는 범위:
- main terminal output markup
- spawn error 표시
- clipboard notice 표시
- main terminal loading overlay markup
- `ContextMenu`
- `ImagePasteModal`
- `EditorPickerModal`
- `TerminalInterruptConfirmModal` 조립

유지할 범위:
- xterm `Terminal` 인스턴스 생성
- `FitAddon`, `WebLinksAddon`, `WebglAddon` 연결
- PTY attach/spawn/resize
- `onMount`, `onDestroy`의 runtime listener 등록/해제
- `createTerminalFileLinks` provider 등록
- main/aux terminal layout sync

이유:
- 가장 최근 커밋이 `TerminalAssistStack` 분리였고, 그 다음 자연스러운 조립면은 overlay/modal stack입니다.
- controller는 이미 `overlay-interaction-controller`에 있으므로 이번 슬라이스는 view 조립 분리만으로 작게 유지할 수 있습니다.
- runtime ownership을 건드리지 않으면 회귀 위험을 낮출 수 있습니다.

완료 기준:
- `Terminal.svelte`는 runtime wiring과 dependency injection 중심으로 축소됩니다.
- overlay/modal 관련 markup은 terminal feature view에서 테스트 가능합니다.
- 기존 link menu, clipboard image, editor picker, Ctrl+C interrupt 동작은 변경하지 않습니다.

권장 테스트:
- 새 view 컴포넌트 단위 테스트
- 기존 `TerminalInterruptConfirmModal.test.ts`
- overlay 관련 controller 테스트
- 가능하면 `npm run test -- src/lib/features/terminal`
- 최종 단계에서 `npm run check:frontend`

## 우선순위 2: Terminal loading overlay 공통화

목표:
- main terminal loading overlay와 aux terminal loading overlay의 중복 markup/CSS를 공통 컴포넌트로 정리합니다.

대상:
- `src/lib/components/Terminal.svelte`
- `src/lib/features/terminal/view/TerminalAssistStack.svelte`
- 새 후보: `src/lib/features/terminal/view/TerminalLoadingOverlay.svelte`

옮길 수 있는 범위:
- `terminal-connect-overlay`
- `terminal-connect-card`
- eyebrow/title/hint/dots/bar 구조
- compact/subpanel variant

주의:
- main overlay에는 progress bar가 있고 aux overlay에는 compact variant가 있으므로 props로 차이를 표현합니다.
- 첫 번째 슬라이스와 함께 하지 말고 별도 커밋 단위로 분리하는 편이 안전합니다.

완료 기준:
- loading overlay CSS 중복이 제거됩니다.
- main/aux loading 문구와 variant는 그대로 유지됩니다.

## 우선순위 3: App dialog view stack 분리

목표:
- `src/App.svelte`에 남은 close/dirty/rename dialog markup을 app-shell view 컴포넌트로 이동합니다.

대상:
- `src/App.svelte`
- 새 후보: `src/lib/features/app-shell/view/AppDialogStack.svelte`

옮길 수 있는 범위:
- dirty tab close dialog
- clean tab close dialog
- dirty app close dialog
- dirty window close dialog
- close window dialog
- rename dialog
- `getDirtyCloseDialogCopy` 또는 이에 준하는 copy helper

유지할 범위:
- `windowCloseDialogController`
- `tabCloseOrchestration`
- `tabRenameOrchestration`
- `windowRenameOrchestration`
- window/session side effect orchestration

이유:
- controller 분리는 이미 상당히 진행되었습니다.
- 이제 남은 큰 부분은 view 조립과 modal copy입니다.

완료 기준:
- `App.svelte`는 shell composition, controller wiring, top-level layout 중심으로 더 명확해집니다.
- dialog 동작은 기존 `App.test.ts` smoke를 그대로 통과합니다.

## 우선순위 4: Preview runtime 분리

목표:
- `src/lib/preview/runtime.ts`를 preview preset/bootstrap, editor file cache, history commands, Tauri bridge shim으로 나눕니다.

권장 분리:
- `src/lib/preview/presets.ts`
- `src/lib/preview/editor-files.ts`
- `src/lib/preview/history.ts`
- `src/lib/preview/bridge.ts`
- `src/lib/preview/runtime.ts`는 public facade로 유지

주의:
- public export인 `installBrowserPreviewRuntime`, `isBrowserPreview`, `getAvailablePreviewPresets`, `getActivePreviewPresetId`, `applyPreviewPreset`, `previewInvoke`, `previewListen`, `previewEmitTo`, `previewGetCurrentWindow`, `previewCurrentMonitor`는 유지합니다.
- `src/lib/tauri/*`, `App.svelte`, `PreviewControlPanel.svelte`의 import 경로 변화는 최소화합니다.

완료 기준:
- `runtime.test.ts`가 기존 behavior를 유지합니다.
- preview preset 전환, editor file read/write, history command, event bridge가 기존과 동일하게 동작합니다.

## 보류 항목

### `src/lib/editor/navigation.ts`

보류 이유:
- 파일은 크지만 heuristic navigation 엔진으로 응집도가 높습니다.
- 지금 나누면 의미 있는 도메인 경계보다 parser helper 쪼개기에 가까울 수 있습니다.
- navigation 동작 변경이나 테스트 보강 작업이 생길 때 함께 분리하는 편이 안전합니다.

### `src/lib/features/launcher/view/SessionLauncher.svelte`

보류 이유:
- 파일은 크지만 controller 분리는 이미 되어 있고 대부분 markup/CSS입니다.
- Terminal/App보다 경계 혼합 위험이 낮습니다.
- 나중에 `LauncherHomeView`, `LauncherDirectoryBrowser`, `LauncherPickerOverlay` 정도로 나눌 수 있습니다.

### Rust backend 대형 파일

보류 이유:
- `settings`, `terminal`, `editors/path_resolution`에 큰 파일이 남아 있지만 현재 이어가던 작업 흐름은 frontend domain separation입니다.
- backend는 별도 목표가 생길 때 독립적으로 다루는 편이 안전합니다.

## 검증 메모

2026-04-25 기준 WSL login shell에서 nvm 초기화가 되도록 `/home/xenia/.profile`을 보강했습니다.

확인된 기준:
- `node`: `/home/xenia/.nvm/versions/node/v24.11.1/bin/node`
- `npm`: `/home/xenia/.nvm/versions/node/v24.11.1/bin/npm`
- `svelte-check`: `4.4.5`

따라서 다음 리팩토링 구현 시 `npm run test`, `npm run check:frontend` 검증이 가능합니다.
