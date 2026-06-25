# Frontend Architecture Research — Direct Agent Runtime

> **⚠️ 스냅샷 — 코드 현실의 *시점* 매핑**: 이 문서는 아래 git ref 시점의 frontend 코드 구조를 박제한 조사 스냅샷이다. 코드가 바뀌면 낡을 수 있으므로 **충돌 시 실제 코드(`src/`)가 정본이고 이 문서가 아니다.** 인용된 경로·심볼·줄번호는 실제 코드와 대조한 뒤 사용한다.

> 조사 대상 ref: `git e7a5f9e` (`v0.6.0-3-ge7a5f9e`, branch `feat/claude-tui-fullscreen-option`)
> 저장소 루트: `/home/melbin/work/clcomx`
> 스택: Tauri v2 + Svelte 5 (runes), TypeScript, Vite, Vitest, svelte-i18n
> 본 문서의 모든 경로는 저장소 루트 기준 상대경로이며, 인용한 심볼/시그니처는 위 ref에서 실제 파일을 읽어 확인한 사실(confirmed)이다. 추정에는 명시적으로 "추정"이라고 표기한다.

---

## 0. 요약 (TL;DR)

CLCOMX 프론트엔드는 `src/lib/features/<feature>/{view,controller,state,contracts,service,navigation}` 형태의 **레이어 분리 feature 모듈** 규약을 따른다. 화면(`.svelte`)은 거의 로직이 없는 view이고, 모든 동작은 `create*Controller(deps)` 팩토리(순수 TS, DI 기반)와 `create*State()`(룬 `$state` 기반 class instance)로 분리된다. 세션 1개당 1개의 host 컴포넌트(`Terminal.svelte`)가 lazy-load되어 `SessionShell.svelte` → `SessionViewport.svelte`에서 `{#each sessions}`로 동시 mount되고, 활성 탭만 `visible`이며 나머지는 CSS `display:none`으로 유지된다.

Direct Agent Runtime의 transcript surface는 **새 `src/lib/features/agent-runtime/` feature 모듈**로 추가하고, 기존 terminal surface는 그대로 두되 **session 단위(또는 새 runtime-kind 필드 단위)로 host 컴포넌트를 분기**하는 것이 가장 적은 회귀로 통합하는 길이다. 분기 지점은 세 곳 중 하나다: (a) `SessionViewport.svelte`의 `SessionShellComponent` 선택, (b) `SessionShell.svelte` 내부에서 `Terminal.svelte` vs 새 `AgentRuntimeShell.svelte` 선택, (c) `App.svelte`의 `loadSessionShellComponent()` loader 분기. **(b)가 기존 contract(`SessionShellProps`/`SessionHostProps`)를 가장 적게 흔든다** (3.2절).

---

## 1. Feature 모듈 레이어 규약 (confirmed)

### 1.1 디렉토리 구조 사실

`src/lib/features/` 아래 7개 feature가 존재한다 (`find src/lib/features -maxdepth 2 -type d` 결과 기반):

| feature | 보유 레이어 디렉토리 | 비고 |
|---|---|---|
| `terminal` | `view/`, `controller/`, `state/` | contracts는 `session/contracts`에 위치(`SessionHostProps`). 가장 큰 feature |
| `session` | `view/`, `controller/`, `state/`, `service/`, `contracts/` | 모든 레이어를 다 가진 reference 모듈 |
| `session-tabs` | `view/`, `controller/`, `contracts/` | state 없음(상태는 live-session-store에 위임) |
| `launcher` | `view/`, `controller/`, `contracts/` | state는 controller 파일 내부 `createSessionLauncherState()` |
| `app-shell` | `view/`, `controller/` | 다수의 orchestration controller |
| `workspace` | `controller/` + 루트 직속 `*.svelte.ts` | persistence/snapshot 로직 |
| `editor` | `view`는 terminal feature에 있고 `controller/`, `service/`, `state/`, `navigation/` | terminal에 임베드된 Monaco editor |

### 1.2 레이어별 역할과 네이밍 규약 (confirmed)

- **view (`*.svelte`)**: 거의 로직 없음. props 정의 + 자식 컴포넌트 wiring. 예: `TerminalRuntimeSurface.svelte`는 `Props` interface와 `$props()` 구조분해, `$bindable()` 사용만 있고 동작은 전부 부모에서 콜백으로 받음. `SessionShell.svelte`는 단 11줄(`src/lib/features/session/view/SessionShell.svelte`).
- **controller (`*-controller.ts` 또는 `*-controller` 함수)**: `export function create<Name>Controller(deps: <Name>Dependencies)` 팩토리 패턴. 의존성은 전부 **getter/콜백 함수로 주입**(DI). 반환값은 메서드 객체. 룬을 직접 쓰지 않고 `deps.state` 또는 getter/setter로 상태를 만짐 → 순수 TS로 vitest 단위 테스트 가능. 예: `createMainTerminalRuntimeController(deps)` (`src/lib/features/terminal/controller/main-terminal-runtime-controller.ts:68`).
- **state (`*-state.svelte.ts`)**: 룬 `$state`를 멤버로 가진 class를 정의하고 `create<Name>State(): <Name>State` 팩토리로 instance를 반환. interface와 impl class를 분리. 예: `src/lib/features/terminal/state/main-terminal-runtime-state.svelte.ts`, `draft-composer-state.svelte.ts`, `overlay-interaction-state.svelte.ts`, `aux-terminal-runtime-state.svelte.ts`.
- **contracts (`*.ts`)**: props/DI 타입 interface만 모음. 예: `src/lib/features/session/contracts/session-shell.ts`(`SessionShellProps`, `SessionHostProps`, `SessionShellSession`, `SessionShellAuxState`), `session/contracts/session-viewport.ts`(`SessionViewportProps`), `launcher/contracts/session-launcher.ts`, `session-tabs/contracts/tab-bar.ts`.
- **service (`*.ts`)**: 순수 도메인 함수/팩토리. 예: `session/service/session-factory.ts`(`buildSession`, `createSessionLaunchRequest`), `session/service/session-shell-adapter.ts`(`createSessionHostProps`), `session/service/session-runtime.ts`, `session/service/session-shell-loader.ts`.
- **테스트**: 각 controller/service/state 파일 옆에 `<name>.test.ts` 동거(co-located). view는 `<Name>.test.ts`(testing-library/svelte). 1.6절 참조.

