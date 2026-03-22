# CLCOMX E2E Testing Guide

## 목적

CLCOMX의 데스크톱 E2E는 다음을 자동 검증하기 위한 구조다.

- 앱 기동
- mock test mode 기반 세션 생성
- 설정 패널 동작과 저장
- 다중 탭 / 탭 메뉴 / 닫기 확인 모달

실제 WSL/Claude 환경 전체를 직접 검증하는 것이 아니라, **Tauri + multi-window + state persistence + 핵심 UI flow**가 깨지지 않는지를 빠르게 확인하는 것이 1차 목적이다.

## 테스트 계층

- Unit
  - `npm run test`
  - `npm run test:rust`
- Static/build checks
  - `npm run check`
  - `npm run verify`
- Desktop E2E
  - `npm run test:e2e`
- `npm run test:e2e:smoke`
- `npm run test:e2e:settings`
- `npm run test:e2e:windows-tabs`
- `npm run test:e2e:workspace-restore`
- `npm run test:e2e:image-paste`
- `npm run test:e2e:terminal-input`

개별 팩 스크립트는 이제 Windows에서 직접 `vitest`를 돌리지 않고, PowerShell runner를 통해 최신 exe 빌드/실행 경로를 우선 사용한다.

## E2E 기능팩

현재 E2E는 Vitest `projects` 기준으로 나뉜다.

- `smoke`
  - 앱 기동
  - 런처 진입
  - mock session 열기
  - 설정 열기
- `settings`
  - 설정 패널 열기
  - 섹션 네비게이션
  - interface/history 값 변경
  - `setting.json` 반영
- `windows-tabs`
  - 다중 탭 생성
  - 탭 메뉴 열기
  - 실행 중 탭 닫기 확인 모달
- `workspace-restore`
  - seeded `workspace.json` 기반 startup restore
  - main/secondary window 복원
  - 복원된 mock PTY 재부착
- `image-paste`
  - test mode 이미지 주입
  - 미리보기 모달 표시
  - 드래프트에 캐시 이미지 경로 삽입
  - storage 섹션 캐시 통계 반영
  - 이미지 캐시 비우기
- `terminal-input`
  - 드래프트 열기
  - multiline 입력
  - `Ctrl+Enter` 전송
  - `Insert` / `Send` 차이 검증
  - mock PTY output snapshot 확인

다음 단계 후보:

- 직접 터미널 키 입력(`/`, `@`, `$`)
- IME/한글 입력 자동 검증

## Test mode

E2E는 실제 WSL/Claude에 의존하지 않도록 test mode를 사용한다.

- `CLCOMX_TEST_MODE=1`
- `CLCOMX_STATE_DIR=<temp dir>`

동작:

- mock WSL distro: `clcomx-test`
- mock 홈 경로: `/home/tester`
- mock PTY banner 출력
- 상태 파일은 temp dir에 격리 저장

즉 E2E는 로컬 `setting.json`, `workspace.json`, `tab_history.json`을 오염시키지 않는다.

## 로컬 Windows 실행

권장 경로는 **Windows 로컬 checkout**이다.

예:

- 현재 프로젝트 루트 `%CD%`
- mirror 사용 시 `C:\temp\clcomx`

실행:

```powershell
npm run test:e2e:windows
```

최초 1회 설치 포함:

```powershell
npm run test:e2e:windows -- -InstallTools
```

기존 debug exe 재사용:

```powershell
npm run test:e2e:windows -- -SkipBuild
```

특정 팩만 빌드 포함 실행:

```powershell
npm run test:e2e:windows -- -Project image-paste
```

이 경로가 권장인 이유:

- `cmd.exe`가 UNC working directory를 싫어함
- Windows Node optional dependency가 WSL `node_modules`와 충돌할 수 있음
- 보안 제품이 WSL->Windows chained command를 악성으로 볼 수 있음

## WSL에서 Windows 실행

WSL 원본을 유지하면서 Windows에서 E2E를 돌리고 싶다면 mirror 경로를 사용한다.

mirror:

- Windows: `C:\temp\clcomx`
- WSL: `/mnt/c/temp/clcomx`

mirror sync만 먼저:

```bash
npm run test:e2e:sync
```

WSL에서 전체 실행:

```bash
npm run test:e2e:wsl
```

설치 포함:

```bash
npm run test:e2e:wsl -- --install-tools
```

재빌드 없이:

```bash
npm run test:e2e:wsl -- --skip-build
```

특정 팩만 실행:

