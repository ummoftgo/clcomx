# OQ-16 — Cross-restart Direct 대화 복원 (하이브리드) 설계 spec

작성일: 2026-07-02 · 상태: 설계 승인 대기 → 구현 계획 예정 · 브랜치: `feat/agent-runtime-impl`

> 이 문서는 [`13-risks-open-questions.md`](13-risks-open-questions.md) **OQ-16**의 후속 scope를 설계한다. v1은 앱 재시작 후 direct 대화 복원을 **의도적으로 제외**했고(scrub 정책의 직접 결과, [`10-persistence-migration.md`](10-persistence-migration.md) §4.5), OQ-16 결론은 "복원을 원하면 OS secret store 또는 provider session store 의존을 새 후속 scope로 설계"였다. 이 문서가 그 후속이다. 타입 정본은 [`15-data-contracts.md`](15-data-contracts.md), 규칙 정본은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md), 저장/복원 정본은 [`10-persistence-migration.md`](10-persistence-migration.md), 보안 정본은 [`09-permissions-security.md`](09-permissions-security.md)이며 이 문서는 재정의하지 않고 인용·확장한다.

## 1. 배경 — 왜 지금 "거의 다 돼 있는가"

감사 결과 확인된 사실(코드 정본):

- **resume 경로는 이미 완전히 배선됨.** [`AgentTranscriptSurface.svelte`](../../../src/lib/features/agent-runtime/view/AgentTranscriptSurface.svelte)의 `buildResumeConfig`(:86)·`isRestoreUnavailable`(:101)가 `AgentRuntimeMetadata`의 provider id 유무만 보고, id가 있으면 :397에서 `port.resumeSession(...)`을 호출한다. 실패 시 :423이 실패 controller를 정리하고 fresh start + "복원 불가" notice로 낮춘다.
- **재개 키는 `providerThreadId`(Codex) / `providerSessionId`(Claude) 두 개뿐이다.** `ResumeSessionParams`([`runtime-port.ts`](../../../src/lib/features/agent-runtime/contracts/runtime-port.ts):29)가 이 둘 + `replay: boolean`을 받는다. Codex `resumeSession`은 `thread/resume`(replay=false) 또는 `thread/read`(replay=true, 권위 turn replay)를, Claude는 `session/resume`/`session/load`를 호출한다. `canResume`/`canLoad`는 adapter가 initialize capability에서 채운다(위치 비대칭: `loadSession`=top-level, `resume`=`sessionCapabilities.resume`).
- **`providerResumeToken`은 dead 필드다.** [`metadata.ts`](../../../src/lib/features/agent-runtime/contracts/metadata.ts):32에 선언만 있고 어느 adapter의 resume 경로도 소비하지 않는다.
- **유일한 공백**: provider id가 backend `sanitize_workspace_for_persist`([`store.rs`](../../../src-tauri/src/features/workspace/store.rs) `scrub_agent_runtime_secrets`)에서 scrub되어 **디스크에 없다.** 그래서 cold restart 때 `buildResumeConfig`가 항상 `undefined`를 반환해 fresh start로 떨어진다([`10`](10-persistence-migration.md) §4.5).

즉 이 작업은 "resume 구현"이 아니라 **재개 id를 재시작에도 살아남는 곳에 안전하게 두는 것 + 즉시 표시용 히스토리 캐시**다.

## 2. 목표와 비목표

**목표(하이브리드 복원):**
1. 앱 재시작 후 direct 세션 탭이 지난 대화를 **읽기 전용 히스토리로 즉시** 보여준다.
2. provider가 지원(`canResume`/`canLoad`)하고 재개 id가 있으면 **live resume**로 같은 세션을 이어간다(권위 replay가 히스토리를 대체).
3. 재개 id 없음/미지원/실패 시 히스토리 read-only + "이어가려면 새 세션" affordance로 우아하게 낮춘다.

**비목표(YAGNI):**
- 무제한 full 히스토리 영속화 — residency 윈도우 범위로 bound한다.
- `providerResumeToken` 부활 — 계속 scrub.
- cross-device / 클라우드 동기화.
- legacy PTY 복원 경로 변경(기존 유지).

## 3. 결정 사항 (브레인스토밍 확정)

