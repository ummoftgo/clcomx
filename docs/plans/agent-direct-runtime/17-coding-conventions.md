# Coding Conventions (정본 / single source of truth)

> 이 문서는 CLCOMX "Direct Agent Runtime"의 **코딩 규약 정본**이다. 이 plan의 모든 신규 코드(adapter, Tauri runtime, store/controller, Svelte 컴포넌트, 테스트)와 문서의 코드 예시는 여기 규약을 따른다. 다운스트림 구현 에이전트는 파일을 만들기 전에 이 규약을 내재화한다.
>
> **역할 분리**: 이 문서(17)는 **코드 스타일·구조·주석 규약**의 정본이다. **타입**은 [`15-data-contracts.md`](15-data-contracts.md)가, **규칙(상태머신·upsert·reconcile·approval 생명주기·식별자 라우팅)**은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)가, **모듈 배치(어떤 파일을 어디에 두는가)**는 [`12-implementation-workstreams.md`](12-implementation-workstreams.md) §0이, **wire 사실**은 ref-\*가 정본이다. 이 문서는 그 정본을 **재정의하지 않고 인용**한다. 충돌 시 위 정본이 우선한다.
>
> **코드 현실 정합**: 본 규약은 새로 만든 규칙이 아니라, 현 코드(`src/`·`src-tauri/`)가 이미 따르는 구조를 명문화한 것이다. 코드 인용은 [`research/codebase-frontend.md`](research/codebase-frontend.md)(이하 FE §)·[`research/codebase-backend.md`](research/codebase-backend.md)(이하 BE §)를 따르되, **충돌 시 실제 코드가 정본**이며 대조 후 사용한다.

확인일: 2026-06-25. 코드 정합 기준: 브랜치 `feat/claude-tui-fullscreen-option`.

---

## 0. 규약 요약 (정본 인덱스)

| 영역 | 규약 | 정본 절 |
|---|---|---|
| 파일/디렉토리 분리 | 도메인·기능 단위로 디렉토리·파일을 분리한다. 단일 파일에 길게 쓰지 않는다. | §A |
| 2000줄 임계 | 한 기능 내용이라도 파일이 2000줄을 넘으면 서브모듈/순수 함수로 분리를 반드시 검토한다. | §A.3 |
| 주석 언어·문체 | 한글 보고서체. 판교어·슬랭 금지. 과잉·자명한 주석 지양. | §B |
| doc-comment | 클래스/함수는 언어별 doc-comment(TS=JSDoc, Rust=rustdoc, PHP=PHPDoc)로 기능 1줄 + 인자 설명. | §B.1 |
| 핵심 로직 주석 | 비자명 분기·알고리즘(reconcile·cleanup·framing 등)에 한 줄 한글 주석. | §B.2 |
| 적용 범위 | 이 plan의 모든 신규 코드와 문서 코드 예시. 12의 각 task DoD에 포함. | §C |

> **권위 경계**: 본 규약은 코드의 *형태*만 정한다. 타입 모양은 15, 알고리즘 규칙은 04, 파일 *위치*는 12 §0이 정본이며 여기서 재정의하지 않는다.

---

## A. 파일/디렉토리 분리 (도메인·기능 단위)

### A.1 원칙

코드를 단일 파일에 길게 쓰지 않는다. **도메인/기능에 따라 디렉토리·파일을 분리한다**(장기 유지보수 목적). 한 파일은 하나의 명확한 책임을 갖는다.

### A.2 기존 코드 규약과의 정합 (확인된 사실)

이 원칙은 신규 규칙이 아니라 현 코드가 이미 따르는 구조다.

- **Frontend**: feature는 `src/lib/features/<feature>/{view,controller,state,contracts,service}` 레이어로 분리한다. view(`*.svelte`)는 로직 없는 렌더, controller(`create*Controller(deps)`)는 순수 TS DI 팩토리, state(`*-state.svelte.ts`)는 룬 class, contracts는 타입 interface, service는 순수 도메인 함수다 (FE §1).
- **Backend**: `commands/<x>.rs`는 얇은 `#[tauri::command]` wrapper이고 실제 로직·상태 타입은 `features/<x>/{mod,transport,process,types,tests}.rs`에 둔다. `pty.rs`/`workspace.rs`/`settings.rs`가 이 패턴을 따른다 (BE §3).
- **이 plan의 적용 사례**: 03/05/06/07/08/12의 모듈 배치가 이미 이 원칙을 따른다. 특히 Codex adapter를 단일 파일로 두지 않고 `codex-app-server-adapter.ts`(Port)·`codex-wire-mapper.ts`(매핑)·`codex-launch.ts`(start params)·`codex-routing.ts`(삼중 키 라우팅)로 **책임 단위로 분리**한 것이 대표 예다 (12 §0.1). backend도 `agent_runtime/{mod,transport,process,types,allowlist,tests}.rs`로 나뉜다 (12 §0.3).

### A.3 2000줄 임계

하나의 기능에 관련된 내용이라도 **파일이 2000줄을 초과하면 서브클래스/모듈/함수로 분리 가능한지 반드시 검토한다.** 예:

- reducer를 거대한 `applyEvent` 한 함수로 두지 말고 event 종류별 순수 함수로 쪼갠다 (04 §3 규칙은 04가 정본).
- router를 라우팅 키 분기별 헬퍼로 분리한다.
- adapter 매퍼를 wire 종류별 순수 함수로 분리한다(예: `codex-wire-mapper.ts`).

