# Next Refactor Plan

작성일: 2026-04-25
갱신일: 2026-04-25
상태: active
용도: 현재 코드 기준 남은 리팩토링 후보와 진행 순서를 정리한 단일 작업 계획

주의:
- 이 문서는 로컬 작업 계획입니다.
- 코드 변경 전에 이 문서를 기준으로 작업 범위와 제외 범위를 다시 확인합니다.
- 커밋은 사용자가 명시적으로 요청할 때만 진행합니다.
- 서로 다른 도메인의 리팩토링을 한 변경셋으로 묶지 않습니다.

## 현재 상태 요약

최근 리팩토링 흐름은 대형 Svelte 컴포넌트와 runtime shim에서 도메인 책임을 `features/*`, `editor/*`, `preview/*`, `terminal/*` 하위 controller, state, view, helper로 옮기는 방향이었습니다.

완료된 주요 흐름:
- `Terminal.svelte`의 embedded editor surface, assist/aux/draft stack, overlay stack, loading overlay, renderer helper, DOM helper, aux resize controller, paint helper, shortcut routing 분리
- `App.svelte`의 startup, window close, rename, move, preview overlay, dialog stack 관련 controller/view 분리
- `preview/runtime.ts`의 editor file cache, history commands, presets, bridge commands 분리
- session, session-tabs, launcher controller, workspace autosave 등의 feature 경계 정리

현재 큰 파일:
- `src/lib/editor/navigation.ts` 약 1406줄
- `src/lib/features/launcher/view/SessionLauncher.svelte` 약 1405줄
- `src/lib/components/Terminal.svelte` 약 1284줄
- `src/App.svelte` 약 928줄
- `src/lib/terminal/file-links.ts` 약 698줄
- `src/lib/features/terminal/controller/main-terminal-runtime-controller.ts` 약 588줄
- `src/lib/preview/presets.ts` 약 556줄

현재 판단:
- `Terminal.svelte`는 아직 크지만 남은 부분이 xterm, PTY, editor orchestration에 가깝습니다. 당분간 큰 파일 줄이기 목적의 추가 분리는 보류합니다.
- `preview/runtime.ts`는 이미 227줄 수준의 facade로 축소됐으므로 기존 우선순위에서 제외합니다.
- 다음 최우선 대상은 순수 함수 비중이 높고 테스트가 있는 `src/lib/editor/navigation.ts`입니다.
- 그 다음은 view markup/CSS가 큰 `SessionLauncher.svelte`입니다.
- 세 번째는 순수 파싱과 xterm buffer projection이 섞인 `terminal/file-links.ts`입니다.

## 한 번에 처리 가능 여부

결론: 1, 2, 3순위를 한 번에 처리하지 않습니다.

이유:
- `navigation.ts`는 editor heuristic engine으로 순수 TS 테스트 중심입니다.
- `SessionLauncher.svelte`는 Svelte view 구조와 CSS 회귀가 중심입니다.
- `file-links.ts`는 terminal output path parser와 xterm buffer link projection이 중심입니다.
- 세 영역을 한 변경셋으로 묶으면 실패 원인과 runtime 회귀 범위를 좁히기 어렵습니다.

진행 방식:
- 한 번에 하나의 도메인만 변경합니다.
- 각 도메인 안에서도 가능한 한 parser/helper/view subcomponent 단위로 작게 나눕니다.
- 각 슬라이스는 해당 단위 테스트와 `npm run check:frontend`, `git diff --check`로 닫습니다.
- 앱 실행 검증은 사용자가 명시적으로 요청할 때만 진행합니다.

## 우선순위 1: Editor navigation engine 분리

목표:
- `src/lib/editor/navigation.ts`의 언어별 parser, path resolver, symbol collector를 작은 순수 모듈로 분리합니다.
- public API는 유지합니다.

대상:
- `src/lib/editor/navigation.ts`
- 새 후보: `src/lib/editor/navigation/js-imports.ts`
- 새 후보: `src/lib/editor/navigation/php-includes.ts`
- 새 후보: `src/lib/editor/navigation/symbols.ts`
- 새 후보: `src/lib/editor/navigation/path-resolution.ts`

권장 슬라이스:
1. JS/TS import/export parsing helper 분리
2. PHP include expression evaluator/path resolver 분리
3. symbol collection/dedup helper 분리
4. 최종 facade 정리

유지할 범위:
- `findHeuristicDefinition`
- `findFastHeuristicDefinition`
- `findLineFastHeuristicDefinition`
- `collectHeuristicDocumentSymbols`
- 기존 import 경로와 public type export

주의:
- 의미 있는 도메인 경계로만 나눕니다. 단순 줄 수 줄이기식 helper 쪼개기는 피합니다.
- PHP include expression은 edge case가 많으므로 독립 테스트 없이 크게 이동하지 않습니다.
- Monaco/editor adapter import 경로 변경은 최소화합니다.

완료 기준:
- `navigation.ts`가 facade와 orchestration 중심으로 줄어듭니다.
- 기존 navigation behavior가 유지됩니다.

