# CLCOMX

WSL에서 실행하는 CLI 에이전트(`claude`, `codex`)를 Windows 네이티브 GUI로 감싸는 Tauri 기반 멀티탭 워크스페이스입니다.

## 개요

CLCOMX는 Windows + WSL 환경에서 CLI 에이전트를 더 편하게 쓰기 위한 데스크톱 앱입니다.

- WSL 안의 `claude`, `codex`를 탭 기반 GUI로 실행
- 에이전트별 세션 복원 지원
- 다중 창 / 다중 탭 워크스페이스 복원
- 최근 히스토리, 이미지 붙여넣기, 드래프트 입력, 테마/폰트/i18n 지원

Electron 대신 `Rust + Tauri v2 + Svelte 5`를 사용해 메모리 사용량과 네이티브 통합을 우선했습니다.

## 주요 특징

- 멀티 에이전트
  - 새 세션에서 `claude` 또는 `codex` 선택
  - 에이전트별 resume token 저장 및 복원
- 워크스페이스 복원
  - 창 위치, 크기, 탭 순서, 활성 탭, 창 이름 복원
  - 탭 이름 변경, 탭 고정, 탭 닫기 잠금 상태 복원
- 최근 히스토리
  - `tab_history.json`에 최근 세션 저장
  - 에이전트 종류와 resume token 요약 표시
- 터미널 UX
  - xterm.js 기반 터미널
  - 드래프트 입력 보조
  - 이미지 붙여넣기 시 파일 저장 후 경로 삽입
- UI 커스터마이징
  - 다크/라이트 테마
  - UI 폰트 / 터미널 폰트 분리
  - UI 스케일
  - 한국어 / 영어
- 자동 검증
  - Vitest 프론트 테스트
  - Rust unit test
  - Windows Tauri E2E 기능팩

## 필요사항

### 실행 환경

- Windows 10/11
- WSL2
- Ubuntu 계열 배포판 권장

### 필수 도구

WSL 쪽:

- `node`
- `npm`
- 실행할 CLI 에이전트
  - `claude`
  - `codex`

Windows 쪽:

- Rust / Cargo
- Node.js
- PowerShell
- Tauri 빌드에 필요한 Windows C++ 빌드 도구

### 선택 도구

E2E 테스트용:

- `tauri-driver`
- `msedgedriver.exe`

이 둘은 스크립트로 설치할 수 있습니다.

## 프로젝트 구조

```text
<project-root>/
├── src/                    # Svelte 프론트엔드
├── src-tauri/              # Rust + Tauri 백엔드
├── vendor/portable-pty/    # 로컬 vendor PTY 라이브러리
├── scripts/                # 빌드 / 실행 / E2E 보조 스크립트
├── docs/                   # 설계 / 테스트 문서
├── HANDOVER.md             # 인수인계 문서
└── README.md
```

핵심 파일:

- [src/App.svelte](./src/App.svelte)
- [src/lib/components/SessionLauncher.svelte](./src/lib/components/SessionLauncher.svelte)
- [src/lib/components/Terminal.svelte](./src/lib/components/Terminal.svelte)
- [src/lib/stores/sessions.svelte.ts](./src/lib/stores/sessions.svelte.ts)
- [src/lib/agents/registry.ts](./src/lib/agents/registry.ts)
- [src-tauri/src/commands/pty.rs](./src-tauri/src/commands/pty.rs)
- [src-tauri/src/commands/settings.rs](./src-tauri/src/commands/settings.rs)

## 설치

프로젝트 루트에서:

```bash
npm install
```

Windows Rust / Node 환경은 [scripts/win-env.sh](./scripts/win-env.sh)가 탐지합니다.

## 실행 방법

### 개발 테스트 빌드 후 실행

가장 일반적인 실행 방법입니다.

```bash
bash scripts/build-dev.sh
```

내부 동작:

1. WSL에서 프론트엔드 빌드
2. Windows에서 Tauri debug 빌드
3. `clcomx.exe` 실행

### 개발 모드

Vite dev server + Tauri dev 모드:

```bash
bash scripts/dev.sh
```

### 배포용 빌드

```bash
bash scripts/build-windows.sh
```

산출물:

- `src-tauri/target/release/bundle/`