| 결정 | 값 | 근거 |
|---|---|---|
| 복원 의미 | 하이브리드(히스토리 + 가능시 live resume) | 사용자 선택 |
| 재개 id 저장 | **암호화 app-data(at-rest)** | 사용자 선택. bearer 아닌 포인터지만 방어적 암호화 |
| 암호화 키 소스 | OS 키스토어의 **단일 앱 키 1개**(세션별 아님) | "암호화 app-data(중간)" posture — 키체인 엔트리 1개로 full per-secret keychain(과임) 회피 |
| transcript 캐시 | residency 윈도우(OQ-52) 범위로 **bound** | full cache는 YAGNI, 권위는 provider replay |
| resume 실행 시점 | **탭 포커스 시 지연**(boot 시 전 세션 동시 spawn 금지) | 예약된 "다중 세션 동시 복원 AppHang 수정"과 복원 경로 공유 |
| `providerResumeToken` | 계속 scrub | dead 필드, 보안 경계 유지 |

## 4. 아키텍처 / 컴포넌트

**재사용(변경 없음):** `AgentTranscriptSurface`의 `buildResumeConfig`/`isRestoreUnavailable`/`resumeSession` 호출부와 실패→fresh 낮춤 경로([`10`](10-persistence-migration.md) §4.4).

**신규 A — 암호화 재개 metadata 저장소** (backend, `src-tauri/src/features/agent_runtime/secret_store.rs`):
- 저장 단위: `(sessionHandle) → { providerThreadId?, providerSessionId?, canResume, canLoad }`.
- app-data 하위 파일에 **at-rest 암호화**(단일 앱 키). 키는 OS 키스토어 엔트리 1개(`clcomx.agent-runtime.mkey` 류)에서 로드, 없으면 최초 생성.
- Tauri command 확장 또는 workspace 저장 훅에서 호출. `providerResumeToken`은 저장하지 않음(scrub 유지).

**신규 B — bounded transcript 캐시** (frontend 직렬화 + backend 파일 IO):
- 대상: `TranscriptModel`([`transcript.ts`](../../../src/lib/features/agent-runtime/contracts/transcript.ts):104). `itemsById`/`turnsById`가 `Map`이라 **직렬화 시 Map→array, 복원 시 array→Map** 변환 헬퍼가 필요.
- 범위: residency 윈도우(`DEFAULT_TRANSCRIPT_RESIDENCY_CONFIG`)의 sealed-retained turn 본문만(이미 heap-bounded). tombstone 구간은 제외.
- redaction: 저장 전 display-redaction/scrub 통과분만(09 §3.4·§5 재사용) — 렌더와 동일한 env 값 마스킹 + credential 마스킹. 명령 전문/diff/파일 텍스트 같은 비밀 아닌 workspace 콘텐츠는 설계상 평문으로 캐시된다(§6 참조).
- 세션별 캐시 파일(app-data cache 디렉토리), 스키마 버전 필드 포함.

## 5. 데이터 흐름

**저장(세션 진행 중, 기존 workspace 저장 훅에 편승):**
1. 재개 id + `canResume`/`canLoad` → 신규 A(암호화 저장). `workspace.json` 평문 경계는 불변 — id는 거기 안 들어감.
2. bounded transcript 스냅샷(scrub본) → 신규 B(캐시 파일).

**복원(cold restart):**
```
탭 hydrate
  │
  ├─▶ (즉시) 캐시 transcript 렌더 — read-only, status="복원 중"
  │
  └─▶ (탭 포커스 시, 지연) 암호화 저장소에서 재개 id 복호화
        ├─ id 있음 & (canResume|canLoad) → resumeSession(replay = canLoad)
        │     ├─ 성공: provider 권위 replay가 캐시 대체, 세션 live 전환(ready/idle) — 이어가기 가능
        │     └─ 실패: 실패 controller 정리 → fresh startSession + "복원 불가" notice (10 §4.4)
        └─ id 없음/복호화 실패/미지원 → 캐시를 read-only 히스토리로 유지 + "이어가려면 새 세션" affordance
```
- **AppHang 대비**: boot 시 모든 direct 탭을 동시에 resume(=process spawn)하지 않는다. 캐시 렌더는 즉시(프로세스 없음), 실제 resume/spawn은 **탭 포커스 트리거**로 지연. 예약된 다중 세션 복원 순차/지연화 작업과 동일 원칙.