권장 테스트:
- `npm run test -- src/lib/editor/navigation.test.ts`
- `npm run test -- src/lib/features/editor/controller/editor-navigation-adapter-controller.test.ts`
- `npm run check:frontend`
- `git diff --check`

## 우선순위 2: SessionLauncher view 분리

목표:
- `SessionLauncher.svelte`의 home/browser/picker/dialog markup을 view subcomponent로 나눕니다.
- launcher controller와 persistence 동작은 유지합니다.

대상:
- `src/lib/features/launcher/view/SessionLauncher.svelte`
- 새 후보: `src/lib/features/launcher/view/LauncherHomeView.svelte`
- 새 후보: `src/lib/features/launcher/view/LauncherDirectoryBrowser.svelte`
- 새 후보: `src/lib/features/launcher/view/LauncherAgentPicker.svelte`
- 새 후보: `src/lib/features/launcher/view/LauncherDistroPicker.svelte`
- 새 후보: `src/lib/features/launcher/view/LauncherHistoryDeleteDialog.svelte`

권장 슬라이스:
1. history delete dialog view 분리
2. agent/distro picker overlay view 분리
3. home recent-list view 분리
4. directory browser view 분리

유지할 범위:
- `createSessionLauncherController`
- history deletion persistence
- directory navigation state transitions
- keyboard handler ownership

주의:
- history 삭제는 기존처럼 exact entry 하나만 삭제해야 합니다.
- app-native `ModalShell` 확인 UX를 유지합니다.
- CSS 이동은 한 번에 크게 하지 말고, view 분리와 함께 필요한 최소 범위만 옮깁니다.

완료 기준:
- `SessionLauncher.svelte`는 state/controller wiring과 view composition 중심으로 줄어듭니다.
- home, browser, picker, delete dialog 동작이 기존과 동일합니다.

권장 테스트:
- `npm run test -- src/lib/features/launcher/controller/session-launcher-controller.test.ts`
- 새 view 테스트가 생기면 해당 테스트
- `npm run check:frontend`
- `git diff --check`

## 우선순위 3: Terminal file link parser/projection 분리

목표:
- `src/lib/terminal/file-links.ts`에서 path candidate extraction/normalization과 xterm buffer projection을 분리합니다.

대상:
- `src/lib/terminal/file-links.ts`
- 새 후보: `src/lib/terminal/file-link-candidates.ts`
- 새 후보: `src/lib/terminal/file-link-normalize.ts`
- 새 후보: `src/lib/terminal/file-link-buffer.ts`

권장 슬라이스:
1. candidate extraction/normalization pure helper 분리
2. traceback/quoted/bracketed candidate detector 분리
3. xterm wrapped line snapshot/projection helper 분리
4. `createTerminalFileLinks` facade 정리

유지할 범위:
- `extractTerminalFileLinkCandidates`
- `createTerminalFileLinks`
- 기존 public interface
- hover/leave/open callback behavior

주의:
- terminal output 링크는 실제 xterm buffer coordinate와 연결되므로 projection 로직은 별도 테스트가 충분할 때만 이동합니다.
- candidate parser와 xterm projection을 한 슬라이스로 섞지 않습니다.

완료 기준:
- parser와 xterm adapter 책임이 분리됩니다.
- 기존 file link detection behavior가 유지됩니다.

권장 테스트:
- `npm run test -- src/lib/terminal/file-links.test.ts`
- `npm run check:frontend`
- `git diff --check`

## 보류 항목

### `src/lib/components/Terminal.svelte`

보류 이유:
- overlay, loading, renderer, DOM helper, aux resize, paint, shortcut routing은 이미 분리됐습니다.
- 남은 `onMount`, xterm lifecycle, PTY attach/resize, aux layout settle, editor orchestration은 회귀 위험이 높습니다.
- 명확한 pure helper나 버그 수정 계기가 있을 때만 작은 슬라이스로 다룹니다.

### `src/App.svelte`

보류 이유:
- dialog stack과 주요 orchestration controller가 이미 분리됐습니다.
- 남은 코드는 window/session lifecycle 중심이라 검증 범위가 넓습니다.

### `src/lib/preview/runtime.ts`

보류 이유:
- runtime facade는 이미 충분히 작아졌습니다.
- 추가 후보는 `preview/presets.ts` 내부 데이터 factory 분리이지만 제품 코드 회귀 위험 대비 우선순위는 낮습니다.

### Rust backend 대형 파일

보류 이유:
- `settings`, `terminal`, `editors/path_resolution`에 큰 파일이 남아 있지만 현재 이어가던 작업 흐름은 frontend domain separation입니다.
- backend는 별도 목표가 생길 때 독립적으로 다루는 편이 안전합니다.

## 검증 메모

확인된 기준:
- `node`: `/home/xenia/.nvm/versions/node/v24.11.1/bin/node`
- `npm`: `/home/xenia/.nvm/versions/node/v24.11.1/bin/npm`
- `svelte-check`: `4.4.5`

기본 검증:
- 단위 테스트: 변경 도메인별 테스트
- 통합 frontend check: `npm run check:frontend`
- whitespace check: `git diff --check`
- runtime build/run: 사용자가 명시적으로 요청할 때 `bash scripts/build-dev.sh`