```bash
npm run test:e2e:wsl -- --project image-paste
```

이 경로는 내부적으로:

1. WSL 원본을 `C:\temp\clcomx`로 sync
2. mirror 안의 `scripts/e2e-smoke-windows.ps1` 실행
3. 실제 빌드/E2E는 Windows 로컬 경로에서 진행

## PowerShell runner

파일:

- `scripts/e2e-smoke-windows.ps1`

역할:

- Windows npm dependency 설치
- `tauri-driver` 설치
- `msedgedriver-tool.exe` 설치 및 실행
- `msedgedriver.exe`를 `.tools\windows\e2e`에 저장
- frontend/debug exe 빌드
- Vitest E2E 실행

중요:

- `msedgedriver.exe`는 PATH 전역 설치를 가정하지 않는다.
- runner가 다음 순서로 찾는다:
  1. PATH
  2. `.tools\windows\e2e\msedgedriver.exe`
  3. 프로젝트 루트의 `msedgedriver.exe`
- 개별 팩을 직접 실행할 때도 `e2e/helpers/tauri.ts`가 같은 탐색 규칙을 사용한다.

## 파일 구조

```text
e2e/
├── helpers/
│   ├── tauri.ts
│   ├── launcher.ts
│   ├── settings.ts
│   └── tabs.ts
├── smoke/
│   └── smoke.test.ts
├── settings/
│   └── settings.test.ts
├── windows-tabs/
│   └── windows-tabs.test.ts
├── image-paste/
│   └── image-paste.test.ts
├── terminal-input/
│   └── terminal-input.test.ts
└── workspace-restore/
    └── workspace-restore.test.ts
```

## selector 규칙

E2E는 `data-testid`를 기준으로 동작한다.

주요 surface:

- `app-root`
- `session-launcher`
- `launcher-new-session`
- `launcher-distro-*`
- `launcher-directory-*`
- `launcher-open-here`
- `settings-button`
- `settings-modal`
- `settings-nav`
- `settings-body`
- `tab-bar`
- `terminal-shell`
- `terminal-draft-toggle`
- `terminal-draft-textarea`
- `terminal-draft-insert`
- `terminal-draft-send`
- `close-tab-dialog`
- `image-paste-modal`
- `settings-storage-files`
- `settings-storage-size`

새 UI를 추가할 때 E2E 후보라면 `data-testid`를 같이 넣는 것이 좋다.

## 로그 규칙

모든 E2E 팩은 단계별 로그를 남긴다.

- 공용 helper: `e2e/helpers/log.ts`
- 형식: `[{scope}] {message}`
- 오류 시에는 가능한 한 현재 selector 상태, state file 경로, 주요 속성값을 같이 출력

권장 예:

- `waiting for app root`
- `opening settings`
- `session count is at least 2`
- `persistence timeout { ... }`

이 규칙의 목적은 실패 로그만으로 어느 단계에서 멈췄는지 바로 좁힐 수 있게 하는 것이다.

## 실행 예시

전체 팩:

```powershell
npm run test:e2e:windows -- -SkipBuild
```

smoke만:

```powershell
npm run test:e2e:smoke
```

settings만:

```powershell
npm run test:e2e:settings
```

windows-tabs만:

```powershell
npm run test:e2e:windows-tabs
```

workspace-restore만:

```powershell
npm run test:e2e:workspace-restore
```

image-paste만:

```powershell
npm run test:e2e:image-paste
```

terminal-input만:

```powershell
npm run test:e2e:terminal-input
```

## 실패 시 진단 순서

1. 앱 바이너리 확인
- `src-tauri\target\debug\clcomx.exe`

2. tool 설치 확인
- `tauri-driver.exe`
- `msedgedriver.exe`

3. runner 위치 확인
- Windows 로컬 경로인지
- UNC 경로에서 돌리고 있지 않은지

4. test mode 상태 확인
- temp state dir 아래 `setting.json`, `workspace.json`, `tab_history.json` 생성 여부

5. selector mismatch 확인
- 최근 UI 변경 후 `data-testid`가 바뀌지 않았는지

6. mock flow 확인
- `clcomx-test`
- `/home/tester`
- `/home/tester/workspace`

## CI

현재:

- `.github/workflows/e2e-smoke.yml`
- 수동 `workflow_dispatch`

향후:

- smoke 안정화 후 PR gate 승격
- `settings`, `windows-tabs` pack 추가
- 이후 직접 터미널 입력과 IME 검증 팩 추가
