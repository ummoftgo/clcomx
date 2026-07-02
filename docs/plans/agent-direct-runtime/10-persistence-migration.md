# Persistence and Migration

> 이 문서는 direct runtime 세션의 **저장·복원·migration**을 다운스트림 구현 에이전트가 이 문서만 읽고 구현할 수 있는 수준으로 정의한다. **모든 타입은 [`15-data-contracts.md`](15-data-contracts.md) §7을 인용**하며 여기서 재정의하지 않는다. 상태 머신/approval cleanup 규칙은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)를 인용한다. 미확정 항목은 본문에서 `결정 필요`로 표기하고 [`13-risks-open-questions.md`](13-risks-open-questions.md)로 연결한다.
>
> **정합 기준**: 코드 스냅샷 commit `e7a5f9e`; 구현 전 현재 작업트리와 대조. 코드 현실 근거는 [`research/codebase-backend.md`](research/codebase-backend.md) §4(영속화 계층)·§10(분리/공존 권고), [`research/codebase-frontend.md`](research/codebase-frontend.md) §4.3(workspace.ts)·§8(타입)·§10(통합 체크리스트)이다.

---

## 1. 목표와 불변식

기존 PTY session history를 보존하면서 direct runtime session metadata를 추가한다. migration은 비파괴적이어야 하며, 기존 사용자의 recent history가 깨지면 안 된다.

핵심 불변식 (모두 코드 현실에 근거):

1. **forward/backward 호환**: 새 필드는 전부 optional + serde default로 추가한다. 오래된 앱이 새 `workspace.json`을 읽어도, 새 앱이 기존 `workspace.json`을 읽어도 깨지지 않는다 (`research/codebase-backend.md` §4.2: "알 수 없는 필드는 `#[serde(default)]` 덕에 무시·기본값 처리").
2. **scrub 경계 유지**: provider session/thread id, resume token 같은 새 비밀은 기존 `pty_id`/`resume_token`과 **동일하게 디스크 저장 직전 scrub**한다. 새 비밀을 평문 영속화하면 기존 보안 경계가 깨진다 (`research/codebase-backend.md` §4.2·§10 권고 7, [`09-permissions-security.md`](09-permissions-security.md)).
3. **자동 변환 금지**: metadata 없는 세션은 `"pty"`로 normalize할 뿐, 기존 PTY 세션을 direct runtime으로 자동 변환하지 않는다. 사용자가 새 direct runtime 세션을 명시적으로 열 때부터 새 metadata를 저장한다.
4. **replay 우선, full cache는 후속**: 1차 범위는 재개·복원용 **metadata만** 저장하고, transcript 복원은 provider replay(ACP `session/load`, Codex `thread/read`)를 우선 쓴다. full transcript cache는 후속 단계 ([`13`](13-risks-open-questions.md) Resolved defaults: "transcript full cache는 1차 범위에서 제외").
5. **id 혼동 금지**: provider session id(resume 키)와 CLCOMX session handle(=tab id, [`15`](15-data-contracts.md) §6 `AgentSessionHandle`)을 절대 혼동하지 않는다. 별도 필드에 보존한다.

---

## 2. 저장 모델 (타입은 15 §7 인용)

저장 단위와 타입은 모두 [`15-data-contracts.md`](15-data-contracts.md) §7에 정의돼 있다. 여기서 **재정의하지 않고 역할만 정리**한다.

| 타입 / 필드 | 정본 위치 | 역할 |
|---|---|---|
| `SessionRuntimeKind` (`"pty"\|"direct-codex"\|"direct-claude"`) | 15 §7.1 | 세션을 구동하는 runtime 종류. 기존 세션은 미지정 → `"pty"` normalize. |
| `AgentRuntimeMetadata` (TS) | 15 §7.1 | direct runtime 재개·복원용 메타. transcript 전체가 **아니다**. |
| `SessionCore.runtimeKind?` (TS) | 15 §7.2 | `src/lib/types.ts` 확장(optional). |
| `WorkspaceTabSnapshot.runtimeKind?` / `.agentRuntime?` (TS) | 15 §7.2 | Rust↔TS 교환 포맷 확장(모두 optional). |
| `AgentRuntimeMetadataRecord` (Rust) | 15 §7.3 | `features/workspace/types.rs` 미러. `#[serde(default)]`. |

> **frontend 정합 (15 §7.2 주의 인용)**: `SessionViewMode`(`"terminal"|"editor"`)를 `"agent"`로 확장하지 **않는다**. viewMode는 host 내부 surface 토글이고 `runtimeKind`는 host 종류 자체다 (`research/codebase-frontend.md` §8, §10). 새 필드는 `session-factory.buildSession` → `SessionShellSession`/`SessionHostProps` → `createSessionHostProps` → `SessionShell.svelte` 옵션 B 분기로 전파한다(같은 문서 §10 체크리스트 1~5).