### 1.3 룬 기반 state class 작성 규약 (confirmed)

`src/lib/features/terminal/state/draft-composer-state.svelte.ts` 전체가 정석 패턴이다:

```ts
export interface DraftComposerState {
  draftPanelEl: HTMLDivElement | null;
  draftValue: string;
  draftOpen: boolean;
  // ...
}

class DraftComposerStateImpl implements DraftComposerState {
  draftPanelEl = $state<HTMLDivElement | null>(null);
  draftValue = $state("");
  draftOpen = $state(false);
  // ...
}

export function createDraftComposerState(): DraftComposerState {
  return new DraftComposerStateImpl();
}
```

규약 요점:
- **interface는 plain 타입**(룬 없음). impl class만 `$state(...)`로 초기화. controller는 interface 타입으로 받으므로 룬 의존이 새지 않는다.
- **`$state`를 거는 멤버는 reactive로 추적되어야 하는 값만** 건다. `main-terminal-runtime-state.svelte.ts`를 보면 timer handle, 누적 버퍼, plain remainder string 등은 `$state` 없이 그냥 `= 0` / `= ""` / `= null` 로 둔다(`mainMetadataRemainder = ""`, `replayBuffer: PtyOutputChunk[] = []`, `bottomLockTimer = null`). DOM에 영향 주는 값(`livePtyId`, `spawnError`, `terminalLoadingState`, `shellHomeDir`)만 `$state`.
- **모듈 단위 store**도 별도로 존재한다(아래 1.4). state class는 "인스턴스(세션 단위) 상태", 모듈 store는 "전역/싱글톤 상태"라는 역할 분리가 일관된다.

### 1.4 모듈 단위 룬 store 규약 (confirmed)

`*.svelte.ts` 파일이 모듈 top-level에서 `let x = $state(...)`를 선언하고 getter/mutator를 `export function`으로 노출하는 형태. class를 쓰지 않는다.

- `src/lib/features/session/state/live-session-store.svelte.ts`:
  ```ts
  let sessions = $state<Session[]>([]);
  let activeSessionId = $state<string | null>(null);
  export function getSessions() { return sessions; }
  export function addSession(session: Session) { sessions.push(session); activeSessionId = session.id; }
  export function setActiveSession(id: string) { activeSessionId = id; }
  // ...mutator들은 service/live-session-mutations.ts 의 순수 함수에 위임
  ```
- `src/lib/stores/settings.svelte.ts`: `let settings = $state<Settings>(cloneDefaults())` + `getSettings()`/`initializeSettings()`/`updateSettings()`. `updateSettings`는 부분 patch를 적용하고 `invoke("save_settings", { settings })`로 직렬화 persist(saveQueue로 순차화).
- `src/lib/features/workspace/session-store.svelte.ts`: `currentWindowName = $state("main")` 등.

> **규약 결론**: 세션 인스턴스마다 격리돼야 하는 transcript 상태 → state class(`create*State()`). 윈도우 전역(예: 활성 runtime provider 선택, 전역 approval queue) → 모듈 store(`*.svelte.ts`). settings는 기존 `getSettings()`를 그대로 읽는다.

### 1.5 controller DI 패턴 심화 (confirmed)

`createMainTerminalRuntimeController(deps)`의 `deps`는 28개 필드(`MainTerminalRuntimeControllerDeps`, `main-terminal-runtime-controller.ts:23`)로, 전부 getter(`getSessionId`, `getAgentId`, `getTerminal` …) 또는 effect 함수(`spawnPty`, `writeTerminalData`, `resizePty`, `onPtyId`, `onExit` …)다. 컨트롤러 본문은 이 deps만 호출하고 직접 `invoke`/`listen`을 부르지 않는다. → vitest에서 deps를 `vi.fn()`으로 모킹해 테스트(1.6, `overlay-clipboard-image-controller.test.ts` 패턴).

host 컴포넌트(`Terminal.svelte`)가 이 controller들을 조립하는 곳이다(`Terminal.svelte:164` `createMainTerminalRuntimeController({...})`, `:196` draft composer, `:282` aux, `:316` overlay). host는 룬 `let`/`$state`/`$derived`/`$effect`를 보유하고, controller에 getter로 연결한다.

