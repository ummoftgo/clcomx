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
  - 탭별 보조 터미널 dock
  - 이미지 붙여넣기 시 파일 저장 후 경로 삽입
  - URL 링크 컨텍스트 메뉴
  - 파일 경로 링크와 Windows 에디터 열기
- UI 커스터마이징
  - 다크/라이트 테마
  - UI 폰트 / 터미널 폰트 분리
  - UI 스케일
  - 한국어 / 영어
- 자동 검증
  - Vitest 프론트 테스트
  - Rust unit test
  - Windows Tauri E2E 기능팩
  - 장세션 복구/링크 메뉴 회귀 검증

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

탐지가 안 될 경우 WSL에서 override를 줄 수 있습니다.

```bash
export CLCOMX_WIN_CARGO_DIR='C:\Users\<user>\.cargo\bin'
export CLCOMX_WIN_NODE_DIR='C:\Program Files\nodejs'
```

WSL 경로를 넘겨도 됩니다.

```bash
export CLCOMX_WIN_CARGO_DIR="$(wslpath -w /mnt/c/Users/<user>/.cargo/bin)"
export CLCOMX_WIN_NODE_DIR="$(wslpath -w '/mnt/c/Program Files/nodejs')"
```

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

주의:

- 일반 개발/배포 빌드에는 **Windows mirror 경로가 필요하지 않습니다.**
- mirror(`C:\temp\clcomx`)는 WSL에서 Windows **E2E를 돌릴 때만** 쓰는 경로입니다.
- 평소 빌드는 저장소를 checkout한 실제 경로에서 바로 실행해야 합니다.

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

- 설치본: `src-tauri/target/release/bundle/nsis/CLCOMX_<version>_x64-setup.exe`
- 포터블: `src-tauri/target/release/bundle/portable/CLCOMX_<version>_x64-portable.zip`

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

### 5. 터미널 링크와 파일 열기

- `http`, `https`, `ftp` 링크를 좌클릭하면 메뉴가 열립니다.
  - 브라우저로 열기
  - 링크 복사
- 터미널에 보이는 파일 경로도 좌클릭 메뉴를 지원합니다.
  - 파일 열기
  - 다른 에디터로 열기
  - 경로 복사

지원하는 파일 경로 예:

- `/home/.../src/App.svelte:12:3`
- `/mnt/c/.../sample.ts`
- `src/lib/file-links.ts`
- `../README.md`
- `.gitignore`

지원 에디터 감지:

- VS Code
- Cursor
- Windsurf
- PhpStorm
- Notepad++
- Sublime Text

감지는 다음 순서로 시도합니다.

- Windows PATH (`where.exe`)
- 대표 설치 경로
- Windows Registry `App Paths`
- 공통 설치 루트 재귀 탐색

감지가 안 되는 환경에서는 Windows에서 editor executable 경로를 직접 지정할 수 있습니다.

```bash
export CLCOMX_WIN_EDITOR_VSCODE_PATH='C:\Users\<user>\AppData\Local\Programs\Microsoft VS Code\Code.exe'
export CLCOMX_WIN_EDITOR_PHPSTORM_PATH='C:\Users\<user>\AppData\Local\JetBrains\Toolbox\scripts\PhpStorm.cmd'
```

### 6. 보조 터미널

- 각 탭에서 `터미널 열기` 버튼 또는 `Ctrl+\``로 보조 터미널을 열 수 있습니다.
- 보조 터미널은 메인 에이전트 터미널을 밀지 않는 하단 overlay dock으로 표시됩니다.
- 보조 터미널은 현재 탭의 `distro + workDir`에서 일반 셸로 실행됩니다.
- 숨기면 셸 상태를 유지하고, 다시 열면 같은 셸로 이어집니다.
- 셸 안에서 `exit`로 종료했다면 다음에 열 때 새 셸이 다시 생성됩니다.
- 탭/앱을 닫으면 보조 터미널은 정리되고, 다음 실행 시 복원되지는 않습니다.
- `설정 > Terminal`에서 토글 단축키와 기본 높이를 조정할 수 있습니다.

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
  - 스크롤백
  - 보조 터미널 단축키 / 기본 높이
  - 드래프트 관련 설정
- Storage
  - 이미지 캐시 통계
  - 폴더 열기
  - 캐시 비우기
- History
  - 최근 히스토리 보존 개수

## 저장 파일

기본적으로 앱을 **어느 디렉토리에서 실행하느냐**에 따라 다음 파일들이 그 위치에 저장됩니다.

- `setting.json`
- `theme.json`
- `workspace.json`
- `tab_history.json`
- `temp/image/*`

즉, 항상 같은 작업 디렉토리에서 실행하는 것이 좋습니다.

저장 내용:

- `setting.json`
  - UI/터미널 설정
  - 메인 창 위치/크기
  - 기본 에이전트 / 기본 배포판 / 배포판별 시작 경로
- `theme.json`
  - 실행 디렉토리의 사용자 편집용 테마 팩
  - 첫 실행 시 기본 테마팩이 자동 생성됨
  - 같은 `id`를 재사용하면 기본 테마를 override 가능
  - `extends`로 기존 테마 일부 색만 수정 가능
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

## 버전 관리

- 현재 버전: `0.5.2`
- 버전 문서 위치: [`docs/version/`](./docs/version/)
- 규칙:
  - 기능 추가: `minor` 증가, `patch`는 `0`으로 초기화
  - 수정/안정화: `patch` 증가
  - 메이저 버전 증가는 명시적으로 지시받은 경우에만 수행

이번 변경 내역은 [`docs/version/0.5.2.md`](./docs/version/0.5.2.md)에 정리돼 있습니다.

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

개별 팩:

```powershell
npm run test:e2e:windows -- -Project terminal-links
npm run test:e2e:windows -- -Project workspace-restore
npm run test:e2e:windows -- -Project terminal-aux
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