### 2.1 저장되는 metadata 항목 (1차 범위)

direct runtime 세션 1개당 `AgentRuntimeMetadata`에 저장하는 항목(전부 15 §7.1 필드):

- `sessionRuntimeKind`, `provider` — 복원 시 어느 adapter를 띄울지 결정.
- `providerSessionId` / `providerThreadId` — 재개 키(**scrub 대상**, §6).
- `lastTurnId` — 마지막 완료 turn(진단/표시용).
- `providerResumeToken` — provider별 resume 토큰(**scrub 대상**, §6).
- `protocolVersion` / `adapterVersion` / `providerVersion` — 호환성 추적(§7).
- `sandbox` / `approvalPolicy` / `approvalsReviewer` / `permissionMode` / `sessionMode` — 권한·모드 badge 표시용 non-secret metadata(09 §8.2).
- `canResume` / `canLoad` — 복원 전략 선택 입력(§4).

transcript 본문(메시지/tool call/diff)은 1차 범위에서 **저장하지 않는다**. 복원은 §4의 replay로 한다.

---

## 3. 디스크 직렬화 — optional + serde default 확장 (구현 단계)

### 3.1 TS 측 (`src/lib/types.ts`)

[`15`](15-data-contracts.md) §7.2가 정본이다. 구현 체크리스트:

- [x] `SessionCore`에 `runtimeKind?: SessionRuntimeKind` 추가(optional).
- [x] `SessionCore`에 `agentRuntimeStatus?: AgentSessionStatus` 추가. 이 값은 OQ-06 탭 badge용 live UI 상태이며 `WorkspaceTabSnapshot`에는 직렬화하지 않는다.
- [x] `WorkspaceTabSnapshot`에 `runtimeKind?: SessionRuntimeKind`, `agentRuntime?: AgentRuntimeMetadata` 추가(둘 다 optional).
- [x] `SessionRuntimeKind`/`AgentRuntimeMetadata` 타입을 `src/lib/features/agent-runtime/contracts/metadata.ts`에 정의하고 `types.ts`에서 import한다. 15 §7.1과 미러.
- [x] `DEFAULT_SETTINGS`/세션 생성 기본값에 영향 없음(전부 optional). (`research/codebase-frontend.md` §10 체크리스트 1)

### 3.2 frontend 저장 마스킹 (`src/lib/workspace.ts`)

> **scrub 정본 주의 (15 §7.3)**: scrub의 정본 함수는 **backend Rust `sanitize_workspace_for_persist`**(`features/workspace/store.rs`)이며, scrub은 **backend 영속화 직전** 책임이다(§6). frontend `sanitizeWorkspaceSnapshotForSave`(`src/lib/workspace.ts`)는 기존 `ptyId`/`resumeToken`을 null 마스킹하는 보조 방어선일 뿐이고, 디스크 저장 직전의 최종 보안 경계는 backend가 보장한다.

저장 시 frontend `sanitizeWorkspaceSnapshotForSave`가 이미 `ptyId`/`resumeToken`을 null 마스킹한다 (`research/codebase-frontend.md` §4.3). direct runtime metadata도 동일 함수에서 보조적으로 마스킹한다(최종 scrub은 backend `sanitize_workspace_for_persist`, §6):

- [x] frontend `sanitizeWorkspaceSnapshotForSave`에 `agentRuntime` 내부 3필드(`providerSessionId`, `providerThreadId`, `providerResumeToken`)를 `undefined`로 마스킹하는 분기 추가(보조 방어선). `runtimeKind`/`provider`/버전 필드는 비밀이 아니므로 유지.
- [x] 저장 경로 `src/lib/features/workspace/session-store-snapshot.ts::createWorkspaceTabSnapshot`이 `runtimeKind`/`agentRuntime`을 `WorkspaceTabSnapshot`에 직렬화하도록 확장.
- [x] 복원 경로 `src/lib/features/session/service/live-session-workspace-sync.ts::createSessionCore`/`createRuntimeSession` 및 기존 세션 갱신 분기 `applyWorkspaceWindowSnapshot`이 새 필드를 세션 객체로 hydrate하도록 확장. 이 파일 본문은 2026-06-25 문서 정리에서 확인했으며, 더 이상 research 미확인 항목이 아니다([`13`](13-risks-open-questions.md) OQ-18 참조).

### 3.3 Rust 측 (`features/workspace/types.rs` + `store.rs`)