### 1.6 테스트 컨벤션 (confirmed)

- 러너: **Vitest 4** (`package.json:14` `"test": "vitest run"`), env `jsdom`, setup `./src/test/setup.ts`, include `src/**/*.{test,spec}.{ts,js}` (`vite.config.ts`).
- view 테스트: `@testing-library/svelte` v5 + `@testing-library/jest-dom` + `@testing-library/user-event`. 플러그인 `svelteTesting({ autoCleanup: false })`.
- 정적 검사: `npm run check:frontend` = `svelte-check --tsconfig ./tsconfig.json && vite build`.
- controller 테스트 패턴(`overlay-clipboard-image-controller.test.ts:22` `createController()` 헬퍼): state는 실제 `create*State()`로 만들고, deps는 `vi.fn()`/스텁으로 주입. `describe/it/expect/vi` from `"vitest"`.
- **testid**: `src/lib/testids.ts`의 `TEST_IDS` 상수 객체에 키 추가 + `toTestIdSegment()` / `<feature>TestId(id)` 헬퍼 패턴. e2e와 단위 테스트가 공유. 새 transcript UI도 여기 키를 추가해야 한다(예: `agentTranscript`, `agentComposerInput`, `agentApprovalDialog`).

---

## 2. Terminal feature 전체 지도 (confirmed)

새 transcript surface가 **대체/공존**해야 하는 대상. 파일 목록은 `src/lib/features/terminal/`.

### 2.1 view 레이어 (`view/`)

| 파일 | 역할 |
|---|---|
| `TerminalRuntimeSurface.svelte` | xterm 출력 컨테이너(`bind:outputElement`) + spawn error/notice/loading overlay + `TerminalAssistStack` 래핑. `viewMode !== "terminal"`이면 `terminal-runtime--hidden`(display:none). **이것이 transcript surface가 대응하는 시각 컴포넌트의 자리**. |
| `TerminalAssistStack.svelte` | draft composer + aux terminal dock 묶음 |
| `TerminalOverlayStack.svelte` | link menu / clipboard image modal / editor picker / interrupt confirm 모달 묶음 |
| `TerminalEmbeddedEditorSurface.svelte` | Monaco editor surface(`viewMode === "editor"`일 때) |
| `TerminalLoadingOverlay.svelte` | 로딩 카드 |
| `TerminalDraftPanel`/`AuxPanel`/`AssistPanel`(구버전은 `src/lib/components/`에 잔존) | — |

> 참고: `src/lib/components/Terminal.svelte`(host)와 `src/lib/components/Terminal*Panel.svelte`는 **레거시 위치**다. 신규 view는 `features/terminal/view/`로 이동된 흐름이지만 host 자체(`Terminal.svelte`)는 아직 `components/`에 있다. 신규 feature는 처음부터 `features/agent-runtime/view/`에 둔다.

### 2.2 controller 레이어 (`controller/`)

핵심:
- `main-terminal-runtime-controller.ts` — PTY attach/spawn/replay, 스크롤 bottom-lock, 로딩 lifecycle, output chunk 라우팅(`handleMainOutputChunk`), resize/exit 처리. 반환 메서드: `attachOrSpawnPty`, `handleMainOutputChunk`, `handlePtyExit`, `handleTerminalResize`, `dispose` 등.
- `aux-terminal-runtime-controller.ts`, `aux-terminal-resize-controller.ts` — 보조 셸 dock.
- `draft-composer-controller.ts` — draft 입력 박스(높이 resize, paste, insert/send).
- `overlay-interaction-controller.ts` (+ `overlay-clipboard-image-controller.ts`, `overlay-file-link-actions.ts`, `overlay-link-menu-items.ts`) — file link 클릭 메뉴, 클립보드 이미지 paste, 외부 URL 열기.
- `terminal-editor-integration-controller.ts`, `terminal-editor-preflight-controller.ts` — terminal↔editor 모드 전환.
- `terminal-renderer-controller.ts` — DOM/WebGL 렌더러 스위칭.
- `terminal-shortcut-routing.ts`, `terminal-focus-bridge.ts`, `terminal-dom-helpers.ts`, `terminal-loading-lifecycle.ts`, `composition-view-theme.ts`, `terminal-test-bridge-controller.ts`.

### 2.3 state 레이어 (`state/`)

- `main-terminal-runtime-state.svelte.ts` (`MainTerminalRuntimeState`)
- `draft-composer-state.svelte.ts`
- `aux-terminal-runtime-state.svelte.ts`
- `overlay-interaction-state.svelte.ts`

### 2.4 host 조립부 (confirmed)