## 6. 보안 경계

- 평문 디스크에 재개 id 없음(암호화 저장). id는 bearer 아닌 provider 로컬 스토어 포인터지만 방어적으로 암호화(사용자 선택 posture).
- 암호화 키는 OS 키스토어 단일 엔트리. 키 유출 없으면 app-data 파일 단독으로는 복호화 불가.
- 캐시는 렌더와 동일한 display-redaction(env 값 마스킹 + credential 마스킹)을 통과한 콘텐츠를 담으며, 명령/diff/파일 텍스트 같은 **비밀 아닌 workspace 콘텐츠는 설계상 평문 캐시**된다(암호화 대상은 재개 id뿐)([`09`](09-permissions-security.md) §3.4·§5·§7.1).
- `providerResumeToken` scrub 유지(TB-3 경계 불변, [`09`](09-permissions-security.md):75).
- frontend `sanitizeWorkspaceSnapshotForSave`의 보조 마스킹과 backend `sanitize_workspace_for_persist`의 최종 scrub 경계는 그대로. 신규 저장은 이 경계 **밖의 별도 암호화 저장소**를 통하므로 기존 경계를 약화하지 않는다.

## 7. 오류 처리

| 상황 | 처리 |
|---|---|
| 암호화 키 부재/생성 실패 | id 없음과 동일 취급 → 히스토리-only 폴백 |
| 복호화 실패(키 회전/손상) | id 무시 → 히스토리-only 폴백 |
| resume RPC 실패/timeout | 실패 controller 정리 → fresh start + notice(10 §4.4 재사용) |
| 캐시 손상/스키마 버전 불일치 | 캐시 무시 → 빈 히스토리(graceful), 신규 세션 정상 |
| provider `canResume==false && canLoad==false` | resume 시도 안 함 → 히스토리-only + affordance |

## 8. 테스트 전략

- **Rust(신규 A)**: 암호화 저장/복호화 왕복, 키 부재/손상 시 graceful, `providerResumeToken` 여전히 미저장/scrub, app-data 파일 단독 복호화 불가.
- **Rust/프론트(신규 B)**: TranscriptModel Map↔array 직렬화 왕복, residency 윈도우 bound(tombstone 제외), redaction 적용(비밀 비포함), 스키마 버전 불일치 무시.
- **프론트(복원 흐름)**: 캐시 hydrate→즉시 read-only 렌더, resume 성공 시 캐시가 권위 replay로 대체, resume 실패/미지원 시 read-only 히스토리 + affordance, **탭 포커스 트리거 지연 resume**(boot 즉시 spawn 안 함).
- **E2E**: 암호화 재개 id + 캐시가 seed된 상태로 재시작 → 히스토리 표시 + (mock) resume 성공 이어가기 / resume 미지원 → 히스토리-only. 기존 E2E-12(scrub cold restore fresh start)와 공존(회귀 없음).

## 9. 범위 / 의존 / 연계

- **포함**: 신규 A(암호화 재개 id 저장), 신규 B(bounded transcript 캐시), 하이브리드 복원 흐름, 탭 포커스 지연 resume.
- **제외(YAGNI)**: full 무제한 캐시, resumeToken 부활, cross-device 동기화, legacy PTY 경로 변경.
- **연계**: 지연 resume는 예약된 "다중 세션 동시 복원 AppHang 수정"과 복원 오케스트레이션을 공유 → 함께 설계/구현하면 복원 경로를 두 번 손대지 않는다.
- **정본 갱신**: 구현 시 [`10`](10-persistence-migration.md) §4.4/§4.5와 [`13`](13-risks-open-questions.md) OQ-16을 "후속 구현됨"으로 갱신하고, 암호화 저장소 경계를 [`09`](09-permissions-security.md)에 새 TB로 추가한다.

## 10. 열린 질문(구현 계획에서 확정)

- OS 키스토어 접근 방식(Tauri plugin vs Rust `keyring` crate)과 WSL/Windows 대상에서의 키 저장 위치.
- 캐시 파일 위치·명명(app-data cache 디렉토리 규약)과 세션 GC(탭 삭제 시 캐시/암호화 엔트리 정리).
- resume 성공 시 캐시→권위 replay 전환의 정확한 dedup/replace 타이밍(캐시 item id와 replay item id 정합).