## 사용 방법

### 1. 새 세션 열기

1. 앱 실행
2. `새 세션` 클릭
3. 에이전트 선택
4. WSL 배포판 선택
5. 작업 디렉토리 선택
6. `여기서 열기`

### 2. 기존 세션 다시 열기

첫 화면의 Recent 목록에서 선택하면 됩니다.

- 에이전트 종류 표시
- resume token이 있으면 같은 세션 복원 시도
- 복원 실패 시 새 세션으로 fallback

### 3. 탭/창 관리

- 탭 순서 변경
- 탭 이름 변경
- 창 이름 변경
- 탭 고정
- 탭 닫기 잠금
- 새 창으로 이동
- 다른 창으로 이동

### 4. 이미지 붙여넣기

- 터미널 드래프트/입력 보조 영역에서 이미지 붙여넣기
- 미리보기 확인
- 저장 후 에이전트 입력창에 경로 삽입

이미지는 `temp/image` 아래에 저장됩니다.

## 설정

설정 화면은 현재 다음 카테고리로 나뉩니다.

- Interface
  - 언어
  - 테마
  - UI 스케일
  - UI 글꼴
  - 새 창 기본 크기
- Workspace
  - 기본 에이전트
  - 기본 배포판
  - 배포판별 기본 시작 경로
- Terminal
  - 터미널 글꼴
  - 터미널 크기 / 드래프트 관련 설정
- Storage
  - 이미지 캐시 통계
  - 폴더 열기
  - 캐시 비우기
- History
  - 최근 히스토리 보존 개수

## 저장 파일

기본적으로 앱을 **어느 디렉토리에서 실행하느냐**에 따라 다음 파일들이 그 위치에 저장됩니다.

- `setting.json`
- `workspace.json`
- `tab_history.json`
- `temp/image/*`

즉, 항상 같은 작업 디렉토리에서 실행하는 것이 좋습니다.

저장 내용:

- `setting.json`
  - UI/터미널 설정
  - 메인 창 위치/크기
  - 기본 에이전트 / 기본 배포판 / 배포판별 시작 경로
- `workspace.json`
  - 창/탭 배치
  - 활성 탭
  - 탭 이름 / 창 이름
  - pinned / locked
  - resume token
- `tab_history.json`
  - 최근 세션 목록
  - 에이전트 종류
  - resume token

## 세션 복원

CLCOMX는 종료 시 에이전트 출력에서 resume token을 캡처해 다음 시작에 재사용합니다.

- Claude
  - `claude --resume <token>`
- Codex
  - `codex resume <token>`

복원 실패 시에는 같은 디렉토리에서 새 세션으로 자동 fallback 합니다.

## 테스트

### 빠른 검증

```bash
npm run test
npm run test:rust
npm run check
npm run verify
```

### Windows E2E

전체:

```powershell
npm run test:e2e:windows
```

특정 팩만:

```powershell
npm run test:e2e:windows -- -Project smoke
npm run test:e2e:windows -- -Project settings
npm run test:e2e:windows -- -Project windows-tabs
npm run test:e2e:windows -- -Project workspace-restore
npm run test:e2e:windows -- -Project image-paste
npm run test:e2e:windows -- -Project terminal-input
```

WSL에서 Windows mirror를 통해 실행:

```bash
npm run test:e2e:wsl -- --project smoke
```

상세 내용은 [docs/testing/e2e.md](./docs/testing/e2e.md)를 참고하세요.

## 현재 내장 에이전트

- `claude`
- `codex`

에이전트 구조는 레지스트리 기반이라 이후 확장이 가능하도록 설계되어 있습니다.

## 개발 메모

- 실행 파일 이름은 `clcomx.exe`입니다.
- PTY는 로컬 vendor [portable-pty](./vendor/portable-pty/)를 사용합니다.
- Windows에서 `CREATE_NO_WINDOW`는 현재 ConPTY 출력 문제 때문에 사용하지 않습니다.
- 디버그/릴리즈 모두 Windows GUI subsystem으로 빌드됩니다.

## 참고 문서

- [HANDOVER.md](./HANDOVER.md)
- [docs/testing/e2e.md](./docs/testing/e2e.md)
- [docs/plans](./docs/plans)