`src/lib/components/Terminal.svelte`가 host다. 흐름:
- `$props()`로 `SessionHostProps`(`sessionId`, `visible`, `agentId`, `distro`, `workDir`, `ptyId`, `resumeToken`, `sessionSnapshot`, `onPtyId`, `onAuxStateChange`, `onExit`, `onResumeFallback`, `onEditorSessionStateChange`) 수신 (`Terminal.svelte:98`).
- 룬 `let outputEl = $state<HTMLDivElement>(...)`, `editorViewMode = $state<"terminal"|"editor">("terminal")` 등 보유.
- `onMount`에서 xterm `Terminal` 생성 → `term.open(outputEl)` → `listen<PtyOutputChunk>("pty-output", ...)` + `listen<number>("pty-exit", ...)` 등록 → `mainTerminalRuntime.attachOrSpawnPty(term, ...)` (`Terminal.svelte:854~945`).
- template: `<TerminalEmbeddedEditorSurface viewMode={editorViewMode} .../>` 와 `<TerminalRuntimeSurface viewMode={editorViewMode} .../>`를 **둘 다 mount**하고 `viewMode`로 둘 중 하나만 보이게 함(`Terminal.svelte:1152`, `:1176`). 이 "두 surface를 같은 host에 mount하고 mode로 토글" 패턴이 **transcript vs legacy terminal 전환의 직접적 선례**다(3.3절).
- `onDestroy`에서 `unlistenOutput?.()`, `unlistenExit?.()`, controller `dispose()` 등 정리(`Terminal.svelte:1108`).

---

## 3. 세션/탭 생성·전환·렌더 흐름 (confirmed)

### 3.1 데이터 흐름 다이어그램

```
App.svelte (window root)
 ├─ live-session-store.svelte.ts  : $state sessions[], activeSessionId   ← single source of truth
 ├─ TabBar (session-tabs/view)     : 탭 표시/활성화/드래그/컨텍스트메뉴
 └─ SessionViewport (session/view) : welcome layer(SessionLauncher) | sessions layer
       └─ {#each sessions (session.id)}
             └─ SessionShellComponent  ← App에서 lazy-load 후 prop으로 주입
                   = SessionShell.svelte (standard) | PreviewSessionShell.svelte (browser preview)
                       └─ Terminal.svelte (host)  ← createSessionHostProps(props)로 SessionHostProps 변환
                             ├─ TerminalRuntimeSurface (xterm)
                             └─ TerminalEmbeddedEditorSurface (Monaco)
```

### 3.2 세션 생성 흐름 (confirmed)

1. `SessionLauncher.svelte`(welcome 또는 overlay) → `confirmDirectory()` → `deps.onConfirm(agentId, distro, workDir)` (`session-launcher-controller.ts:265`).
2. `App.svelte`의 `onConfirmSession={createSession}` → `sessionLifecycle.createSession(...)` (`createSessionLifecycleController`).
3. lifecycle이 `buildSession(request)`(`session-factory.ts:80`)로 `Session` 객체 생성 → `addSession(session)`(live-session-store) → activeSessionId 갱신.
4. `App.svelte`의 `$effect`가 `sessions.length > 0`이면 `ensureSessionShellComponent()` 호출 → `loadSessionShellComponent(browserPreview)`(`session-shell-loader.ts`)로 동적 import → `SessionShellComponent` 룬에 할당 → `SessionViewport`가 `{#each}`로 mount.
5. mount된 `Terminal.svelte`가 `onMount`에서 PTY를 spawn(`spawnPty(...)` via `mainTerminalRuntime`), 생성된 ptyId를 `onPtyId(sessionId, ptyId)`로 부모에 통보 → `live-session-store.setSessionPtyId` + Rust `set_session_pty` persist.

### 3.3 탭 활성 전환 흐름 (confirmed)

- `TabBar` 클릭 → `onActivateTab(sessionId)` → `App.handleActivateTab` → `setActiveSession(sessionId)`(live-session-store) → `activeSessionId` 룬 갱신.
- `SessionViewport`는 **모든 세션 host를 계속 mount**한 채 `visible={session.id === activeSessionId}`만 바꾼다(`SessionViewport.svelte:43`). 비활성 host는 `Terminal.svelte`의 `.terminal-shell.hidden`(absolute, off-screen) CSS로 숨겨지고 PTY/xterm 인스턴스는 살아있다. → **탭 전환이 host 재mount를 일으키지 않는다**. transcript surface도 이 계약(host가 `visible` prop만 받고 자체적으로 숨김)을 지켜야 한다.

### 3.4 session-tabs controller (confirmed)

`src/lib/features/session-tabs/controller/`:
- `tab-activation-controller.ts`, `tab-context-menu-controller.ts`, `tab-drag-controller.ts`, `tab-organization-controller.ts`(pin/lock/move).
- 모두 `create*Controller(deps)` + `vi.fn` 테스트. state는 없고 live-session-store mutator를 deps로 받음. (`App.svelte:616` `createTabOrganizationController({ getSessions, setActiveSession, moveSession, setSessionPinned, setSessionLocked })`).

---

## 4. PTY / Tauri invoke·listen 계층 (confirmed)

### 4.1 invoke/listen 래퍼

- `src/lib/tauri/core.ts`: `invoke<T>(command, args?)` — browser preview이면 `previewInvoke`, 아니면 `@tauri-apps/api/core`의 `invoke`로 라우팅.
- `src/lib/tauri/event.ts`: `listen<T>(event, handler)`, `emitTo<T>(target, event, payload)` — 동일하게 preview 분기. `UnlistenFn` 타입 re-export.
- `src/lib/tauri/window.ts`: window API 래퍼.

> **신규 runtime도 반드시 이 래퍼를 통해서만** Rust를 호출/구독해야 browser preview와 테스트가 깨지지 않는다. 직접 `@tauri-apps/api`를 import하면 안 된다.