[`15`](15-data-contracts.md) §7.3이 정본(`AgentRuntimeMetadataRecord`, `runtime_kind`, `agent_runtime`). 구현 체크리스트:

- [x] `WorkspaceTabSnapshot`에 `runtime_kind: String`(`#[serde(default = "default_runtime_kind")]`, 기본 `"pty"`)과 `agent_runtime: Option<AgentRuntimeMetadataRecord>`(`#[serde(default, skip_serializing_if = "Option::is_none")]`) 추가.
- [x] `default_runtime_kind()` 헬퍼 추가(`default_view_mode`/`default_workspace_agent_id` 패턴, `research/codebase-backend.md` §4.2).
- [x] `AgentRuntimeMetadataRecord` struct를 15 §7.3대로 추가(`#[serde(rename_all = "camelCase")]`, `Default` derive).
- [x] **호환성 검증 (RED→GREEN)**: 기존 `runtime_kind`/`agent_runtime` 없는 `workspace.json`을 deserialize했을 때 `runtime_kind == "pty"`, `agent_runtime == None`이 나오는 round-trip 단위 테스트(§8, [`11`](11-testing-acceptance.md) Tauri tests).

> `WorkspaceTabSnapshot` 필드 추가 시 필요했던 `merge_workspace_snapshot`(`service/window_ops.rs`)와 frontend `WorkspaceSnapshot` 타입 동기화는 해소됐다(OQ-18). frontend 저장/복원/기존 세션 갱신 경로는 위 §3.2가 맡고, Rust `merge_workspace_snapshot`는 incoming `WorkspaceTabSnapshot`의 `runtime_kind`/`agent_runtime`을 보존하는 회귀 테스트로 고정한다.

---

## 4. 복원 / late-attach 전략 — provider replay vs snapshot

앱 재시작 후 또는 탭 재접속(late-attach) 시 direct runtime 세션을 어떻게 되살리는지. 전략 선택은 `AgentRuntimeMetadata.canResume`/`canLoad`와 [`15`](15-data-contracts.md) §6 `ResumeSessionParams.replay`로 결정한다.

### 4.1 두 축 구분 (혼동 주의)

- **late-attach(같은 프로세스 살아있음)**: direct runtime process가 **아직 살아 있는** 상태에서 frontend transcript surface가 재mount되는 경우. 이때는 backend의 message seq + snapshot/delta-since로 재생한다([`15`](15-data-contracts.md) §8.3 주석, `research/codebase-backend.md` §2.3·§10 권고 3). **provider 재호출 불필요.** (seq 필드는 후속 단계에서 message payload에 추가 — 현 계약 미포함, [`13`](13-risks-open-questions.md).)
- **cold restore(프로세스 죽음)**: 앱 재시작 등으로 process가 **없어진** 경우. process를 새로 spawn하고 protocol initialize 후 provider에게 과거 대화를 재구성하게 한다(replay) 또는 replay 없이 세션만 재개한다.

### 4.2 cold restore 결정 트리

```text
저장된 AgentRuntimeMetadata 읽기
  │
  ├─ runtimeKind == "pty" (또는 metadata 없음)
  │     └─▶ 기존 PTY 복원 경로 (변경 없음). 본 문서 §5.
  │
  ├─ runtimeKind == "direct-codex" | "direct-claude"
  │     ├─ providerSessionId/Token 없음 (scrub되어 디스크엔 항상 없음)
  │     │     └─▶ 재개 불가. §4.4 "복원 불가 시 처리".
  │     │         (주의: scrub 때문에 디스크 복원은 사실상 항상 이 경로 — §4.5)
  │     │
  │     ├─ canLoad == true  → ResumeSessionParams{ replay: true }
  │     │     • ACP: session/load (loadSession cap), 응답 전 session/update 스트림으로 transcript 재구성
  │     │            (ref-acp §3.4, §13 표 "session/load → session_loaded + 각 update")
  │     │     • Codex: thread/resume 또는 thread/read(includeTurns) (ref-codex §"thread/read")
  │     │     → AgentEvent: session_loaded + replay된 message/tool/plan events
  │     │
  │     └─ canLoad == false && canResume == true → ResumeSessionParams{ replay: false }
  │           • ACP: session/resume (sessionCapabilities.resume), replay 없이 재개
  │                  (ref-acp §3.5) — transcript는 비어 있음, 새 prompt부터 누적
  │           • Codex: thread/resume (turns 미포함)
  │           → AgentEvent: session_loaded (replay 없음)
```

규칙:

1. **replay 우선**: `canLoad`가 true면 항상 replay(`replay: true`)를 우선한다(사용자가 과거 대화를 다시 본다). replay 불가면 `canResume`로 fallback(transcript 빈 채 재개).
2. **capability 위치 비대칭 주의 (ACP)**: `session/load` 게이트는 top-level `AgentCapabilities.loadSession`, `session/resume` 게이트는 `sessionCapabilities.resume`다 (ref-acp §3.5 구현 주의). adapter는 각 메서드마다 올바른 위치를 본다. → `canLoad`/`canResume`는 adapter가 initialize 시 capability에서 채워 metadata에 저장해야 한다.
3. **replay 중 update 처리**: ACP `session/load`는 응답을 받기 **전에** `session/update` 스트림으로 transcript를 재구성한다. adapter는 load 응답 전 들어오는 update를 transcript 재구성용으로 처리한다(ref-acp §3.4). store upsert/replace 규칙은 [`04`](04-normalized-agent-model.md) §3을 그대로 따른다(replay도 일반 event apply와 동일 경로).
4. **상태 전이**: replay/resume 완료 후 세션은 `ready` 또는 `idle`로 간다([`04`](04-normalized-agent-model.md) §2.1). replay 중에는 `starting`을 유지하고, 완료 신호(load 응답 / thread/read 완료) 후 전이.

### 4.3 late-attach (process 생존)

- frontend transcript store가 비어 있고 process가 살아 있으면: backend `agent_runtime_get_snapshot`([`15`](15-data-contracts.md) §8.2)으로 `pendingRequestIds` 등 runtime 상태를 받고, message snapshot/delta-since(후속 seq 메커니즘)로 transcript를 재구성한다. **provider에게 replay를 요청하지 않는다**(이미 backend가 message를 보존).
- seq 메커니즘이 아직 없는 1차 단계에서는 late-attach 시 store를 재구성할 수 없으므로, **v1은 transcript surface를 process 생존 중 unmount하지 않는 방식**으로 회피한다. `SessionViewport`는 keyed session shell을 유지하고 `visible` prop만 바꾸며, `AgentTranscriptSurface`는 `visible=false`를 `.hidden` CSS로만 처리한다. 이 OQ-17 전제는 `SessionViewport.test.ts` FE-21과 `AgentTranscriptSurface.test.ts` OQ-17로 고정됐다. 반대로 실제 탭 close/component unmount는 `AgentTranscriptSurface.test.ts` 10 §4.3 회귀 테스트가 direct runtime `shutdown`을 정확히 한 번 호출함을 검증한다. message seq + snapshot/delta-since 기반 late-attach 재구성은 후속이다.

### 4.4 복원 불가 시 처리 (fallback)

cold restore에서 재개 키가 없거나(scrub됨), provider가 resume/load를 모두 미지원(`canResume==false && canLoad==false`)이거나, replay/resume 호출이 에러로 실패하면:

1. transcript는 빈 새 세션으로 시작하되, **세션 탭은 유지**한다(사용자 작업 컨텍스트 보존). 헤더에 "이전 대화를 복원할 수 없습니다" 류 locale 메시지 표시([`11`](11-testing-acceptance.md) FE-24b/FE-24c, i18n key). `AgentTranscriptSurface`는 provider id가 scrub된 경우 `resumeSession`을 건너뛰고, provider `resumeSession`/load 호출이 실패한 경우 실패 controller를 정리한 뒤 새 `startSession`으로 낮춘다.
2. 새 direct runtime spawn 자체가 실패하면 §4.6 fallback 선택지를 제시.

### 4.5 scrub와 cold restore의 상호작용 (중요한 함의)

§6 scrub 정책상 `providerSessionId`/`providerThreadId`/`providerResumeToken`은 **디스크에 저장되지 않는다**. 따라서:

- **메모리 내 세션(앱 실행 중)**: `WorkspaceState`의 메모리 snapshot에는 scrub 전 값이 살아 있으므로(디스크 저장 직전에만 scrub, `research/codebase-backend.md` §4.2), 같은 실행 동안의 탭 이동/창 이동/late-attach는 정상 복원된다.
- **앱 재시작 후 cold restore**: 디스크에 재개 키가 없으므로 §4.2 트리는 사실상 "재개 불가" 경로로 빠진다 → §4.4. 즉 **1차 범위에서 앱 재시작 후 과거 direct 대화 복원은 기본적으로 불가**하며, 이는 PTY resume token이 재시작 후에도 복원 안 되는 현 동작과 일관적이다(PTY도 scrub).
- v1 결정: 앱 재시작 후 direct 대화 복원은 **지원하지 않는다**([`13`](13-risks-open-questions.md) OQ-16 해소). 재개 키를 디스크에 저장하지 않는 scrub 경계를 우선하며, scrub된 cold restore metadata는 §4.4 복원 불가 notice + 새 direct start로 처리한다. 앱 재시작 후 direct 복원을 원하면 재개 키를 (a) OS secret store에 저장하거나 (b) provider 자체 session store에 의존(provider가 sessionId만으로 최신 세션을 찾을 수 있는지)하는 별도 후속 scope로 설계해야 한다.

