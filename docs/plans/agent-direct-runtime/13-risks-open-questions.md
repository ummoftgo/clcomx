# Risks and Open Questions

> 이 문서는 CLCOMX "Direct Agent Runtime"의 **위험 레지스트리·확정 기본값(Resolved defaults)·Open questions 집계**의 단일 출처다. 다른 문서에서 "unverified" 또는 "결정 필요"로 올라온 항목은 모두 여기 §3 레지스트리로 모은다.
>
> **역할 분리**: 타입 정의는 [`15-data-contracts.md`](15-data-contracts.md), 규칙·불변식은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)가 권위다. 이 문서는 그 두 문서가 의존하는 **결정/가정/위험만** 다루고 타입·규칙을 재정의하지 않는다. 위험 완화 방법이 특정 설계를 인용할 때는 해당 문서 §번호로 링크한다.
>
> **읽는 법**: §1은 카테고리별 위험(영향·완화·검출). §2는 Resolved defaults(현 시점 확정 기본값과 근거). §3은 Open questions 레지스트리(질문/출처/현재 기본값/구현 전 확인 방법). 구현 에이전트는 §2를 "그대로 따르고", §3은 "구현 착수 전 확인 게이트"로 쓴다.

조사 시점: 2026-06-25. 코드 스냅샷 기준: commit `e7a5f9e`; 구현 전 현재 작업트리와 대조.

---

## 1. 위험 레지스트리 (카테고리별)

각 항목은 **영향(Impact)** / **완화(Mitigation)** / **검출(Detection)** 3축으로 기술한다. 심각도(S1=치명, S2=중대, S3=보통)는 v1 범위 기준 상대 평가다.

### 1.1 Protocol drift (S1)

Codex app-server protocol과 ACP/Claude adapter는 빠르게 변한다. 메서드명·필드·discriminant·enum 멤버가 minor 버전에서 바뀔 수 있다.

- **영향**: pinned ref(`rust-v0.142.0`, ACP schema baseline 후보 `schema-v1.16.0`, `@agentclientprotocol/claude-agent-acp@0.51.0`)와 실제 런타임 바이너리/schema artifact가 어긋나면 adapter의 wire→`AgentEvent` 매핑(15 §3, ref-codex §8, ref-acp §13)이 조용히 깨진다. 새 notification이 무시되거나, 사라진 필드가 `undefined`로 흘러 transcript가 비거나, discriminant 변경으로 event가 unknown으로 떨어진다.
- **완화**:
  1. generated type과 runtime package 버전을 **함께 핀**한다(§2 Resolved defaults). Codex는 ref `rust-v0.142.0`, ACP는 wire `protocolVersion=1` + T0.0/OQ-41에서 확정한 public schema artifact(`schema-v1.16.0`은 baseline 후보), Claude adapter는 npm `0.51.0` 고정.
  2. adapter는 **unknown variant를 버리지 않고** `ProviderRef.raw`에 보존(15 §0.2)하고, unknown method/notification은 `error{recoverable:true}` 또는 debug 로그로 가시화한다(절대 silent drop 금지).
  3. `AgentRuntimeMetadata.protocolVersion`/`adapterVersion`/`providerVersion`(15 §7.1)을 세션 시작 시 기록해 호환성 추적을 남긴다.
  4. 버전 업데이트 시 schema diff 검토를 PR 체크리스트화하고, fixture replay 회귀(11 §fixture replay)를 통과해야 머지한다.
- **검출**: (a) fixture replay 테스트에서 unknown variant 카운트를 assert. (b) runtime에서 unknown method 수신 시 stderr/telemetry 카운터 증가. (c) `initialize` 응답의 `protocolVersion`이 기대값과 다르면 startup 경고.

### 1.2 Codex experimental surface (S2)

Codex app-server의 일부 기능·메서드는 `--experimental` 플래그 또는 unstable schema 뒤에 있을 수 있다(ref-codex §1.4 experimental 필드, §10 unverified).

- **영향**: 사용자에게 노출한 기능이 다음 Codex 버전에서 사라지거나 의미가 바뀐다. experimental 필드를 정식 매핑에 끌어오면 protocol drift(1.1)와 결합해 회귀가 커진다.
- **완화**:
  1. direct runtime 전체를 **실험 flag 뒤**에 둔다(§2). experimental Codex 기능은 그 안에서 다시 한 단계 gate.
  2. `#[experimental]` 필드는 normalized 타입으로 승격하지 않고 `raw`에만 보존(15 §0.2).
  3. experimental 경로 실패 시 stdio 기본 흐름으로 graceful fallback 하고, 사용자에게 experimental 경고 copy를 표시한다.
- **검출**: experimental 기능 사용 여부를 세션 metadata에 플래그로 남기고, startup 시 `initialize` capability에서 해당 기능 미지원이면 비활성화.

### 1.3 WebSocket transport 후속화 (S3)

Codex app-server는 websocket transport 가능성이 있으나 본 조사에서 wire로 검증되지 않았다(05 §"websocket listen은 후속 검증 대상", 07 §"websocket: 검증 후 optional", 15 §8.1 `AgentRuntimeStartParams` websocket variant 주석).

- **영향**: websocket을 1차에 구현하면 미검증 transport에 framing/auth/backpressure 위험이 추가된다. auth token 저장·redaction 정책도 미정(05 §72).
- **완화**:
  1. v1은 **stdio 전용**으로 구현한다(§2). `AgentRuntimeStartParams`에 websocket variant 타입은 future-sketch로 유지하되 Rust handler는 1차에서 start params를 **로깅/스냅샷에 노출하기 전 즉시** `Err("websocket transport not yet supported")`로 reject한다(07 handler). variant·`authToken?`가 15 §8.1 public 계약에 존재하므로, reject가 로깅보다 늦으면 `authToken`이 관측면에 새는 누출 표면이 생긴다 — 그래서 reject가 로깅·스냅샷보다 **먼저** 일어나야 한다.
  2. websocket auth token 저장 위치·redaction은 검증 후 [`09-permissions-security.md`](09-permissions-security.md)에 반영(05 §72). 그 전까지 평문 저장 금지이며, `authToken`은 v1부터 09 secret scrub/redaction 집합에 포함한다(token 필드가 계약에 존재하나 v1 미사용·누출 차단).
- **검출**: `transportKind:"websocket"`로 들어오는 호출은 handler에서 **로깅 전** 명시적 거부 + (token 미포함) 거부 로그. UI는 stdio만 노출. websocket start가 token 로깅 없이 reject되는지 테스트(11 §)로 회귀 고정.

### 1.4 WSL / Windows path 처리 (S2)

ACP는 absolute path를 요구하고, CLCOMX는 WSL path·Windows path·file URI를 섞어 다룬다(15 §6 `StartSessionParams.workDir` 주석, 07 §WSL 경계).