### 4.2 pty.ts (confirmed)

`src/lib/pty.ts`의 invoke 래퍼 (command 이름은 Rust 측 등록 이름):
- `spawnPty(cols, rows, agentId, distro, workDir, resumeToken?)` → `invoke("pty_spawn", {...})`. 내부에서 `getAgentDefinition(agentId).buildStartCommand/buildResumeCommand`로 WSL `wsl.exe -d <distro> -e bash -li -c "<cmd>"` 조립. Claude일 때 `getAgentCommandOptions`가 `claudeCliFlags`/`claudeTui`(`CLAUDE_CODE_NO_FLICKER`)를 주입.
- `spawnShellPty(cols, rows, distro, workDir)` — aux 셸.
- `writePty(id, data)` `pty_write`, `resizePty(id, cols, rows)` `pty_resize`, `killPty(id)` `pty_kill`.
- snapshot/replay: `takePtyInitialOutput`(`pty_take_initial_output`), `getPtyOutputSnapshot`(`pty_get_output_snapshot`), `getPtyRuntimeSnapshot`(`pty_get_runtime_snapshot`), `getPtyOutputDeltaSince`(`pty_get_output_delta_since`).
- 출력 이벤트: Rust가 `"pty-output"`(payload `PtyOutputChunk { id, seq, data }`)와 `"pty-exit"`(payload `number` = ptyId)를 emit → `Terminal.svelte`가 `listen`. **PTY 단위 멀티플렉싱은 payload의 `id`로 필터링**(`handleMainOutputChunk`가 `event.id !== state.livePtyId`면 무시).

> **추정**: Direct Agent Runtime은 PTY byte stream 대신 구조화된 agent event(JSON-RPC/ACP/app-server 기반)를 받아야 하므로, `pty.ts`에 대응하는 **새 `src/lib/agent-runtime/transport.ts`(또는 feature service)** 가 필요하다. 새 Rust command/event 이름(예: `agent_runtime_send`, `"agent-runtime-event"`)은 본 frontend 조사 범위 밖이며 `07-tauri-process-runtime.md`/`05/06` 어댑터 문서에서 정의될 사실에 의존한다. 다만 **wrapper 위치와 invoke/listen 경유 규약은 위 4.1과 동일하게** 따라야 한다.

### 4.3 workspace.ts (confirmed)

`src/lib/workspace.ts`는 세션/윈도우 persist용 invoke 래퍼 모음(`save_workspace`, `set_session_pty`, `set_session_resume_token`, `set_session_aux_terminal_state`, `close_session`, `move_session_to_window`, `open_empty_window` 등). `sanitizeWorkspaceSnapshotForSave`가 저장 시 `ptyId`/`resumeToken`을 null로 마스킹한다.

---

## 5. 도메인 모델 (`src/lib/types.ts`, confirmed)

신규 runtime이 손대야 할 핵심 타입:

| 타입 | 핵심 필드 | runtime 관련 |
|---|---|---|
| `SessionCore` | `id, agentId, resumeToken, title, pinned, locked, distro, workDir` | `agentId: AgentId`(string alias) |
| `SessionShellRuntimeState` | `ptyId, auxPtyId, auxVisible, auxHeightPercent` | PTY 식별자 보관 |
| `SessionEditorSnapshot` | `viewMode: "terminal"\|"editor", editorRootDir, openEditorTabs, activeEditorPath` | `SessionViewMode` 확장 후보 |
| `SessionPersistedState` | `SessionCore & SessionShellRuntimeState & SessionEditorSnapshot` | DB/workspace.json 직렬화 단위 |
| `Session` | `SessionPersistedState & { dirtyPaths }` | 런타임 세션 |
| `WorkspaceTabSnapshot` | 위 필드들의 optional 평면화 + `ptyId?, viewMode?` … | Rust↔TS workspace 교환 포맷 |
| `Settings` | `language, interface, workspace, terminal, editor, history, mainWindow` | 설정 전체 |
| `TerminalSettings` | `renderer, claudeCliFlags, claudeTui, scrollback, ...` | 새 runtime 설정 추가 자리 후보 |
| `AgentId` | `type AgentId = string` (`agents/types.ts:1`) | provider 식별자 |
| `DEFAULT_SETTINGS` | 모든 기본값 | 새 설정의 default 추가 필요 |

> **연결점(추정 + 권고)**: transcript 세션을 legacy terminal 세션과 구분하려면 `SessionCore`(또는 별도 snapshot)에 **runtime kind 필드**를 추가하는 게 자연스럽다. 예:
> ```ts
> export type SessionRuntimeKind = "terminal" | "agent-direct"; // ※ stale — 정본은 15 §7.1 ("pty" | "direct-codex" | "direct-claude")
> // SessionCore에 runtimeKind: SessionRuntimeKind 추가 (default "terminal")
> ```
> 이를 추가하면 `WorkspaceTabSnapshot`, `session-factory.buildSession`, `applyWorkspaceWindowSnapshot`(persistence)에도 전파해야 한다. 단, `SessionViewMode`를 `"terminal"|"editor"|"agent"`로 확장하는 것은 **부적절**하다 — viewMode는 한 host 안에서의 surface 토글이고, runtime kind는 host 종류 자체를 결정하므로 의미가 다르다. 정합 결정은 `04-normalized-agent-model.md`/`10-persistence-migration.md`와 cross-check 필요(아래 9절 risks).