### 4.6 direct runtime 실패 시 fallback 선택지

direct runtime spawn/initialize 실패(바이너리 없음, 버전 불일치, allowlist 거부, initialize timeout) 시 사용자에게 선택지를 **표시**한다(자동 폴백 금지 — 사용자 의도 보존):

| 선택지 | 동작 | 근거 |
|---|---|---|
| legacy PTY 새 세션 | 같은 agent를 기존 PTY 경로(`pty_spawn` + `buildStartCommand`)로 연다. transcript는 terminal surface로. | `research/codebase-backend.md` §6, [`11`](11-testing-acceptance.md) E2E "direct runtime 실패 후 legacy PTY fallback" |
| legacy PTY resume | direct 재개 키가 아닌 **legacy resume token**이 있으면 PTY resume로 연다(`buildResumeCommand`). | PTY resume token은 별도 보존(§5) |
| 재시도 | 같은 direct runtime을 다시 spawn(버전/경로 교정 후). | |
| 취소 | 빈 탭 유지. | §4.4 |

- direct → PTY fallback 시 `runtimeKind`는 PTY 세션 생성 시점에 `"pty"`로 다시 설정된다(새 세션이므로). 기존 direct metadata는 폐기하거나 표시용으로만 남긴다(결정: 폐기 권장, 혼선 방지).
- legacy PTY resume token은 direct 전환과 무관하게 기존 `resume_token` 필드/scrub 정책을 그대로 유지한다(§5).

### 4.7 runtime scrollback replay (read-only history inspection)

긴 세션에서 transcript memory residency가 oldest sealed turn의 body를 evict하면([`04`](04-normalized-agent-model.md) §3.7 seal/eviction 규칙, [`08`](08-ui-composition.md) §5 `TranscriptTurnResidency`), 해당 turn은 `evicted-tombstone`(body 없음) 상태로 남는다. 사용자가 그 tombstone 구간을 스크롤백에서 **명시적으로 열 때만**(자동 아님) 동작하는 read-only 조회 경로를 정의한다. 이는 §4.2 cold restore와 **다른 축**이다 — 복원이 아니라 *지나간 기록의 일시 조회*다.

**동작**:

- tombstone 구간에 "이전 기록 불러오기" affordance를 노출한다([`08`](08-ui-composition.md) §7.2). 사용자가 누르면:
  - `canLoad == true`이면 provider replay(ACP `session/load`, Codex `thread/read(includeTurns)`)를 **별도 scratch 세션**으로 1회 돌려 해당 구간을 조회하고, **live store에 병합하지 않는다**. 조회 결과는 격리된 read-only 뷰로만 보여주고(현재 streaming 중인 live transcript와 충돌·간섭 없음), 조회 성공/실패 뒤 scratch 세션을 폐기한다. 뷰 닫기·unmount는 중복 폐기를 막는 보조 cleanup이다([`12`](12-implementation-workstreams.md) T5.6).
  - `canLoad == false`이면 replay 자체가 불가하므로 "이전 기록을 불러올 수 없습니다" 류 locale notice를 표시하고 끝낸다(scratch 세션 미생성).

**명확한 경계 (혼동 주의)**: 이 경로는

