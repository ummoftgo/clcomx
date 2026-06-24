# Direct Agent Runtime 계획서

확인일: 2026-06-24

## 목적

CLCOMX의 현재 에이전트 화면은 `claude`와 `codex`를 터미널 프로세스로 실행하고 xterm.js에 출력 스트림을 렌더링한다. 이 계획서는 터미널 에뮬레이터를 주 인터페이스로 삼는 구조에서 벗어나, Codex Desktop App이나 Claude Desktop App에 가까운 직접 통신 기반 transcript UI로 전환하기 위한 대형 작업 계획이다.

## 범위

- Codex는 `codex app-server`와 app-server protocol을 우선 연결면으로 삼는다.
- Claude는 Agent Client Protocol(ACP)과 `claude-agent-acp`를 우선 연결면으로 삼는다.
- 기존 PTY/xterm 기능은 삭제하지 않는다. direct runtime 도입 후에도 보조 셸, 명령 출력 embed, fallback 경로로 유지한다.
- 외부 근거는 공식 또는 라이선스가 명확한 오픈소스 자료만 사용한다. 유출본, 출처 불명 mirror, 라이선스가 불명확한 Claude Code 소스는 제외한다.

## 문서 순서

1. [01-source-map.md](./01-source-map.md): 조사한 공식/오픈소스 자료와 제외 기준
2. [02-current-state.md](./02-current-state.md): 현재 PTY/xterm 중심 구조
3. [03-target-architecture.md](./03-target-architecture.md): 목표 아키텍처
4. [04-normalized-agent-model.md](./04-normalized-agent-model.md): 공통 이벤트/세션 모델
5. [05-codex-app-server-adapter.md](./05-codex-app-server-adapter.md): Codex adapter 설계
6. [06-claude-acp-adapter.md](./06-claude-acp-adapter.md): Claude ACP adapter 설계
7. [07-tauri-process-runtime.md](./07-tauri-process-runtime.md): Tauri backend process/runtime 설계
8. [08-ui-composition.md](./08-ui-composition.md): 데스크톱 앱식 UI 구성
9. [09-permissions-security.md](./09-permissions-security.md): 권한, 보안, 감사 경계
10. [10-persistence-migration.md](./10-persistence-migration.md): 저장, 복원, migration
11. [11-testing-acceptance.md](./11-testing-acceptance.md): 테스트와 수용 기준
12. [12-implementation-workstreams.md](./12-implementation-workstreams.md): 구성별 작업 계획
13. [13-risks-open-questions.md](./13-risks-open-questions.md): 위험과 확정 기본값
14. [adr-001-direct-agent-runtime.md](./adr-001-direct-agent-runtime.md): 아키텍처 결정 기록

## 완료 기준

- 구현자가 Codex와 Claude 각각의 adapter를 독립적으로 만들 수 있을 정도로 입력, 출력, 상태, 오류, 권한 흐름이 정의되어 있다.
- 현재 PTY 기반 기능과 새 direct runtime의 경계가 명확하다.
- session, turn, message, tool call, approval, command output, file change, process exit가 공통 모델에서 표현된다.
- 테스트 계획이 fixture replay, adapter unit test, Tauri command test, frontend rendering test, E2E 회귀를 모두 포함한다.