> 임계는 "분리 의무"가 아니라 "분리 검토 의무"다. 분리가 응집도를 해치면 그대로 두되, 검토했음을 PR에서 밝힌다.

---

## B. 주석 (한글, 보고서체)

### B.1 클래스/함수 doc-comment

클래스/함수에는 **언어별 doc-comment를 보고서체 한글로** 단다: 기능을 한 줄로 명시 + 인자에 대한 간단한 설명. TS는 JSDoc(`/** ... */` + `@param`/`@returns`), Rust는 rustdoc(`///`), PHP는 PHPDoc — 동일 원칙이다.

**TypeScript (JSDoc)** — 한글 주석 예시:

```ts
/**
 * AgentEvent를 받아 transcript 모델을 갱신한 새 모델을 돌려주는 순수 함수.
 * 부수효과·룬 사용이 없어야 하며, upsert/reconcile 규칙은 04 §3을 따른다.
 * @param prev 직전 transcript 모델(불변으로 취급)
 * @param event adapter가 normalized한 이벤트(타입 정의는 15 §3)
 * @returns 이벤트를 반영한 새 transcript 모델
 */
export function applyEvent(prev: TranscriptModel, event: AgentEvent): TranscriptModel {
  // ...
}
```

**Rust (rustdoc)** — 한글 주석 예시:

```rust
/// 자식 프로세스에 graceful shutdown을 시도한다(07 §5.2 정본 순서).
/// stdin을 닫아 EOF를 보낸 뒤 `grace_ms`만큼 대기하고, 그래도 살아 있으면 kill한다.
///
/// * `runtime_id` - 종료할 runtime 식별자(PTY 세션 id와 별개, 15 §8.1)
/// * `grace_ms` - 종료 대기 시간(밀리초). 초과 시 강제 kill
fn shutdown_runtime(runtime_id: RuntimeId, grace_ms: u64) -> Result<(), String> {
    // ...
}
```

### B.2 핵심 로직 주석

주요 코드(비자명 분기·알고리즘, 특히 reconcile·cleanup·framing 같은 핵심 로직)에는 **간단한 한 줄 한글 주석**을 넣는다. 예:

```ts
// delta는 점진 렌더용일 뿐, completed item의 text가 권위다 (04 §3.2 reconcile)
model = reconcileMessage(model, completed);
```

```rust
// 줄바꿈으로 잘린 마지막 조각은 다음 chunk와 합치도록 보류한다 (newline framing)
buffer.extend_from_slice(tail);
```

### B.3 금지·지양

- **과잉/자명한 주석 지양**: 코드를 그대로 읽어주는 주석(`// i를 1 증가`)은 달지 않는다.
- **슬랭·판교어 금지**: "갈아끼움", "태움", "긁어옴" 같은 슬랭 대신 평이한 보고서체("교체", "전송", "수집")를 쓴다.
- 한국어 산문 + 영어 기술 식별자 유지(타입명·함수명·이벤트명은 영어 그대로).

---

## C. 적용 범위 / DoD

### C.1 적용 범위

이 규약은 **이 plan의 모든 신규 코드**(adapter, Tauri runtime, store/controller, Svelte 컴포넌트, 테스트)와 **문서의 코드 예시**에 적용한다. 기존 파일을 수정할 때도 추가/변경하는 함수에는 동일 규약을 적용한다.

### C.2 Definition of Done 편입

[`12-implementation-workstreams.md`](12-implementation-workstreams.md)의 각 task DoD에 다음 두 항목을 포함시킨다:

1. **파일 분리 기준 충족**: 도메인 단위 분리 + 2000줄 임계 검토(§A).
2. **doc-comment(한글) 작성**: 새로 만든/수정한 클래스·함수에 JSDoc/rustdoc(§B.1) + 핵심 로직 한 줄 주석(§B.2).

> 이는 빌드 검증(`npm run check`/`cargo check`)을 대체하지 않고 보완한다. 정적 검사·테스트 게이트는 12의 각 Verification gate가 정본이다.

---

## 이 규약을 참조해야 하는 문서

아래 문서들은 코드 작성·예시를 다루므로 본 규약(17)을 인용한다. 각 문서는 코드를 제시할 때 "파일 분리·doc-comment 규약은 17"이라고 1~2줄로 짧게 인용한다(문서 비대화 금지).

| 문서 | 인용 맥락 |
|---|---|
| [`03-target-architecture.md`](03-target-architecture.md) | 레이어 역할(view/controller/state/service) 기술 시 — 분리 규약은 17 §A. |
| [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) | adapter를 매퍼/launch/routing 파일로 나눌 때 — 17 §A.2. |
| [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) | ACP adapter 파일 분리·doc-comment — 17 §A·§B. |
| [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) | framing/shutdown 핵심 로직 주석 — 17 §B.2. |
| [`08-ui-composition.md`](08-ui-composition.md) | Svelte view/controller/state 분리 + 컴포넌트 doc-comment — 17 §A·§B. |
| [`12-implementation-workstreams.md`](12-implementation-workstreams.md) | 각 task DoD에 분리 기준·doc-comment 편입 — 17 §C.2. |
| [`15-data-contracts.md`](15-data-contracts.md) | 타입 정의 주석 문체(JSDoc 한글) — 17 §B.1(타입 자체는 15가 정본). |
| [`HANDOFF.md`](HANDOFF.md) | 빌드 컨벤션 항목에 코드 스타일 규약 추가 — 17 전체. |