- **영향**: 잘못된 path 종류가 adapter에 들어가면 ACP가 reject하거나 엉뚱한 cwd로 세션이 뜬다. file URI vs 경로 혼동으로 `resource`/`diff` content(15 §4)의 path 표시가 깨진다. WSL↔Windows 경로 변환 누락 시 파일 열기·diff가 동작하지 않는다.
- **완화**:
  1. adapter 입력 직전에 `workDir`를 **WSL absolute path로 canonicalize**한다(15 §6 주석). canonicalize 단일 진입점을 두고 모든 provider가 거치게 한다.
  2. path 종류(WSL path / Windows path / file URI)를 명시적으로 구분하는 유틸을 두고, content path 렌더링·파일 열기 양쪽이 같은 유틸을 쓴다.
  3. 변환 규칙·예시는 [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §WSL 경계에 정본화하고 본 위험은 그것을 인용한다.
- **검출**: relative path가 adapter 경계에 도달하면 즉시 reject(assert). path 변환 단위 테스트(WSL/Windows/URI 케이스)를 11 §에 포함.

### 1.5 Approval deadlock / pending cleanup (S1)

provider가 permission response를 기다리는 동안 UI가 닫히거나 turn이 cancel되면 agent가 멈춘다. pending request cleanup은 runtime 필수 기능이다(04 §4.2 불변식).

- **영향**: pending approval을 닫지 않으면 agent가 무한 대기하고 세션이 `requires_action`에 고착된다. 두 protocol 모두 cancel 시 pending permission을 닫는 것을 MUST로 규정한다(ACP §3.8, Codex §4.4 — 04 §4.2 인용).
- **완화**:
  1. turn cancel/shutdown(process 살아 있음) 시 unresolved approval을 `cancelled`로 닫고 wire 응답도 보낸다(04 §4.2 규칙 1–4). `process_exited`(process 사망)는 모든 pending approval을 `failed`(wire 미전송, 내부 전용)로, pending RPC를 failed로 닫는다(04 §5.0, 15 §3 `process_exited`).
  2. **deadlock 탐지 권위는 frontend pending table**이다(04 §5 authoritative cleanup). backend `AgentRuntimeSnapshot.pendingRequestIds`(15 §8.1)는 **v1에서 선택적**이며 — backend는 단순 id bookkeeping만 하거나 생략할 수 있어 **비어 있을 수 있다**(07 §6.4: 1차에서 backend pending 추적 생략 가능, 항상 빈 배열 무방). 따라서 cleanup/deadlock 판정은 frontend pending table을 권위로 하고, snapshot은 진단 보조 신호로만 쓴다.
  3. `ApprovalDecision.outcome:"failed"`는 client 내부용이며 wire로 보내지 않는다(04 §4.2 규칙 4).
  4. **미지원 server request 무응답 금지(R5, RD-15·OQ-35)**: provider server→client REQUEST(`id` 있음) 중 미지원 method도 반드시 JSON-RPC error(`-32601` 등) 또는 명시적 decline/cancel 응답을 보낸다 — silent-drop하면 provider가 영구 대기(deadlock)한다. unknown NOTIFICATION(`id` 없음)은 raw 보존+counter만(응답 불필요). adapter default 분기는 `return []`로 끝내지 않는다(05 §7.1, 06).
- **검출**: cleanup 누락 회귀 테스트(11 §): cancel/탭 닫기/process kill 각각에서 **frontend pending table**의 pending이 0으로 떨어지는지 assert(권위). backend snapshot의 `pendingRequestIds` 길이는 backend가 추적할 때만 보조 텔레메트리로 쓴다(v1 선택적, 비어 있을 수 있음 — §1.5 완화 2).

### 1.6 Terminal regression (S2)

embedded terminal과 legacy PTY가 공존하면 focus·shortcut·resize·bottom-follow 회귀가 생긴다(기존 02 위험 보존).

- **영향**: direct runtime 도입이 기존 PTY/xterm 사용자 경험을 깨뜨린다. focus 충돌, 단축키 가로채기, resize 미반영, 스크롤 follow 깨짐.
- **완화**:
  1. legacy PTY 경로는 삭제하지 않고 보조 셸/명령 출력 embed/fallback으로 유지(00 범위, 04 §3.5 legacy 처리).
  2. legacy PTY output은 transcript로 끌어올리지 않고 `terminal_output_delta`(15 §3)로만 처리한다(04 §3.5).
  3. UI 작업 전후로 기존 terminal E2E 회귀 스위트를 유지하고, PR 게이트로 둔다(11 §).
- **검출**: 기존 terminal E2E(focus/resize/follow) green 유지가 머지 조건. 신규 UI는 별도 surface로 격리.

### 1.7 Branding / product confusion (S2)

Claude Agent SDK / ACP integration이 Claude Code나 Anthropic 공식 제품처럼 보이면 안 된다(기존 위험 보존, ref-claude §1 branding note).

- **영향**: provider 표시·UI copy가 공식 제품으로 오인되면 라이선스/상표 리스크. claude.ai 로그인·rate limit 제공이 서드파티에 허용되는지도 불명확(ref-claude §6 unverified wording).
- **완화**:
  1. provider 표시는 중립적 라벨로 하고, "powered by"류 공식 제품 사칭 copy를 금지한다.
  2. 인증은 사용자 본인 자격/키 사용을 전제로 하고, claude.ai 세션 재판매·우회를 하지 않는다.
  3. branding/auth 허용 범위는 공식 overview 페이지로 문구 확인 후 [`09-permissions-security.md`](09-permissions-security.md)에 반영(레지스트리 OQ-09).
- **검출**: UI copy 리뷰 체크리스트. 외부 노출 문자열 audit.

### 1.8 Backpressure / 대용량 출력 (S2)

명령 실행이 대량 stdout/stderr를 쏟거나 streaming delta가 폭주하면 transport queue가 포화한다(15 §8.3 `agent-runtime-backpressure`, 05 §66 queue/backpressure).

- **영향**: late-attach용 replay log를 unbounded로 두면 메모리 폭증. bounded로 두면 trim된 구간이 late-attach 재구성에서 빠진다(실시간 emit은 그대로 흐름). UI 렌더가 delta 폭주로 멈출 수 있다. **단 v1의 replay log/seq는 diagnostic-only bounded log이며**(07 §7.2 정본), late-attach replay consumer(delta-since 재구성)는 후속이라 v1에는 **사용자-visible 복구 보장이 없다** — trim된 구간이 사라져도 v1 기능 손실로 보지 않는다.
- **완화**:
  1. v1 완화책은 **"bounded replay log + telemetry"**이며 **emit throttle이 아니다**(07 §7.2 정본 명명). backend는 late-attach용 replay log(`message_log`)만 bounded로 경계 짓되, 이 log/seq는 **diagnostic-only bounded log**이다 — late-attach replay consumer(delta-since 재구성)는 **후속**이라 v1에는 **사용자-visible 복구 보장이 없다**(07 §7.2). 그 경계에서 trim된 누적 건수를 `agent-runtime-backpressure{droppedMessages}`(15 §8.3) **telemetry 신호**로 알린다. **emit 자체는 막거나(throttle)·합치거나(coalesce)·떨어뜨리지(drop) 않는다** — frontend는 실시간 stream을 그대로 받는다. UI는 recoverable warning을 표시하고 pending approval은 자동 방치하지 않는다(05 §66). 실제 emit cap/coalesce/buffer drop은 **후속**이다(OQ-50).
  2. command output은 transcript content가 아니라 `command_output_delta`(15 §3)로 흐르게 하고, 대용량은 ring buffer/요약으로 캡한다.
  3. late-attach 신뢰성을 위해 message에 단조 증가 seq + snapshot/delta-since를 PTY와 동일 원리로 적용(후속, 15 §8.3 · 04 §3.4 · `research/codebase-backend.md` §2.3·§10 권고 3).
- **검출**: replay-log trim(backpressure) telemetry 카운터. 대용량 출력 fixture(수 MB stdout) replay 시 실시간 emit 누락 0 또는 replay-log trim에 대한 명시적 backpressure 신호 assert(11 §).

### 1.9 Node bin 실행 전제 (S2)

Claude ACP adapter는 node로 `dist/index.js`를 실행하고, claude native 바이너리는 SDK optional dependency 번들을 resolve한다(ref-claude §"claude native binary 해석", §"확인된 사실").

- **영향**: (a) 배포 대상에 node 런타임이 없거나 버전이 안 맞으면 adapter가 안 뜬다. (b) `npm install --omit=optional`로 설치하면 native 바이너리가 빠져 *"Claude native binary not found"* 실패(ref-claude §117). (c) `CLAUDE_CODE_EXECUTABLE`/`CLAUDE_CONFIG_DIR` 미설정 시 잘못된 자격/경로 사용(ref-claude §환경변수).
- **완화**:
  1. node 런타임 존재·버전을 startup preflight로 확인하고, 실패 시 명확한 에러 메시지(설치 안내)로 fallback한다.
  2. Claude adapter 설치 시 **optional dependency 포함**을 문서화·검증한다(`--omit=optional` 금지).
  3. native 바이너리 경로는 필요 시 `CLAUDE_CODE_EXECUTABLE`로 명시 지정, config dir은 `CLAUDE_CONFIG_DIR`로 격리.
  4. 실제 배포 대상의 node/claude/SDK 번들 버전은 조사 머신 값(`node v24.14.0`, `claude 2.1.187`)과 다를 수 있으므로 target에서 재확인(레지스트리 OQ-10).
- **검출**: startup preflight(node present, version range, native binary resolvable)을 세션 시작 전에 실행하고 결과를 `error{recoverable}`로 보고.

### 1.10 Version 호환 (S2)

claude-agent-acp npm 버전, ACP schema 버전, Codex ref 버전이 서로 호환되어야 한다(ux-reference §12 OQ7: 로컬 latest 0.51.0 vs doc 01 0.50.0; ref-claude §6 0.50.0↔0.51.0 diff 미인용).

- **영향**: adapter 의존성 버전과 협상되는 ACP `protocolVersion`/capability가 어긋나면 세션 생성·permission·tool 매핑이 부분적으로 실패한다. 버전 혼선(0.50.0 vs 0.51.0)으로 capability 차이를 놓친다.
- **완화**:
  1. Claude adapter는 npm `@agentclientprotocol/claude-agent-acp@0.51.0`을 고정한다(§2 갱신). ACP wire는 `protocolVersion=1` 기준이며, schema artifact는 T0.0/OQ-41에서 public tag/release·패키지 schema와 대조해 확정한다(`schema-v1.16.0`은 baseline 후보).
  2. 0.50.0↔0.51.0 capability 차이는 CHANGELOG로 확인 후 고정 버전 근거를 문서에 남긴다(레지스트리 OQ-08).
  3. `initialize`/`session/new` 응답의 `protocolVersion`·capability를 metadata에 기록하고, 기대와 다르면 startup 경고(1.1과 동일 메커니즘).
  4. **런타임 중 provider 교체 경계(R-NEW-02)**: 런타임 중(앱 구동 중) 사용자가 WSL 측 codex/claude/adapter를 교체하면 기존 세션과 신규 세션의 provider 버전이 갈릴 수 있다. 세션 시작 시 `--version`을 `AgentRuntimeMetadata`(15 §7.1)에 고정하고, 동일 윈도우 신규 세션이 다른 버전을 resolve하면 경고한다. (preflight cache 무효화는 OQ-36과 연동)
- **검출**: 의존성 lock 검증 + startup capability assert. 버전 bump PR에서 fixture replay 회귀 통과 필수.

### 1.11 Multi-window registry 동시성 (S2)

[12](12-implementation-workstreams.md) T1.4의 module-level registry(handle→`runtimeId`/port 매핑 + 전역 pending request table)는 단일 윈도우 전제로 기술됐으나, CLCOMX는 멀티 윈도우 앱이라 윈도우 간 registry 수명·소유권이 경합할 수 있다(R-NEW-01).

- **영향**: 한 윈도우가 닫히며 registry 엔트리를 정리할 때 다른 윈도우의 살아 있는 `runtimeId`/pending request를 함께 날리거나, cross-window dispatch로 event가 엉뚱한 윈도우의 세션 state에 라우팅된다. 전역 pending request table을 윈도우들이 공유하면 한 윈도우의 cleanup이 다른 윈도우의 approval/RPC를 미아로 만들어 1.5(approval deadlock)와 결합한다.
- **완화**:
  1. registry는 **단일 윈도우가 소유**하고 `runtimeId`↔window 바인딩을 명시한다. window-close 시 **자기 소유 엔트리만** 정리하고 타 윈도우 엔트리는 건드리지 않는다.
  2. **cross-window dispatch 금지(불변식)**: event/RPC는 소유 윈도우 안에서만 라우팅한다. 다른 윈도우의 `runtimeId`로 dispatch 시도는 차단·로그한다.
  3. 윈도우 소유권/수명 모델의 정본은 12 T1.4이며, 본 위험은 그것을 인용한다. 모델 확정은 OQ-48 게이트.
- **검출**: window-close 시 타 윈도우 `runtimeId`/pending이 보존되는지 회귀 테스트(11 §). cross-window dispatch 시도 카운터를 텔레메트리로.

---

## 2. Resolved defaults (확정 기본값)

아래는 v1 구현이 **그대로 따르는** 확정 기본값이다. 변경하려면 이 문서를 갱신하고 관련 문서(05/06/07/10/15)에 반영해야 한다.

| # | 결정 | 값 / 정책 | 근거 |
|---|---|---|---|
| RD-1 | runtime gating | direct runtime은 첫 구현에서 **실험 flag 뒤**에 둔다. experimental Codex 기능은 그 안에서 한 단계 더 gate. | 위험 1.2 |
| RD-2 | transport 우선순위 | Codex·Claude 모두 **stdio 우선**. websocket은 후속(검증 후 optional), 1차 handler는 명시적 거부. v1은 `websocket` start를 **로깅/스냅샷 노출 전 reject**하고, `authToken`은 09 redaction 집합에 포함한다 — token 필드가 15 §8.1 계약에 존재하나 v1 미사용·누출 차단(variant 타입 자체는 future-sketch로 유지). | 05 §1, 07 §transport, 09(redaction 집합), 위험 1.3, 15 §8.1 |
| RD-3 | transcript full cache | 1차 범위에서 **제외**. provider replay(ACP `session/load`, Codex `thread/read`)와 metadata 저장에 집중. | [`10-persistence-migration.md`](10-persistence-migration.md) §40, 15 §7 |
| RD-4 | raw protocol log | **기본 off**. redacted debug mode만 둔다(비밀·자격 redaction 적용). | 09 §, 위험 1.1 |
| RD-5 | Claude adapter 의존성 | npm `@agentclientprotocol/claude-agent-acp@**0.51.0**` 고정(commit `23626c9`). | 15 §0(헤더), ref-claude, 위험 1.10 |
| RD-6 | Codex ref 핀 | baseline은 `rust-v0.142.0` 기준 매핑. 구현 시점 CLI/generated schema가 다르면 OQ-41 절차로 diff 확인 후 핀 갱신 여부 결정. | 15 §0(헤더), ref-codex, 01 §4 |
| RD-7 | ACP 기준 artifact | baseline 후보는 schema `schema-v1.16.0`, wire target은 `protocolVersion=1`. `schema-v1.16.0`은 구현 핀이 아니며 public schema/release artifact와 다르면 OQ-41 절차로 실제 생성 타입 정본을 확정. | 15 §0(헤더), ref-acp, 01 §4 |
| RD-8 | startup allowlist 강화 (R4 정본) | executable `command`는 renderer 입력에서 제거하고 backend가 `provider`로 신뢰 절대경로를 resolve한다. `args`/`env`는 adapter가 생성한 검증값만 허용하며 Rust handler가 **provider별 allowlist로 재검증**(임의 executable/shell string 차단). **basename-only 검사는 폐기**하고 다음으로 강화: (a) executable은 backend가 resolve한 신뢰 절대경로 또는 사전 등록된 절대경로 화이트리스트만 사용. (b) **args 정확 일치**: Codex는 `["app-server","--stdio"]` 정확히, Claude는 `args.length==1` 이고 `args[0]`이 검증된 `adapterEntryPath`(절대경로, `claude-agent-acp` `dist/index.js` 패턴)일 것. 임의 `.js`/임의 바이너리 거부. (c) **env key allowlist**: key는 `^[A-Za-z_][A-Za-z0-9_]*$` + OQ-38에서 확정한 provider별 허용 key 집합으로 강제하고 값은 non-secret(C1/RD-14). shell metachar 검사는 방어용으로 유지. PTY 대비 의도적 강화. | 위험 1.2, OQ-34, 07 §8.1, 09(untrusted renderer 위협모델), 11(allowlist 테스트), 15 §8.1 주석, `research/codebase-backend.md` §6·§10 권고 6 |
| RD-9 | resume 비밀 scrub | `providerSessionId`/`providerThreadId`/`providerResumeToken`은 디스크 저장 직전 scrub(기존 `pty_id`/`resume_token`과 동일). history 미저장. | 15 §7.3 보안 경계, `research/codebase-backend.md` §4.2·§4.4·§10 권고 7 |
| RD-10 | unknown variant 처리 | adapter는 unknown method/variant를 **silent drop 금지**. `raw` 보존 + 로그/카운터. | 위험 1.1, 15 §0.2 |
| RD-11 | pending approval cleanup | turn cancel/shutdown(process 생존) 시 unresolved approval을 `cancelled`로 닫고 wire 응답 전송. process exit(사망) 시 approval은 `failed`(wire 미전송, 내부 전용), pending RPC는 failed. | 04 §4.2·§5.0, 위험 1.5 |
| RD-12 | node 설치 전제 | Claude adapter는 node 런타임 + SDK **optional dependency 포함** 설치를 전제. `--omit=optional` 금지, startup preflight 수행. | ref-claude §node, 위험 1.9 |
| RD-13 | thought / audio content | **(해소됨, D11)** thought/reasoning은 `agent_message`/`agent_message_delta`의 optional `channel?: "response" \| "thought"`(미지정 시 `"response"`)로 normalize한다(15 §3). thought delta는 messageId/contentIndex별 append, completed reasoning item이 thought 채널의 권위(reconcile)다(04 §3.2.2·§3.2.5). UI는 `channel==="thought"`를 접이식 thinking 블록(기본 collapsed)으로 렌더한다(08). `audio` content는 **미지원**(OQ-04). | 15 §3, 04 §3.2.2·§3.2.5, 05 §5.2, 06 §5, 08, OQ-01 |
| RD-14 | secret env 경계 (C1, R1 — 06까지 통일) | `AgentRuntimeStartParams.env`(15 §8.1) 및 06 `ClaudeAcpLaunchConfig.env`/`buildClaudeAcpLaunchParams`의 `env`는 **non-secret 전용**. secret(API key/OAuth token/gateway header/session cookie)은 launch argv(`-e env KEY=VAL`)로 절대 넘기지 않고, 필요 시 `std::process::Command::env()`+`WSLENV` passthrough(argv 비경유)로만 전달한다. v1 기본은 provider 자체 WSL 인증(`claude login`/`codex auth`)에 의존해 secret 미전달. argv는 OS 관측면(`ps`/`/proc/<pid>/cmdline`/WSL process 목록)에 평문 노출되어 redaction으로 막을 수 없다. | OQ-28, 06 §2.2·§3.3, 07 §5.1·§11, 09, 15 §8.1 주석(타입 비변경) |
| RD-15 | 미지원 server request 응답 의무 (R5) | provider server→client **REQUEST**(JSON-RPC `id` 있는 요청) 중 미지원 method는 **반드시 JSON-RPC error 응답**(예: `code -32601` method not found) 또는 **명시적 decline/cancel 응답**을 보낸다. **무응답 silent-drop 금지**(provider 영구 대기/deadlock 방지). unknown **NOTIFICATION**(`id` 없음)은 응답 불필요 — `raw` 보존 + counter로 가시화(RD-10). adapter default 분기는 `routing.resolveApproval` 후 `return []`로 끝내지 말고 unknown server request에 error/unsupported(또는 decline) 응답을 먼저 보낸다. | 위험 1.5·OQ-35, 04 §5, 05 §7.1, 06, [`ref-acp-protocol.md`](ref-acp-protocol.md) §1·§"-32601", [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §4·§"-32601", RD-10 |

> 기존 문서(보강 전)에 있던 5개 default(실험 flag, stdio 우선, transcript cache 제외, raw log off, npm 고정)는 모두 위 표에 흡수·구체화했다. npm 버전은 **0.50.0 → 0.51.0**으로 갱신(RD-5). 이후 Codex 재검토(R1~R5)로 RD-8(allowlist 강화)을 구체화하고 RD-14(secret env 경계, R1)·RD-15(미지원 server request 응답 의무, R5)를 신설했다.

---

## 3. Open questions 레지스트리

다른 문서에서 "unverified" 또는 "결정 필요"로 올라온 항목을 한 곳에 집계한다. 구현 에이전트는 **해당 항목을 건드리기 전에** "구현 전 확인 방법"을 먼저 수행한다.

> **H4 — "Codex wire 실측" 묶음(T0.0 직후 hard gate)**: **OQ-33**(`UserInput.text` vs `text_elements`)·**OQ-07**(`initialize`→`initialized` 핸드셰이크)·**OQ-11**(`ClientInfo`/`InitializeCapabilities` 필드)은 모두 codex app-server wire를 1회 실측해야 확정되는 항목이다. 셋을 **하나의 hard gate**로 묶어 T0.0(핀 preflight, OQ-41) 직후에 처리한다 — `generate-ts` 산출물(`UserInput.ts`/`ClientInfo`/`InitializeCapabilities` @ `rust-v0.142.0`)과 **단일 `initialize`/`turn.start` wire 캡처**에서 함께 확인한다. 특히 OQ-33은 틀리면 `turn/start`가 거부되어 Codex 경로 전체가 막히므로 **Phase 3 blocker**다(현 "결정 필요"에서 격상). 이 묶음이 통과하기 전에는 05 §initialize/§5.3d outbound 매핑 구현을 확정하지 않는다.

| ID | 질문 | 출처 문서 §| 현재 기본값(가정) | 구현 전 확인 방법 |
|---|---|---|---|---|
| OQ-01 | **(해소됨, D11)** `agent_thought_chunk`(ACP thought) / Codex `reasoning`에 대응하는 전용 event/content가 없다 — v1 처리 정책? | 15 §3, [`ref-acp-protocol.md`](ref-acp-protocol.md) §13.2·§14, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §6.3 | **확정**: `agent_message`/`agent_message_delta`에 optional `channel?: "response"\|"thought"` 추가(15 §3). thought delta는 messageId/contentIndex별 append, completed reasoning item이 권위(04 §3.2.2·§3.2.5). 05 §5.2: `item/reasoning/textDelta`→`agent_message_delta{channel:"thought"}`, completed reasoning item→`agent_message{channel:"thought", mode:"replace"}`(더 이상 `[]` 드롭 아님). 06 §5: `agent_thought_chunk`→`agent_message_delta/agent_message{channel:"thought"}`. | 해소 완료 — 다운스트림은 위 정책을 그대로 구현. UI 렌더(접이식 thinking 블록, 기본 collapsed)는 08 §5.1에서 확정. |
| OQ-02 | **(해소됨)** `TokenUsage` vs ACP `usage_update`(`used`/`size`/`cost`) — context gauge 표현에 04/15 필드 추가가 필요한가? | [`research/ux-reference.md`](research/ux-reference.md) §12·§266, 15 §5 `TokenUsage` | **확정**: ACP `UsageUpdate{used,size}`를 `TokenUsage.contextUsed`/`contextSize`로 매핑한다(15 §5 2필드 추가, 06 §3.6 매핑). Codex 축(input/output/cached/reasoning)과 별개로 context gauge 전용 필드다. | 해소 완료 — 15 §5에 `contextUsed?`/`contextSize?` 추가, 06 §3.6에서 `usage_update`→두 필드 매핑. 08 context gauge는 이 두 필드를 읽는다. |
| OQ-03 | ACP `Diff{oldText,newText}` → 15 `AgentContent.diff{patch}` 변환 규칙? | [`research/ux-reference.md`](research/ux-reference.md) §12, 15 §4 | adapter가 patch 생성(15 §4 주석) | `src/tools.ts`(`toolUpdateFromToolResult`)에서 diff content shape 확인 후 patch 생성 알고리즘 확정(06 §). |
| OQ-04 | ACP `audio` content 미지원 결정 시 강등/표시 정책? | [`ref-acp-protocol.md`](ref-acp-protocol.md) §13.2·§14, [`research/ux-reference.md`](research/ux-reference.md) §12 | v1 미지원(RD-13) | 미지원 placeholder 표시 vs 무시를 08 UI에서 확정. |
| OQ-05 | send/개행 키 바인딩 — `Enter`=전송 vs `Shift+Enter`=전송? | [`research/ux-reference.md`](research/ux-reference.md) §370·§428 | `Shift+Enter`=개행, `Enter`=전송(웹 관례) | 기존 CLCOMX composer UX 컨벤션 확인 후 08 §composer에서 통일. |
| OQ-06 | session/thread 목록 UI — Zed식 sidebar/switcher 도입 vs 기존 탭 모델 + turn status badge? | [`research/ux-reference.md`](research/ux-reference.md) §429 | 기존 탭 모델에 turn status badge 얹기 | 08 §에서 결정. 기존 탭 모델(`research/codebase-frontend.md`)과의 정합 확인. |
| OQ-07 | Codex `initialize`→`initialized` 핸드셰이크가 필수인가(없이 `thread/start` 가능?), 메시지 순서/타이밍 검증 | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §10·§606·§613·§614 | **v1 기본값(D12)**: `initialize`→`initialized` 핸드셰이크를 **항상 수행**(방어적 기본값). | **T0.0 직후 hard gate("Codex wire 실측" 묶음, OQ-33/OQ-11과 함께 — §3 머리말 참조)**: app-server crate handler 읽고 핸드셰이크 필수 여부·단일 `initialize`/`turn.start` wire 캡처로 순서 검증. 05 §startup 시퀀스에 반영. |
| OQ-08 | claude-agent-acp `0.50.0` vs `0.51.0` capability 차이(diff 미인용) | [`research/ux-reference.md`](research/ux-reference.md) §430, [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) §6·§488 | `0.51.0` 고정(RD-5) | CHANGELOG 확인. 고정 버전과 T0.0/OQ-41에서 확정한 ACP schema artifact의 호환 재확인(01 재확인 체크). |
| OQ-09 | Anthropic이 서드파티 제품에 claude.ai 로그인/rate limit 제공을 허용하는가(정확 문구 미확인) | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) §1·§6·§482 | 사용자 본인 자격/키 전제, claude.ai 우회 금지(위험 1.7) | 공식 overview/permissions 페이지 문구 확인 후 09 §auth에 반영. |
| OQ-10 | 배포 대상의 node/claude/SDK 번들 버전(조사 머신 값과 다를 수 있음) | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) §6·§119·§485 | 조사 머신 `node v24.14.0`/`claude 2.1.187`(unverified for target) | target 환경에서 node 버전·native binary resolve 가능 여부 preflight 확인(위험 1.9). |
| OQ-11 | Codex `ClientInfo`/`InitializeCapabilities` 정확 필드(capability opt-in 키, experimental 노출 제어) | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §10·§148 | **v1 기본값(D12)**: 최소 `ClientInfo`(`name`/`version`)만 전송, capabilities는 보수적(null/omit), experimental 키 미사용(unverified). | **T0.0 직후 hard gate("Codex wire 실측" 묶음, OQ-33/OQ-07과 함께 — §3 머리말 참조)**: codex app-server `generate-ts` 산출물(`ClientInfo`/`InitializeCapabilities`)과 단일 `initialize`/`turn.start` wire 캡처로 필드 검증 후 05 §initialize에 반영. |
| OQ-12 | ACP image: base64 `data` → 15 `AgentContent.image.uri` 변환(data URI vs 저장 후 uri) | 15 §4 주석, [`ref-acp-protocol.md`](ref-acp-protocol.md) §13.2 | adapter가 data URI 또는 저장 후 uri 생성(15 §4) | 대용량 image 시 data URI 메모리 영향 검토 후 저장 정책 확정(06 §, 1.8과 연계). |
| OQ-13 | ACP `requires_action`/`running`/`idle` 합성 규칙(특히 permission pending ↔ `requires_action`) 확정 | [`ref-acp-protocol.md`](ref-acp-protocol.md) §13.1·§695, 04 §2.2 | client 합성: `session/request_permission` 수신 → `requires_action`(04 §2.2) | 04 §2.2 합성 규칙을 정본으로 확정하고 06 adapter에서 그대로 구현. |
| OQ-14 | Codex `reject_always` 등가 영구 거부 decision의 정확한 매핑 | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §10·§615 | `decline`로 매핑 권장(unverified) | Codex decision enum schema 재확인 후 05 §approval 매핑 확정. |
| OQ-15 | Codex websocket transport·auth token 저장/redaction 정책 | 05 §12·§72, 07 §transport, 15 §8.1 | v1 미구현, 평문 저장 금지(RD-2·1.3) | websocket wire 검증 후 09 §에 저장/redaction 반영. v1은 게이트 유지. |
| OQ-16 | direct 세션 cross-restart 복원 — scrub로 재개 키가 디스크에 없어 앱 재시작 후 direct 대화 복원 불가. 허용할 것인가/대안? | [`10-persistence-migration.md`](10-persistence-migration.md) §4.5, 15 §7.3 | 1차 범위 **제외**(PTY resume와 동일). cold restore는 §4.4 복원 불가 처리 | (a) OS secret store 저장 또는 (b) provider session store가 sessionId만으로 최신 세션 resolve 가능한지 검증 후 결정. v1은 제외 유지. |
| OQ-17 | message seq/delta 후속 단계 범위 / late-attach seq 메커니즘 부재 — process 생존 중 transcript surface unmount 시 store 재구성 불가 | [`10-persistence-migration.md`](10-persistence-migration.md) §4.3, 15 §8.3, [`research/codebase-backend.md`](research/codebase-backend.md) §2.3·§10 | **v1 기본값(D12)**: transcript surface를 process 생존 동안 **unmount 안 함**으로 회피(`display:none` 유지). message `seq` 필드는 **후속**. 08의 탭 전환/가상화 계약이 surface unmount를 유발하지 않음을 전제. | **구현 전 확인**: 08 §의 탭 전환·가상화 경로가 transcript surface를 unmount하지 않음을 확인. seq 도입 시 message payload에 단조 증가 seq + snapshot/delta-since 추가(07 §framing) 후 late-attach 재구성 활성화. |
| OQ-18 | `WorkspaceTabSnapshot` 확장(`runtime_kind`/`agent_runtime`)의 동기화 범위 — `merge_workspace_snapshot`/`applyWorkspaceWindowSnapshot`/`session-store-snapshot.ts` 영향 | [`10-persistence-migration.md`](10-persistence-migration.md) §3.2·§3.3, [`research/codebase-backend.md`](research/codebase-backend.md) §11, [`research/codebase-frontend.md`](research/codebase-frontend.md) §10 | frontend 저장/복원 경로는 확인됨: 저장 `session-store-snapshot.ts::createWorkspaceTabSnapshot`, 복원 `live-session-workspace-sync.ts::createSessionCore`/`createRuntimeSession`, 기존 세션 갱신 `applyWorkspaceWindowSnapshot`. Rust `merge_workspace_snapshot` 반영 범위는 구현 전 확인 필요. | 위 TS 함수들에 `runtimeKind`/`agentRuntime` 전파를 추가하고, `service/window_ops.rs::merge_workspace_snapshot`가 새 Rust 필드를 보존/merge하는지 확인 후 10 §3 체크리스트와 테스트에 반영. |
| OQ-19 | Codex permissions approval(`item/permissions/requestApproval`) 응답 `{permissions: GrantedPermissionProfile, scope}` 구성 | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §7.1·§7.2, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §4.3 | **v1 기본값(D12)**: command/fileChange 승인만 지원. permission-profile escalation(`requestApproval`)은 **자동 decline**하고 원본은 `raw` 보존. CodexRouting(05 §6)은 원본 JSON-RPC id의 실제 타입(`string\|number`)을 보관하는 필드/메서드를 두어 응답 시 타입을 복원한다. | **구현 전 확인**: `permissions.rs`의 `GrantedPermissionProfile` schema 확인 후 05 §7.2 응답 구성 확정. CodexRouting id 타입 복원 단위 테스트(05). [09](09-permissions-security.md)와 escalation 정책 합의. |
| OQ-20 | `turn/start` approval/sandbox 정책 필드(`approvalPolicy`/`sandboxPolicy`/`model`/`effort`) v1 노출 여부·기본값 | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §2.4, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §6.5 | v1은 `threadId`/`input`만 전송, override 미설정 | [09](09-permissions-security.md)에서 sandbox/approval 기본값 정책 확정 후 05 §2.4에 반영. |
| OQ-21 | standalone `command/exec` 채널(`command/exec/outputDelta`, base64) v1 지원 범위 | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §8.1, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §3.3·§5.3 | v1 미지원 — thread 채널(`item/commandExecution/outputDelta`)만 | thread-less sandbox 실행 UI 요구 여부를 08과 합의. v1은 thread 채널만 유지. |
| OQ-22 | thread 채널 `item/commandExecution/outputDelta`의 stdout/stderr 구분 | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §8.1, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §5.2 | wire에 stream 정보 없음 → v1은 `stdout` 고정 | `item.rs` outputDelta payload에 stream 필드 존재 여부 재확인. 없으면 stdout 고정 유지. |
| OQ-23 | **(해소됨, D5)** turn cancel 소유권 — 어댑터가 `turn/interrupt` RPC 직접 전송 vs backend `agent_runtime_cancel`(`AgentRuntimeCancelTarget`)이 wire 변환 | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §7.3, [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §6.3, 15 §8.1 | **확정**: frontend adapter가 `turn/interrupt`(ref-codex §3.2) 등 turn/request cancel wire를 `agentRuntimeSend`로 **직접 전송**한다. backend `agent_runtime_cancel`은 wire 변환을 하지 않는다(07 §6.3·14 §5 정본). approval cancel 응답(JSONRPCResponse)도 어댑터가 직접 send. | 해소 완료 — 05 §7.3·07 §6.3·14 §5와 일치. 03 §경계는 adapter 전송으로 기술. |
| OQ-24 | `codexBin` 경로 override(settings 노출) 및 startup preflight(`codex --version` 일치 검증) | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §2.2·§11 | 기본 `codex`(PATH), settings override 미노출 | settings UI에 binary 경로 필드 추가 여부 결정([`research/codebase-frontend.md`](research/codebase-frontend.md) §7). preflight는 [11](11-testing-acceptance.md)에 추가. |
| OQ-25 | tokio 도입 여부 / backend async 모델 — `std::thread`+`Arc<Mutex>` 유지 vs tokio 도입 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §3·§7.4, [`research/codebase-backend.md`](research/codebase-backend.md) §7·§11 | **std::thread 유지**(현 backend tokio import 0건, PTY 패턴 정합) | tokio 도입은 ADR 결정 사항([`adr-001-direct-agent-runtime.md`](adr-001-direct-agent-runtime.md)). backpressure/timeout 요구가 polling으로 불충분할 때만 재검토. v1은 std::thread. |
| OQ-26 | `decode_utf8_stream_chunk` 공용화 방식 — `pub(super)`→`pub(crate)` 가시성 상향 vs `features/io_util.rs` 추출 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §2, [`research/codebase-backend.md`](research/codebase-backend.md) §2.6·§11 | **가시성 상향**(최소 변경) | 추출(b) 선택 시 `features/terminal/tests.rs`의 `use super::parsing::...` import 갱신 범위 확인. transport.rs가 참조 가능해지면 됨. |
| OQ-27 | WSL cwd 전달 방식 — `wsl --cd <wslPath>` vs provider CLI cwd flag(codex `--cd`, claude launch param) | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §5.1, [`research/codebase-backend.md`](research/codebase-backend.md) §5.1 | **`wsl --cd`**(provider 무관) | 배포 대상 WSL 버전이 `--cd` 지원하는지 확인. 미지원 시 provider flag fallback 경로 05/06에 명시. |
| OQ-28 | **(해소됨, C1 보안 경계 — 06 Claude launch까지 전파)** direct runtime env 전달 방식 — secret env를 argv로 노출하지 않는다 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §5.1, [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) §2.2·§3.3, [`09-permissions-security.md`](09-permissions-security.md) | **확정(C1)**: env를 **non-secret / secret**으로 분리한다. **non-secret env**(비민감 플래그 등)만 launch argv(`wsl.exe … -e env KEY=VAL … <exe> <argv>`, 07 §5.1)로 넘긴다. **secret env**(API key / OAuth token / gateway header / session cookie 등)는 **절대 argv로 넘기지 않는다** — argv는 OS 관측면(`ps`, `/proc/<pid>/cmdline`, WSL process 목록)에 평문 노출되어 redaction으로 막을 수 없다. **v1 기본값**: provider 인증은 각 CLI의 WSL 측 자체 로그인/config(`claude login`, `codex auth`)에 의존하고, CLCOMX는 secret env를 런타임으로 넘기지 **않는다**. secret env를 꼭 넘겨야 하는 경우(gateway 등)의 정본 메커니즘: Rust `std::process::Command::env()`로 `wsl.exe` 프로세스 환경에 설정 + `WSLENV`(예: `WSLENV=ANTHROPIC_API_KEY/u`)로 WSL 측에 passthrough(argv 비경유). **06 Claude launch까지 전파(R1)**: 06 §2.2 `ClaudeAcpLaunchConfig.env` 및 `buildClaudeAcpLaunchParams`의 `env`는 **non-secret 전용**으로 한정한다(`AgentRuntimeStartParams.env` = launch argv `-e env KEY=VAL` 경로와 동일 경계). `buildClaudeAcpLaunchParams` 예시의 `env: cfg.env`(secret 포함 가능)는 non-secret만 싣도록 교정하고 env 필드 주석도 non-secret 전용으로 변경한다. v1 기본은 Claude도 WSL 측 자체 인증(`claude login`/config)에 의존해 secret 미전달이며, gateway 등으로 API key가 꼭 필요하면 backend가 `Command::env()`+`WSLENV`로 자식 프로세스 환경에 주입(argv 비경유)한다. 06 §3.3 auth 경로 서술도 이 정본으로 동기화한다. `AgentRuntimeStartParams.env`(15 §8.1)는 **non-secret 전용** 규약임을 06 §2.2·§3.3·07 §5.1·§11·[09](09-permissions-security.md)에 명시(15 §8.1 타입 자체는 손대지 않고 06/07/09를 인용). 평문 영속화 금지는 그대로(10 §7.3). | 해소 완료 — non-secret은 env argv, secret은 `Command::env()`+`WSLENV`(argv 금지), v1은 secret env 미전달이 기본값. C1 경계가 07 backend launch뿐 아니라 **06 Claude launch까지 통일**됐다(non-secret 전용, secret은 `Command::env()`+`WSLENV`). gateway 등 secret 전달이 실제로 필요해질 때 06 §2.2·§3.3·07 §5.1·§11과 [09](09-permissions-security.md)에서 `WSLENV` passthrough 구현·redaction을 확정. |
| OQ-29 | child wait/kill 동시성 모델 — blocking `child.wait()`가 `Mutex` lock 유지 시 `kill()`과 deadlock | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §5.3 | **v1 기본값(D12)**: `Child`를 move한 전용 wait thread + kill은 저장한 OS pid/handle로 수행(blocking wait 중 `Mutex` 미보유). `terminal/mod.rs`의 2-thread 선례를 인용. | **구현 전 확인**: tests.rs로 shutdown grace→kill 경로 deadlock 회피 검증(07 AC-5). lock 보유 구간이 wait를 감싸지 않음을 코드 리뷰로 확인. |
| OQ-30 | **(해소됨, D5)** agent_runtime_cancel 의미 범위 / `agent_runtime_cancel`의 backend 책임 범위 — `process` target만 처리(=shutdown), `request`/`turn`은 frontend가 wire 전송 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §6.3, 15 §8.1, OQ-23 | **확정**: backend `agent_runtime_cancel`은 `{type:"process"}` target만 처리(=shutdown)하고, `request`/`turn` target은 **no-op**(또는 pending id 정리만)이다. turn/request cancel wire는 frontend adapter가 `agentRuntimeSend`로 직접 전송한다(OQ-23, 07 §6.3·14 §5). | 해소 완료 — OQ-23과 동일 정본. command는 15 §8.2 계약대로 유지. |
| OQ-31 | distro allowlist 검증 여부 / WSL path 존재 검증 여부 — `list_wsl_distros` 집합 검증, `test -d` 존재 확인 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §8·§9, [`commands/wsl.rs`] | distro 미검증(spawn 실패로 표면화), path는 **문자열 정규화만**(Windows에서 WSL fs stat 불가) | 존재 검증을 `WslShell::exec`로 할지 결정(UX vs 복잡도). v1은 문자열 검증 + allowlist executable만. |
| OQ-32 | **(해소됨, D10)** ACP v1 `session/update` variant 집합 개수 상충 — ref-acp §2(11종)와 ref-claude-agent-acp §2(13종)가 서로 다른 패키지 버전을 인용해 불일치 | [`ref-acp-protocol.md`](ref-acp-protocol.md) §2, [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) §2, [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) §5·§5.1 | **확정(13종 정본)**: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `plan_update`, `plan_removed`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`. ref-acp §2 / ref-claude-agent-acp §2 / 06 §5·§5.1이 모두 이 목록·개수에 일치해야 한다. | 해소 완료 — Stage 0에서 재검증된 정본. 세 문서의 variant 목록을 위 13종으로 동기화. |
| OQ-33 | Codex outbound `UserInput.text` variant의 정확한 wire 필드 — `text`만 보내는가, `text_elements`도 동반해야 schema가 통과하는가 (C3 verify-at-impl) | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §6.4·§6.5·§6.6, [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §5.3d | **Phase 3 blocker(unverified) — "Codex wire 실측" 묶음(H4, §3 머리말)**: ref-codex §6.5 `TurnStartParams` 예시의 outbound `input`은 `{type:"text", text:"hello"}`(text만)로 보이지만, §6.4·§6.6은 inbound `UserInput.text` item의 스팬 필드 `text_elements`(snake_case, `TextElement[]`)를 **필수**로 명시한다. 둘 중 무엇을 보내야 server schema가 통과하는지는 미검증이며, **틀리면 `turn/start`가 거부되어 Codex 경로 전체가 막힌다**(Phase 3 blocker). 05 §5.3d `mapAgentContentToUserInput`은 이 양가성을 의사코드에 명시(우선 `text` only, 필요 시 `text_elements` 동반)한다. **확인 전 기본 구현 금지(stub)**: 이 hard gate가 통과(wire 실측 확정)하기 전까지 05 §5.3d의 outbound `UserInput.text` 생성기(`makeTextUserInput`)는 **기본 구현을 두지 않고 throw/stub**으로 둔다 — 검증되지 않은 추측 payload로 `turn/start`를 보내 거부당하는 것을 차단한다. 이 gate는 12 T3.1/T3.2의 선행 게이트다(미통과 시 outbound 매핑 확정·구현 금지). | **T0.0 직후 hard gate(OQ-07/OQ-11과 함께)**: codex app-server `generate-ts` 산출물(`schema/typescript/v2/UserInput.ts` @ `rust-v0.142.0`)에서 `text` variant 필수 필드를 확정하고, 단일 `initialize`/`turn.start` wire 캡처에서 `text` only payload가 reject되는지 실측한다. 결과를 05 §5.3d `mapAgentContentToUserInput`/`makeTextUserInput` text 매핑에 반영(text only 또는 text+text_elements 확정)하고, 이때 비로소 stub을 실구현으로 채운다(12 T3.1/T3.2 선행 gate). |
| OQ-34 | **(해소됨, R4 allowlist 강화)** 07 §8.1 spawn allowlist가 `command` **basename만** 검사 — 절대경로 우회·임의 args·임의 env key 주입 위험 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §8.1, [`09-permissions-security.md`](09-permissions-security.md), [`11-testing-acceptance.md`](11-testing-acceptance.md) | **확정(RD-8)**: basename 비교를 **폐기**하고 강화한다. (a) executable `command`는 renderer 입력에서 제거하고 backend가 `provider`로 resolve한 신뢰 절대경로 또는 사전 등록된 절대경로 화이트리스트만 사용한다. (b) **args 정확 검증**: Codex는 `args == ["app-server","--stdio"]` 정확히, Claude는 `args.length==1` 이고 `args[0]`이 검증된 `adapterEntryPath`(절대경로, `claude-agent-acp` `dist/index.js` 패턴)일 것 — 임의 `.js`/임의 바이너리 거부. (c) **env key allowlist**: key는 `^[A-Za-z_][A-Za-z0-9_]*$` + OQ-38에서 확정한 provider별 허용 key 집합으로 강제, 값은 non-secret(RD-14). shell metachar 검사는 방어용으로 유지. 09는 untrusted renderer 위협모델에 backend-resolved executable·args(정확 일치)·env key allowlist 재검증을 명시하고 수용 기준 추가. 11은 해당 allowlist 테스트(승인 절대경로만 통과, Codex 정확 args, Claude `adapterEntryPath` 검증, 추가 `command` 키 구조적 차단, env key allowlist) 추가. | 해소 완료 — 07 §8.1을 backend-resolved executable+정확 args+env key allowlist로 교정(basename-only 제거)하고, 09 위협모델·수용 기준 + 11 테스트를 동기화한다. |
| OQ-35 | **(해소됨, R5 무응답 폐기 금지)** 미지원 server request(`id` 있는 server→client 요청)를 무응답으로 silent-drop하면 provider가 영구 대기(deadlock) | [`04-normalized-agent-model.md`](04-normalized-agent-model.md) §5, [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §7.1, [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md), [`ref-acp-protocol.md`](ref-acp-protocol.md) §1, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §4 | **확정(RD-15)**: provider server→client **REQUEST**(JSON-RPC `id` 있음) 중 미지원 method는 **반드시 JSON-RPC error 응답**(예: `code -32601` method not found) 또는 명시적 decline/cancel 응답을 보낸다 — **무응답 silent-drop 금지**. unknown **NOTIFICATION**(`id` 없음)은 응답 불필요, raw 보존+counter로 가시화(RD-10). 04 §5에 규칙 신설. 05 §7.1 default 분기는 `routing.resolveApproval` 후 `return []`로 끝내지 말고 unknown server request에 JSON-RPC error/unsupported(또는 decline) 응답을 먼저 보낸다. 06도 동일 원칙으로 parity 응답. 11에 unknown-request 응답 테스트 추가. | 해소 완료 — REQUEST 무응답 금지(error/decline 의무), NOTIFICATION은 raw 보존+counter. 04 §5 규칙 + 05 §7.1/06 default 분기 + 11 테스트를 이 정본으로 동기화한다. |
| OQ-36 | command/entry resolve 주체 — backend가 `provider`로 resolve하는 executable/adapter entry의 책임자·캐시 무효화·탐색 방식 | [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) §2.2, [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §2.2, [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §8.1, [`11-testing-acceptance.md`](11-testing-acceptance.md) §5.3 | **결정 필요 / Phase 2 blocker**: 보안 계약은 확정(RD-8) — renderer가 command를 넘기지 않고 backend가 신뢰 절대경로를 resolve한다. 미정인 것은 resolve cache 위치, 무효화 트리거, npm 설치 위치 탐색, WSL distro별 캐시 key. | T2.2/T2.4 구현 전 `resolve_trusted_executable(provider,distro)`와 `resolve_trusted_adapter_entry(provider,distro)`의 owner 모듈(`agent_runtime/allowlist.rs` 또는 별도 `resolver.rs`), cache key/TTL/clear 조건, 실패 에러 문구를 확정하고 07 §8.1·11 RS-8..RS-10c와 동기화. |
| OQ-37 | serde 버전 확인 — `rename_all_fields` 사용 가능 여부 | [`15-data-contracts.md`](15-data-contracts.md) §8, [`11-testing-acceptance.md`](11-testing-acceptance.md) §5.7 | **결정 필요**: `#[serde(rename_all_fields = "camelCase")]`를 우선 사용. 현재 `src-tauri/Cargo.toml`의 serde 버전이 1.0.181 미만이면 필드별 `#[serde(rename = "...")]`로 대체. | 구현 전 `src-tauri/Cargo.toml`과 lockfile에서 serde 버전을 확인. RS-21..RS-25 round-trip 테스트는 구현 방식과 무관하게 camelCase 필드 일치만 assert. |
| OQ-38 | provider env key allowlist 집합 — Codex/Claude별 non-secret env 허용 key | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §8.1, [`09-permissions-security.md`](09-permissions-security.md), [`11-testing-acceptance.md`](11-testing-acceptance.md) §5.3 | **결정 필요 / Phase 2 blocker**: 정규식 통과만으로는 부족하며 provider별 allowlist가 필요. v1 기본은 secret env 미전달(RD-14)이고, non-secret key는 최소 집합부터 시작. | T2.2/T2.4 구현 전 Codex와 Claude 각각 허용할 non-secret key를 05/06/07/09에 같은 이름으로 명시하고 RS-12b 테스트 fixture에 반영. secret이 필요하면 argv가 아니라 `Command::env()`+`WSLENV` 경로로 별도 결정. |
| OQ-39 | backpressure 임계값 — `MAX_MESSAGE_LOG_BYTES`/`BACKPRESSURE_NOTIFY_INTERVAL`/line cap | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §7.2·§7.3, [`11-testing-acceptance.md`](11-testing-acceptance.md) §5.5, [`research/codebase-backend.md`](research/codebase-backend.md) §2.3 | **결정 필요 / Phase 2 blocker**: v1 동시성 모델은 `std::thread`+`Mutex`로 확정됐으므로 미정인 것은 tokio 여부가 아니라 JSON-RPC message log/line cap/notify interval/drop-vs-block 수치 정책이다. | T2.3 구현 전 대용량 stdout fixture 기준으로 message log cap, single-line max, notify interval을 정하고 07 상수명·11 RS-16/17 기대값을 동기화. |
| OQ-40 | 14와 본 표 동기화 유지 — 11 E2E 표 번호와 14 시퀀스 다이어그램의 1:1 대응 | [`11-testing-acceptance.md`](11-testing-acceptance.md) §7, [`14-sequence-and-state.md`](14-sequence-and-state.md) | **운영 항목**: 14의 시퀀스가 바뀌면 11 §7 E2E 번호와 설명을 함께 갱신한다. | 14 수정 PR에서는 `rg "14 대응|E2E-" docs/plans/agent-direct-runtime/11-testing-acceptance.md`로 표 대응을 확인하고, 누락 시 11/14를 같은 커밋에서 수정. |
| OQ-41 | 경로·외부 핀 preflight — 현재 작업 루트와 Codex/ACP/Claude adapter baseline freshness 확인 | [`00-index.md`](00-index.md) "현재 작업 경로 확인 규칙", [`HANDOFF.md`](HANDOFF.md) "시작 전 반드시 확인", [`01-source-map.md`](01-source-map.md) §4, [`12-implementation-workstreams.md`](12-implementation-workstreams.md) T0.0 | **결정 필요 gate / Phase 0 hard gate**: 문서 baseline은 `e7a5f9e`, Codex `rust-v0.142.0`, ACP schema baseline 후보 `schema-v1.16.0`(**구현 핀 아님**), Claude adapter `0.51.0`. 구현 시점의 `pwd`/git root/CLI/schema/package가 다를 수 있다. | 구현 시작 시 `pwd`, `git rev-parse --show-toplevel`, `git status --short --branch`, `codex --version`, `codex app-server generate-ts`, ACP public tag/release 및 패키지 schema artifact, `npm view @agentclientprotocol/claude-agent-acp version`을 확인. baseline과 다르면 schema diff와 fixture replay 결과를 기록하고 핀 갱신 여부를 결정. T0.0 완료 전 T0.1/T0.3/T0.4를 시작하지 않는다. ACP 생성 타입의 정본은 sdk `0.29.0` 기준(`session/update` 13 variant, OQ-32)과 정합해야 한다 — public schema/release artifact를 고르더라도 13종 정본을 우선한다. |
| OQ-42 | sdk 타입 의존 방식 — frontend가 `@agentclientprotocol/sdk` 타입을 직접 import할지 부분 wire 미러를 둘지 | [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) §1.2 | **1차 권고**: 부분 타입 미러. frontend는 raw `JsonRpcMessage`와 필요한 ACP subset만 다루고, 실제 adapter process는 backend가 spawn하는 별도 node process다. | 구현 전 bundle 영향/ESM 호환/타입 전용 import 가능성을 확인. sdk 직접 의존을 택하면 package/lockfile와 Vite 번들 영향을 문서화하고, 부분 미러를 택하면 ref-acp/ref-claude와 fixture로 drift를 잡는다. |
| OQ-43 | client capability 1차 값 — ACP fs/terminal/terminal_output/terminal-auth/elicitation 광고 범위 | [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) §3.2·§3.3 | **1차 기본값**: fs/terminal/terminal_output/elicitation은 false, 인증은 WSL 측 자체 로그인/config 의존. terminal/gateway interactive auth는 후속. | `AskUserQuestion`, terminal tool output, editor file IO를 CLCOMX가 직접 대행해야 하는 요구가 생기면 capability별 UX/보안 범위를 06/08/09/11에 함께 반영한다. |
| OQ-44 | session/close 필요성 — Claude ACP 멀티세션 close를 wire로 보낼지 process shutdown만 쓸지 | [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) §4.4 | **1차 기본값**: process당 세션 1개 모델이면 process shutdown으로 충분. 한 process에서 여러 session을 공유하면 `session/close` 필요. | 구현 구조가 process-per-session인지 multiplex인지 확정한 뒤 06 §4.4와 14 shutdown 시퀀스에 반영. multiplex를 택하면 close/delete/fork/list capability 처리와 테스트를 추가한다. |
| OQ-45 | `src/tools.ts` tool content/diff 세부 매핑 및 `SettingsManager.filterEscalatingDefaultMode` 동작 재확인 | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) §6, [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) §12 | **구현 전 재확인**: export 존재는 확인됐지만 세부 content shape와 policy filter 동작은 전문 확인 필요. | `@agentclientprotocol/claude-agent-acp@0.51.0` 소스의 `src/tools.ts`/`src/settings.ts`를 읽어 diff/tool content와 escalating default mode 처리 결과를 06 mapping 및 테스트 fixture에 반영. |
| OQ-46 | Codex `reasoning`(thought) completed item의 권위 필드 — `summary: string[]` vs `content: string[]` 중 무엇이 권위인가 | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §6.3, [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §5.3, [`04-normalized-agent-model.md`](04-normalized-agent-model.md) §3.2.5 | **결정 필요(unverified)**: ref-codex §6.3은 `reasoning` item에 `summary: string[]`과 `content: string[]`을 모두 정의한다. completed reasoning item을 thought 채널 권위로 reconcile(04 §3.2.5)할 때 어느 필드가 본문인지 미확정. 보수적 기본값 = 둘 다 join 표시 `[...item.summary, ...item.content].join("\n")`(05 §5.3). | **구현 전 확인**: codex app-server wire 실측(reasoning completed item 캡처)에서 단일/우선 필드를 확정하고, 단일 권위 필드가 드러나면 05 §5.3 reasoning completed 매핑을 join에서 해당 필드로 좁힌다. |
| OQ-47 | approval inline/modal 분류 신호 매핑 — 어떤 provider 신호를 `severity:"escalation"`(modal)로 올릴지 | 15 §5 `ApprovalRequest.severity`, [`09-permissions-security.md`](09-permissions-security.md) §8.3, [`08-ui-composition.md`](08-ui-composition.md) §4.4, [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md)·[`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) approval 매핑 | **v1 기본값(재정의)**: v1 approval 기본 severity는 `normal`(inline)이되, **[09](09-permissions-security.md) §8.3 고위험 집합은 v1부터 `severity:"escalation"`(modal)**이다. 고위험 집합 = approval/모드 신호가 **Claude `bypassPermissions`, Codex `danger-full-access`/sandbox 우회(`Agent (Full Access)`)** 에 해당하는 경우. 05/06 approval 매핑이 이 신호를 감지하면 `ApprovalRequest.severity`(15 §5)를 escalation으로 부여한다. **"v1 전부 normal"이라고 단정하지 않는다.** OQ-47의 **후속(잔여) 범위 = 추가 escalation 신호(protected path 쓰기 등) 확대**이지, §8.3 고위험 집합을 inline으로 강등하는 것이 아니다. 감지 가능한 wire 신호가 불명확한 부분(어떤 wire 필드가 위 모드 진입을 표시하는지)만 OQ-47 잔여로 남긴다. | **구현 전 확인**: 05/06 approval 매핑에서 §8.3 고위험 모드(bypassPermissions/danger-full-access/sandbox 우회)의 정확한 wire 표현을 확인해 escalation 부여 규칙을 확정하고, 추가 escalation 신호(protected path 등)는 후속으로 확대한다. 08 §4.4 inline/modal 렌더 분기와 합의(§8.3 집합은 modal). |
| OQ-48 | 멀티 윈도우 registry 윈도우 소유권/수명 모델 — 12 T1.4 module-level registry의 window 바인딩·정리·dispatch 경계 | [`12-implementation-workstreams.md`](12-implementation-workstreams.md) T1.4, 위험 §1.11 | **결정 필요 / T1.4 선행 gate**: 보수적 기본값(§1.11 완화책) = registry 단일 윈도우 소유 + `runtimeId`↔window 바인딩 + window-close 시 소유 엔트리만 정리 + cross-window dispatch 금지(불변식). 미정인 것은 정확한 소유권 전이·윈도우 닫힘 시 잔존 runtime 처리·전역 vs 윈도우별 pending table 구조. | T1.4 구현 전 registry의 window 소유권/수명 모델을 확정하고 12 T1.4 산출물·DoD와 §1.11 완화책을 동기화. window-close 격리·cross-window dispatch 차단 테스트(11 §)를 추가. |
| OQ-49 | framing 붕괴 latch 노출 범위 — 07 §4.4 latched-failed 플래그를 reader-local `bool`로 둘지, `AgentRuntime` 공유 상태로 노출해 `AgentRuntimeSnapshot.status`(15 §8.1)에 반영할지 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §4.2·§4.4 | **결정 필요(v1 기본값)**: v1 기본은 reader-local `bool`(latch 후 라인 drop·추가 framing 에러 suppress, frontend는 1회 emit된 `recoverable:false`로만 인지). 공유 상태 노출은 snapshot 기반 재진입/진단이 필요할 때 후속. | T2.3 구현 시 latch를 reader-local로 두되, snapshot에 framing-failed를 드러낼 필요가 생기면 07 §3 상태에 플래그를 올리고 15 §8.1 snapshot·11 RS에 반영. |
| OQ-50 | emit-throttle / coalesce / buffer-drop 후속 — v1 diagnostic-only bounded replay log를 넘어 실제 emit 압력 완화(throttle/coalesce/drop policy, emit buffer cap)를 도입할지 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §7.2, 위험 §1.8 | **후속(v1 미도입)**: v1은 bounded replay log + telemetry(`droppedMessages`)만이며 emit 자체는 throttle/coalesce/drop하지 않는다(frontend는 실시간 stream 그대로 수신). 대용량 delta 폭주로 UI 렌더 부하가 실측되면 emit cap/coalesce/buffer drop policy를 도입. | 대용량 출력 fixture로 UI 렌더 부하를 실측한 뒤 throttle/coalesce/drop 수치·정책을 정하고 07 §7.2·11 §에 반영. v1은 diagnostic-only bounded log를 유지. |
| OQ-51 | approval audit trail 저장 위치·보존기간·포맷 — in-memory 외 영속 저장소·retention·레코드 포맷 미확정 | [`09-permissions-security.md`](09-permissions-security.md) §3.4, [`12-implementation-workstreams.md`](12-implementation-workstreams.md) audit task, [`11-testing-acceptance.md`](11-testing-acceptance.md) audit 수용 | **v1 기본값**: in-memory audit(결정·시각·`requestId`·`optionId`·`kind`·`outcome`·`decidedBy{user\|auto\|cleanup}`) + **opt-in redacted 영속 로그**(09 §3.4 형식 — 명령 전문/credential/파일 내용 비저장). 미정 = 영속 저장소 위치·보존기간·레코드 포맷. | audit task 구현 전 영속 저장소(파일 vs OS store)·retention 정책·레코드 포맷을 09 §3.4 형식과 일치하도록 확정하고, 11 audit 수용(모든 결정 1건 기록 + 비밀 비포함)·12 audit task와 동기화. v1은 in-memory + opt-in redacted 영속을 기본으로 유지. |

> 레지스트리 운용: 항목이 해소되면 출처 문서에서 "verified"로 승격하고 본 표에서 제거하거나 "(해소됨)"으로 표기한다(ref-codex §10·ref-acp §14의 해소 표기 컨벤션과 동일). 새 unverified 항목이 생기면 출처 문서에 표시하고 여기 OQ-N으로 추가한다.

---

## 4. 교차 참조

| 대상 | 문서 | 절 |
|---|---|---|
| 타입 정의(정본) | [`15-data-contracts.md`](15-data-contracts.md) | §3, §4, §5, §7, §8 |
| 상태 머신·approval 생명주기·cleanup 불변식(규칙 권위) | [`04-normalized-agent-model.md`](04-normalized-agent-model.md) | §2, §4, §5 |
| Codex 매핑·unverified | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) | §8, §10 |
| ACP 매핑·open questions | [`ref-acp-protocol.md`](ref-acp-protocol.md) | §13, §14 |
| Claude adapter launch/node/auth·unverified | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) | §1, §3, §6 |
| transport·framing·WSL 경계·allowlist(절대경로+정확 args+env key, R4) | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) | §8.1, 전체 |
| Codex adapter default 분기·미지원 server request 응답(R5) | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) | §7.1 |
| Claude adapter default 분기·non-secret env(R1·R5) | [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) | §2.2, §3.3, §5 |
| 권한·보안·감사·redaction·untrusted renderer 위협모델(R4) | [`09-permissions-security.md`](09-permissions-security.md) | 전체 |
| allowlist 테스트·unknown-request 응답 테스트(R4·R5) | [`11-testing-acceptance.md`](11-testing-acceptance.md) | 전체 |
| persistence·transcript 정책·scrub | [`10-persistence-migration.md`](10-persistence-migration.md) | 전체 |
| UI 구성·composer·thought/usage surface | [`08-ui-composition.md`](08-ui-composition.md) | 전체 |
| UX 근거·open questions | [`research/ux-reference.md`](research/ux-reference.md) | §11, §12 |
| backend 코드 현실(allowlist·scrub·backpressure) | [`research/codebase-backend.md`](research/codebase-backend.md) | §2, §4, §6, §10 |