---

## 6. i18n 구조와 추가 방식 (confirmed)

### 6.1 구조

- `src/lib/i18n/index.ts`: svelte-i18n 래핑. `initializeI18n`/`setLanguagePreference`/`translate`. `import { t } from "../i18n"`로 컴포넌트에서 `$t("key")` 사용(`t`는 `_`의 alias). 일부 컴포넌트는 직접 `import { _ as t } from "svelte-i18n"`도 사용(`TerminalSettingsSection.svelte:2`).
- locale 파일: `src/lib/i18n/locales/en.ts`, `ko.ts` (각 392줄, **두 파일 키 구조가 1:1 동일해야 함**). default export는 nested 객체.
- top-level namespace(en.ts 기준): `app, common, imagePaste, launcher, settings, tabs, rename, terminal, themePicker, fontPicker`.

### 6.2 추가 방식

1. `en.ts`와 `ko.ts` **동시에** 같은 키 트리를 추가. 키는 nested 객체, 값은 `"문자열"` 또는 `{count}` interpolation. 복수형은 `key_one`/`key_other` 패턴(`settings.imageCache.deleted_one` 참조).
2. 컴포넌트에서 `$t("namespace.path.to.key")` 또는 `$t("key", { values: { message } })`(`TerminalRuntimeSurface.svelte:105` 참조).
3. **신규 runtime namespace는 `08-ui-composition.md`에서 이미 예약됨**: `agentRuntime.status.*`, `agentRuntime.approval.*`, `agentRuntime.toolKind.*`, `agentRuntime.errors.*`, `agentRuntime.fallback.*`. 본 조사에서 확인: 현재 `en.ts`/`ko.ts`에 `agentRuntime` 키는 **아직 없음**(추가 대상).
4. 설정 섹션 텍스트도 i18n 키로(아래 7절).

---

## 7. 설정 UI 패턴 (confirmed)

### 7.1 섹션 등록 구조

- `src/lib/components/settings/registry.ts`: `SETTINGS_SECTIONS: SettingsSectionDefinition[]` 배열. 각 항목 `{ id, titleKey, descriptionKey, component }`. `SettingsSectionId` 유니온에 id 추가 + 배열에 push + import.
- 섹션 컴포넌트: `src/lib/components/settings/sections/<Name>SettingsSection.svelte`. 현재 6개(interface/workspace/terminal/editor/storage/history).
- `SettingsModal.svelte`가 nav + body로 렌더(testid: `settings-nav`, `settings-body`, nav 항목은 `settingsNavSectionTestId(id)`).

### 7.2 섹션 내부 입력 패턴 (confirmed, `TerminalSettingsSection.svelte`)

```ts
const settings = getSettings();
// select 변경:
function handleClaudeTuiInput(event: Event) {
  updateSettings({ terminal: { claudeTui: (event.target as HTMLSelectElement).value as ClaudeTuiPreference } });
}
```
- `getSettings()`로 reactive 객체 읽고, 입력 핸들러에서 `updateSettings({ <section>: { <field>: value } })` 호출 → 자동 persist.
- `<select>`/`<input type=range|number|checkbox>` + `$t(...)`로 label/hint. 최근 추가된 `claudeTui` select(`auto`/`fullscreen`/`default`)가 **신규 enum 설정 추가의 가장 가까운 선례**(commit `679dabf feat(settings): add Claude screen rendering mode option`).

### 7.3 신규 runtime 설정 추가 경로 (권고)

direct runtime을 opt-in 토글/모드로 노출하려면:
1. `types.ts`의 적절한 섹션(예: `TerminalSettings` 또는 신규 `AgentRuntimeSettings` 추가 + `Settings`에 편입 + `DEFAULT_SETTINGS`/`cloneDefaults`/`normalizeSettings`/`updateSettings`의 5곳 모두 반영). `settings.svelte.ts`의 `cloneDefaults`/`normalizeSettings`/`updateSettings`는 섹션별로 명시적 nested merge를 하므로 **새 섹션은 이 3함수를 반드시 수정**해야 한다(누락 시 persist 깨짐).
2. `registry.ts`에 새 섹션(또는 기존 terminal 섹션 내 필드) 추가.
3. en/ko locale에 `settings.sections.*`/`settings.fields.*` 키 추가.

---

## 8. 신규 `agent-runtime` feature 모듈 배치안 (권고)

기존 규약(1절)에 정확히 맞춘 제안 트리. 모든 경로는 신규 생성 대상.