1. **복원(restore)이 아니다** — live 세션 상태를 되살리지 않는다(§4.2 cold restore와 구분: "`canLoad`면 항상 replay" 복원 규칙은 앱 재시작 시 자동 적용이고, 여기 scrollback inspection은 사용자가 tombstone을 눌러야만 1회 조회한다).
2. **full transcript cache가 아니다** — 전체 transcript를 메모리/디스크에 상주시키는 캐시를 도입하지 않는다(불변식 §1 #4·§2.1 "metadata만 저장, transcript 복원은 replay 우선" 정책 불변).
3. **디스크에 저장하지 않는다** — cold/tombstone body는 runtime-only(미영속)이며, scratch replay 결과도 영속화하지 않는다. metadata-only + replay-first(§1 불변식 4·§2.1) 정책은 그대로 유지된다.

즉 본 절은 **read-only history inspection** 전용이며, §4.2/§4.3의 복원·late-attach 경로와 저장 모델을 일절 바꾸지 않는다.

**Codex replay 범위(확정)**: `codex-cli 0.142.2` app-server 실측에서 `thread/read{includeTurns:true}`는 전체 thread snapshot을 반환한다([`13`](13-risks-open-questions.md) OQ-54 해소). 따라서 Codex tombstone inspection은 gap-only 조회가 아니라 full snapshot scratch replay이며, provider port 수집과 scratch reduce에 `DEFAULT_REPLAY_EVENT_LIMIT` 상한을 적용하고 상한 초과 시 read-only 패널에 partial notice를 표시한다. seal/eviction·late-event·tombstone 불변식의 정본은 [`04`](04-normalized-agent-model.md) §3.7, view-model(`TranscriptTurnResidency`/`TranscriptModel`)의 정본은 [`08`](08-ui-composition.md) §5, 격리 replay 뷰 구현은 [`12`](12-implementation-workstreams.md) T5.6이다.

> 시퀀스 다이어그램은 신규로 추가하지 않는다([`14`](14-sequence-and-state.md)). 본 경로는 live AgentEvent 흐름이 아니라 사용자가 명시적으로 여는 read-only inspection(별도 scratch 세션, live 미병합)이므로 14의 live 시퀀스에 편입되지 않는다.

---

## 5. Migration 규칙 (기존 → 신규)

비파괴·점진. 자동 변환 없음.

1. **metadata 없으면 `"pty"`로 normalize**: 기존 `workspace.json`/`SessionPersistedState`/`WorkspaceTabSnapshot`에 `runtimeKind`/`agentRuntime`가 없으면 `runtimeKind = "pty"`, `agentRuntime = undefined`로 해석한다. Rust는 `#[serde(default = "default_runtime_kind")]`로, TS는 복원 시 `?? "pty"`로 채운다.
2. **legacy resume token은 그대로 PTY token**: 기존 `resume_token`(alias `claudeResumeId`/`claude_resume_id`, `research/codebase-backend.md` §4.2)은 legacy PTY resume token으로 계속 해석한다. direct runtime resume 키와 혼동하지 않는다(별도 `agentRuntime.providerResumeToken`).
3. **자동 변환 안 함**: 기존 PTY 세션을 열 때 direct runtime으로 자동 승격하지 않는다. 사용자가 launcher에서 direct runtime을 명시 선택해 **새 세션**을 만들 때부터 `runtimeKind = "direct-*"` + `agentRuntime`를 채운다(`session-factory.buildSession`, `research/codebase-frontend.md` §10 체크리스트 2).
4. **다운그레이드 안전**: 사용자가 구버전 앱으로 롤백하면 구버전은 `runtimeKind`/`agentRuntime`를 모르는 필드로 무시하고(serde default), direct 세션을 PTY로 열려고 시도할 수 있다 → 이는 §4.6 fallback과 동일하게 처리되거나(구버전엔 fallback UI 없음) 빈 PTY 세션이 된다. 데이터 손상은 없다(파일은 여전히 valid JSON).
5. **history 모듈**: `TabHistoryEntry`(`features/history/mod.rs`)에는 **direct provider 식별자**(`providerSessionId`/`providerThreadId`/`providerResumeToken`)를 저장하지 않는다. history는 `resume_token`을 항상 `None`으로 강제하는 정책이므로(`research/codebase-backend.md` §4.4), direct 재개 키도 동일하게 history에 넣지 않는다. 단 `runtimeKind`는 비밀이 아닌 host 표식이므로 optional로 저장해 최근 항목에서 direct host를 다시 선택하고 direct 배지를 표시한다. dedupe key는 `agent_id`/`distro`/`work_dir`/정규화된 `runtimeKind`이며, `None`/`"pty"`는 legacy PTY로 합쳐진다. 따라서 같은 경로의 PTY/direct 항목은 서로 덮어쓰지 않는다. 최근 항목 재열기는 provider id가 없으므로 **새 direct start**이며, transcript resume/load 복원은 history 책임이 아니다.

마이그레이션 단계별 체크리스트:

- [x] Rust: 기존 파일 deserialize → `runtime_kind` 기본 `"pty"` 확인 테스트.
- [x] TS: 복원 시 `runtimeKind` 미지정 → `"pty"` normalize 확인.
- [x] launcher: direct runtime 선택 → 새 세션에만 `runtimeKind` 설정(`session-factory.buildSession`).
- [x] 기존 PTY 세션 open 회귀 없음 확인([`11`](11-testing-acceptance.md) E2E "기존 PTY session open이 깨지지 않는지"). 증거: 2026-06-29 `npm run test:e2e:wsl -- --skip-build` 전체 순차 실행(9 projects / 25 tests)에서 `smoke` mock PTY session open과 `agent-runtime`의 direct 미선택 legacy PTY session spec 통과.

---

## 6. Scrub 경계 (정본은 15 §7.3 보안 경계)

[`15`](15-data-contracts.md) §7.3 "보안 경계"가 정본이다. 요약·구현 지점:

scrub 대상(디스크 저장 직전 제거): `providerSessionId`, `providerThreadId`, `providerResumeToken`. 기존 `pty_id`/`resume_token`과 **동일 등급**으로 다룬다.

**scrub 정본 함수 = backend Rust `sanitize_workspace_for_persist`**(`features/workspace/store.rs`, 정본 15 §7.3). scrub은 **backend 영속화 직전**의 책임이며, 이 함수가 디스크 저장 전 최종 보안 경계를 보장한다. frontend 마스킹은 보조 방어선이다(아래).

scrub 적용 지점(backend가 정본 경계, frontend는 보조):

- [x] **backend (정본)**: `features/workspace/store.rs`의 `sanitize_workspace_for_persist`(store.rs:140-149, `research/codebase-backend.md` §4.2)에 `agent_runtime` 내부 3필드 제거 추가 — 디스크 저장 직전의 최종 scrub. read 경로 `scrub_workspace_resume_tokens`(store.rs)에도 동일 청소를 더해 legacy 파일에 우연히 남은 값을 한 번 더 제거.
- [x] **frontend (보조)**: `src/lib/workspace.ts`의 `sanitizeWorkspaceSnapshotForSave`에 위 3필드 마스킹 추가(§3.2). 최종 보안 경계는 backend `sanitize_workspace_for_persist`가 보장하므로 이는 추가 방어선이다.
- [x] **history**: `features/history/mod.rs`는 direct provider 식별자/재개 키를 애초에 저장하지 않음(§5.5). 추가 scrub 불필요하되, `resume_token`은 계속 `None`으로 강제하고 `runtimeKind`는 `"direct-codex"|"direct-claude"`만 보존, `"pty"`/미지정/기타 값은 legacy PTY(`None`)로 정규화하는 것을 테스트로 고정. Frontend `recordTabHistoryEntry`도 Tauri payload에서 `resumeToken:null`을 강제하며, launcher는 stale direct history entry에 `resumeToken`이 남아 있어도 token row를 표시하지 않는다.

scrub 비대상(평문 저장 OK): `runtimeKind`, `provider`, `lastTurnId`, `protocolVersion`, `adapterVersion`, `providerVersion`, `canResume`, `canLoad`. 비밀이 아니며 호환성/표시/복원전략 선택에 필요하다.

> scrub 검증 테스트: 임의 `agentRuntime`를 채운 snapshot을 저장 → 디스크 JSON에 `providerSessionId`/`providerThreadId`/`providerResumeToken`가 **없는지** assert (frontend·backend 양쪽, [`11`](11-testing-acceptance.md) Tauri tests / Frontend tests).

---

## 7. 버전 핀과 호환성 메타

`AgentRuntimeMetadata`의 `protocolVersion`/`adapterVersion`/`providerVersion`은 복원/진단 시 호환성 판단에 쓴다.

- **저장 시점**: adapter가 initialize 직후(협상된 protocol 버전 확보 후) metadata에 기록한다.
- **복원 시 mismatch 처리**: 저장된 `protocolVersion`/`providerVersion`이 현재 환경과 크게 다르면(예: provider major 버전 변경), replay가 실패할 수 있다 → §4.4 복원 불가 처리로 graceful 폴백하고 로그에 mismatch를 남긴다. **버전 비교로 자동 거부하지 않고**, 실패 시에만 폴백한다(provider가 하위 호환일 수 있으므로).
- protocol drift 위험은 [`13`](13-risks-open-questions.md) "Protocol drift"에 등록돼 있다(generated type/runtime package version 고정 + schema diff 검토).

---

## 8. 호환성 / 테스트 포인트 (정본은 11)

[`11-testing-acceptance.md`](11-testing-acceptance.md)에 등록된 항목과 1:1로 연결한다. persistence 관련 테스트는 다음을 반드시 포함한다(없으면 11에 추가):

| 테스트 | 위치([`11`](11-testing-acceptance.md)) | 검증 내용 |
|---|---|---|
| 기존 `workspace.json` round-trip | Tauri tests | `runtime_kind`/`agent_runtime` 없는 파일 → 기본 `"pty"`/`None`. forward/backward 호환. |
| 새 metadata round-trip | Tauri tests | `runtimeKind`/`agentRuntime` 저장 후 재로드 시 비-scrub 필드 보존. |
| scrub 단위 테스트 | Tauri / Frontend tests | 디스크 JSON에 3개 비밀 필드 부재. |
| scrub된 direct cold restore | E2E | `providerThreadId`/`providerSessionId` 없는 persisted direct `workspace.json` → fresh direct session + 복원 불가 notice. |
| 기존 PTY session open 회귀 | E2E | "기존 PTY session open이 깨지지 않는지" |
| direct 실패 → PTY fallback | E2E | "direct runtime 실패 후 legacy PTY fallback 선택" |
| metadata 복원 표시 | Frontend tests | "direct runtime metadata 저장/복원 표시" |
| 다운그레이드(구버전 deserialize) | Tauri tests(추가 권장) | 새 필드 무시 + valid JSON 유지. |

테스트 격리는 기존 패턴 재사용: Rust는 `app_env::test_support::set_state_dir_env(&tmp)` guard(`research/codebase-backend.md` §4.1·§8.1), frontend는 `invoke`/`listen` 모킹(`src/test/mocks/tauri.test.ts`, 같은 문서 §8.2). 새 상태 파일을 추가하지 않고 기존 `workspace.json` 확장만 쓰므로 신규 fixture 인프라는 불필요하다.

---

## 9. 데이터 정리 (debug log / provider store)

- **protocol debug log**: direct runtime 실험 중 생성된 raw protocol log는 기본 비활성화이며 opt-in redacted debug mode만 둔다([`13`](13-risks-open-questions.md) Resolved defaults, [`09-permissions-security.md`](09-permissions-security.md) §debug). 활성화 시에도 §6 scrub 대상 값은 redaction 후 기록한다. **세션 삭제 시 해당 세션의 debug log도 함께 삭제**한다.
- **provider 자체 session store**: provider(Codex `~/.codex` thread store, Claude session store 등)는 provider가 관리한다. CLCOMX는 이를 임의로 삭제·변조하지 않는다. CLCOMX가 지우는 것은 자신의 `workspace.json` 항목과 자신이 만든 debug log뿐이다.
- **세션 close/삭제 흐름**: 기존 `close_session`(`commands/workspace.rs`, `WorkspaceState`+`PtyState` 동시 주입)이 PTY를 정리하듯, direct 세션 close는 `agent_runtime_shutdown`([`15`](15-data-contracts.md) §8.2)으로 process graceful shutdown + pending request cleanup([`04`](04-normalized-agent-model.md) §5)을 수행하고, workspace 항목을 제거한다. [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §Process lifecycle 참조.

---

## 10. 교차 참조

| 대상 | 문서 | 절 |
|---|---|---|
| persistence 타입 정본(`SessionRuntimeKind`/`AgentRuntimeMetadata`/`AgentRuntimeMetadataRecord`, scrub 경계) | [`15-data-contracts.md`](15-data-contracts.md) | §7 |
| 복원 시 event apply·approval cleanup·상태 전이 규칙 | [`04-normalized-agent-model.md`](04-normalized-agent-model.md) | §2, §3, §5 |
| `ResumeSessionParams.replay`·`AgentRuntimeSnapshot`·command 계약 | [`15-data-contracts.md`](15-data-contracts.md) | §6, §8 |
| process lifecycle·shutdown·late-attach seq | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) | 전체 |
| ACP session/load·session/resume·capability 위치 | [`ref-acp-protocol.md`](ref-acp-protocol.md) | §3.4, §3.5, §13 |
| Codex thread/resume·thread/read | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) | §"thread/resume", §"thread/read" |
| seal/eviction·late-event·tombstone 불변식(§4.7 근거) | [`04-normalized-agent-model.md`](04-normalized-agent-model.md) | §3.7 |
| transcript view-model 정본(`TranscriptTurnResidency`/`TranscriptModel`)·scrollback affordance | [`08-ui-composition.md`](08-ui-composition.md) | §5, §7.2 |
| 격리 read-only replay 뷰 구현(§4.7) | [`12-implementation-workstreams.md`](12-implementation-workstreams.md) | T5.6 |
| `thread/read(includeTurns)` full snapshot 실측 | [`13-risks-open-questions.md`](13-risks-open-questions.md) | OQ-54 |
| 영속화 코드 현실(scrub·default·merge) | [`research/codebase-backend.md`](research/codebase-backend.md) | §4, §10 |
| frontend 타입·workspace.ts·통합 체크리스트 | [`research/codebase-frontend.md`](research/codebase-frontend.md) | §4.3, §8, §10 |
| 보안·redaction·debug 정책 | [`09-permissions-security.md`](09-permissions-security.md) | 전체 |
| 테스트·수용 기준 | [`11-testing-acceptance.md`](11-testing-acceptance.md) | 전체 |
| 미확정·결정 필요 항목 | [`13-risks-open-questions.md`](13-risks-open-questions.md) | 전체 |
</content>