```
src/lib/features/agent-runtime/
├── contracts/
│   ├── agent-runtime-shell.ts        # AgentRuntimeShellProps (SessionShellProps와 동형), AgentRuntimeHostProps
│   ├── transcript.ts                 # TranscriptItem 유니온(user/agent/tool/command/diff/approval/error)
│   └── composer.ts                   # ComposerState/Action 타입
├── state/
│   ├── agent-runtime-state.svelte.ts # createAgentRuntimeState(): 세션 단위 transcript 배열, status, pending approval
│   └── composer-state.svelte.ts      # createComposerState(): 입력값/첨부/전송중 플래그
├── controller/
│   ├── agent-runtime-controller.ts   # createAgentRuntimeController(deps): transport event → transcript mutate
│   ├── agent-transport-controller.ts # invoke/listen 경유 send/cancel/subscribe (4.1 래퍼 사용)
│   ├── approval-controller.ts        # approval option 보존/응답
│   └── composer-controller.ts        # 입력/이미지 paste/멘션/전송
├── service/
│   ├── transcript-reducer.ts         # 순수 함수: prev transcript + event → next transcript
│   └── transport.ts                  # invoke 래퍼 (pty.ts 대응)
└── view/
    ├── AgentRuntimeShell.svelte      # host (Terminal.svelte 대응): props 받고 controller/state 조립
    ├── AgentTranscriptSurface.svelte # transcript 렌더(메시지/카드)
    ├── AgentComposer.svelte
    ├── tool-cards/*.svelte           # ToolCard, CommandOutputCard, FileDiffCard ...
    └── AgentApprovalDialog.svelte
```

레이어 책임:
- **view**: 로직 없음. `$props()` + 콜백. `AgentTranscriptSurface`는 `viewMode`/`visible` 토글 가능하게(2.4 패턴).
- **state(`*.svelte.ts`)**: 1.3 class 패턴. `transcript = $state<TranscriptItem[]>([])`, `status = $state<AgentRuntimeStatus>("idle")`, `pendingApproval = $state<ApprovalRequest | null>(null)`.
- **controller**: 1.5 DI 패턴. transport event를 받아 `transcript-reducer`로 state mutate. `invoke`/`listen`은 직접 부르지 않고 deps(`sendMessage`, `cancel`, `subscribe`)로 받음.
- **service/transport.ts**: 4.1 래퍼만 사용해 Rust command 호출.
- **테스트**: controller/reducer는 `vi.fn` deps로 단위 테스트, view는 testing-library. `testids.ts`에 키 추가.

---

## 9. legacy terminal 유지 + transcript 공존 전환 전략 (핵심 권고)

세 가지 통합 지점 비교. **권고는 옵션 B**.

### 옵션 A — `SessionViewport`에서 component 선택
- `SessionViewport.svelte`가 세션별로 `SessionShellComponent` vs `AgentRuntimeShellComponent`를 분기 렌더.
- 단점: `SessionViewportProps`(`session/contracts/session-viewport.ts`)와 `App.svelte`의 lazy-load 로직(`ensureSessionShellComponent`/`loadSessionShellComponent`)을 둘로 늘려야 함. `{#each}` 안에서 컴포넌트 분기 → 두 host의 props 계약을 viewport가 동시에 알아야 함.

### 옵션 B — `SessionShell.svelte` 내부 분기 (권고)
- `SessionShell.svelte`는 현재 11줄짜리 thin wrapper(`createSessionHostProps(props)` → `<Terminal {...terminalProps} />`).
- 여기서 `session.runtimeKind`(또는 `session.agentId`/설정 기반)로 분기:
  ```svelte
  <script lang="ts">
    let props: SessionShellProps = $props();
    const hostProps = $derived(createSessionHostProps(props));
    const useDirectRuntime = $derived(/* props.session.runtimeKind === "agent-direct" */);
  </script>
  {#if useDirectRuntime}
    <AgentRuntimeShell {...hostProps} />
  {:else}
    <Terminal {...hostProps} />
  {/if}
  ```
- 장점: `SessionViewportProps`/`App.svelte`/`session-shell-loader` 변경 **0**. `SessionShellProps`/`SessionHostProps` 계약(`session/contracts/session-shell.ts`)을 그대로 재사용. `createSessionHostProps`(`session-shell-adapter.ts`)가 이미 contract를 만들어 줌. `AgentRuntimeShell`은 `Terminal`과 같은 `SessionHostProps`를 받되 PTY 대신 transport를 쓰면 됨.
- 필요한 contract 확장: `SessionShellSession`(`session-shell.ts:13` `Pick<Session, ...>`)에 `runtimeKind`를 추가하고, `SessionHostProps`에도 전달. `createSessionHostProps`에 한 줄 추가.
- legacy fallback: transport 실패/미지원 agent면 `AgentRuntimeShell` 내부에서 `Terminal`로 graceful fallback(또는 분기 자체를 agent capability로). `08-ui-composition.md`의 "legacy PTY fallback session"과 일치.

### 옵션 C — `loadSessionShellComponent` loader 분기
- `App.svelte:198` `loadSessionShellComponent(browserPreview)` → kind를 인자로 받게 확장.
- 단점: 한 윈도우에 terminal/agent 세션이 **혼재**하면 단일 `SessionShellComponent` 룬으로 표현 불가(현재 App은 component 1개만 보관). 옵션 A/B 없이는 혼재 불가능.

### 전환 메커니즘 (옵션 B 기준)
1. **session 단위 분기**: `session-factory.buildSession`이 `runtimeKind`를 세팅(launcher에서 agent 선택 시 capability에 따라 결정). 기존 세션은 `runtimeKind` 부재 → default `"terminal"`로 normalize(persistence 마이그레이션은 `10-persistence-migration.md` 소관).
2. **탭 전환 무재mount 보장**: `AgentRuntimeShell`도 `visible` prop만 받고 자체적으로 `.hidden` CSS로 숨김(3.3 계약). transport 구독은 `onMount`~`onDestroy` 생애주기로 묶고, 비활성 시에도 살려둬 transcript/연결 유지.
3. **동일 host 안에서 surface 토글이 추가로 필요하면**(예: transcript ↔ raw diagnostic terminal embed) `Terminal.svelte`의 `editorViewMode` 토글 패턴(2.4, `Terminal.svelte:1152/1176`을 둘 다 mount + `viewMode`로 display 토글)을 재사용한다. 즉 `AgentRuntimeShell` 안에 `AgentTranscriptSurface`와 (선택적) `TerminalRuntimeSurface`를 함께 두고 mode로 전환 가능.

---

## 10. 신규 모듈이 따라야 할 구체적 연결점 체크리스트

| # | 연결점(파일/심볼) | 해야 할 일 |
|---|---|---|
| 1 | `src/lib/types.ts` `SessionCore`/`WorkspaceTabSnapshot`/`SessionViewMode` | `runtimeKind` 필드 추가(권고) + `DEFAULT_SETTINGS` |
| 2 | `src/lib/features/session/service/session-factory.ts` `buildSession` | `runtimeKind` 세팅 |
| 3 | `src/lib/features/session/contracts/session-shell.ts` `SessionShellSession`/`SessionHostProps` | `runtimeKind`/필요 필드 전달 |
| 4 | `src/lib/features/session/service/session-shell-adapter.ts` `createSessionHostProps` | 새 필드 매핑 한 줄 |
| 5 | `src/lib/features/session/view/SessionShell.svelte` | 옵션 B 분기(`{#if useDirectRuntime}`) |
| 6 | `src/lib/tauri/core.ts`/`event.ts` | 신규 transport는 이 래퍼만 경유 |
| 7 | `src/lib/agents/registry.ts`/`types.ts` | provider capability(direct 지원 여부) 확장 자리(추정: `AgentDefinition`에 capability 플래그) |
| 8 | `src/lib/i18n/locales/{en,ko}.ts` | `agentRuntime.*` namespace 추가(en/ko 동시) |
| 9 | `src/lib/testids.ts` `TEST_IDS` | transcript/composer/approval testid 추가 |
| 10 | `src/lib/stores/settings.svelte.ts` + `components/settings/registry.ts` | 새 설정 섹션/필드 추가 시 cloneDefaults/normalizeSettings/updateSettings 3함수 + registry |
| 11 | `src/lib/features/workspace/session-store-snapshot.ts`(persistence) | `runtimeKind` snapshot 직렬화(파일 미독, 추정) |
| 12 | `App.svelte` `live-session-store` mutator wiring | direct runtime은 PTY 없으므로 `onPtyId` 흐름 우회/대체 필요 |

---

## 11. 위험과 미확인 사항

- **(미확인)** 신규 Rust command/event 이름·payload(transport) — 본 frontend 조사 범위 밖. `05-codex-app-server-adapter.md`, `06-claude-acp-adapter.md`, `07-tauri-process-runtime.md`에 의존. 4.2의 transport 래퍼는 그 결정 이후 확정.
- **(미확인)** persistence 마이그레이션(`runtimeKind` 컬럼/필드, 기존 세션 복원) — `10-persistence-migration.md` 소관. `session-store-snapshot.ts`/`session-store-persistence.ts`는 본 조사에서 본문 미독(파일 존재만 확인).
- **(위험)** `App.svelte`의 `SessionShellComponent` 룬은 **윈도우당 단일 컴포넌트**를 가정. terminal/agent 혼재를 옵션 B로 처리하면 OK지만, 옵션 C로 가면 구조 변경이 크다.
- **(위험)** `onPtyId`/`onAuxStateChange`/`onExit`/`onResumeFallback` 콜백 흐름(`session-lifecycle-controller`, `session-runtime.ts`)은 전부 PTY 전제. direct runtime은 ptyId가 없어 이 흐름을 우회하거나 no-op 처리해야 하며, workspace autosave `$effect`(`App.svelte:353`)가 추적하는 필드 목록도 영향. transcript 세션의 "ptyId 부재"가 persist/복원 로직에서 죽은 세션으로 오인되지 않도록 검증 필요.
- **(위험)** 탭 전환 시 비활성 host를 살려두는 계약(3.3)을 transcript surface가 깨면(예: heavy DOM을 unmount/remount) 회귀. `08-ui-composition.md`의 focus/shortcut 회귀 위험과 겹침.
- **(위험)** focus/shortcut 라우팅: 기존 `terminal-focus-bridge.ts`/`terminal-shortcut-routing.ts`(Ctrl+T/Ctrl+W in `App.handleKeydown`, aux/editor shortcut window listener)와 composer 입력 focus 충돌. command output terminal embed가 app shortcut을 가로채지 않도록 분리 필요.
- **(추정)** settings의 nested merge(`settings.svelte.ts`)는 섹션을 명시적으로 나열한다. 새 설정 섹션을 추가하면서 `cloneDefaults`/`normalizeSettings`/`updateSettings` 중 하나라도 누락하면 persist/load가 조용히 깨진다 — 7.3의 5곳 동기화가 필수.
