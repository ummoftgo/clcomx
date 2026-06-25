# Risks and Open Questions

> 이 문서는 CLCOMX "Direct Agent Runtime"의 **위험 레지스트리·확정 기본값(Resolved defaults)·Open questions 집계**의 단일 출처다. 다른 문서에서 "unverified" 또는 "결정 필요"로 올라온 항목은 모두 여기 §3 레지스트리로 모은다.
>
> **역할 분리**: 타입 정의는 [`15-data-contracts.md`](15-data-contracts.md), 규칙·불변식은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md)가 권위다. 이 문서는 그 두 문서가 의존하는 **결정/가정/위험만** 다루고 타입·규칙을 재정의하지 않는다. 위험 완화 방법이 특정 설계를 인용할 때는 해당 문서 §번호로 링크한다.
>
> **읽는 법**: §1은 카테고리별 위험(영향·완화·검출). §2는 Resolved defaults(현 시점 확정 기본값과 근거). §3은 Open questions 레지스트리(질문/출처/현재 기본값/구현 전 확인 방법). 구현 에이전트는 §2를 "그대로 따르고", §3은 "구현 착수 전 확인 게이트"로 쓴다.

조사 시점: 2026-06-25. 코드 정합 기준: 브랜치 `feat/claude-tui-fullscreen-option`.

---

## 1. 위험 레지스트리 (카테고리별)

각 항목은 **영향(Impact)** / **완화(Mitigation)** / **검출(Detection)** 3축으로 기술한다. 심각도(S1=치명, S2=중대, S3=보통)는 v1 범위 기준 상대 평가다.

### 1.1 Protocol drift (S1)

Codex app-server protocol과 ACP/Claude adapter는 빠르게 변한다. 메서드명·필드·discriminant·enum 멤버가 minor 버전에서 바뀔 수 있다.

- **영향**: pinned ref(`rust-v0.142.0`, `schema-v1.16.0`, `@agentclientprotocol/claude-agent-acp@0.51.0`)와 실제 런타임 바이너리가 어긋나면 adapter의 wire→`AgentEvent` 매핑(15 §3, ref-codex §8, ref-acp §13)이 조용히 깨진다. 새 notification이 무시되거나, 사라진 필드가 `undefined`로 흘러 transcript가 비거나, discriminant 변경으로 event가 unknown으로 떨어진다.
- **완화**:
  1. generated type과 runtime package 버전을 **함께 핀**한다(§2 Resolved defaults). Codex는 ref `rust-v0.142.0`, ACP는 schema `schema-v1.16.0`/wire `protocolVersion=1`, Claude adapter는 npm `0.51.0` 고정.
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
  1. v1은 **stdio 전용**으로 구현한다(§2). `AgentRuntimeStartParams`에 websocket variant 타입은 유지하되 Rust handler는 1차에서 `Err("websocket transport not yet supported")` 반환.
  2. websocket auth token 저장 위치·redaction은 검증 후 [`09-permissions-security.md`](09-permissions-security.md)에 반영(05 §72). 그 전까지 평문 저장 금지.
- **검출**: `transportKind:"websocket"`로 들어오는 호출은 handler에서 명시적 거부 + 로그. UI는 stdio만 노출.

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
  1. cancel/turn 종료/process exit 시 unresolved approval을 `cancelled`로 닫고 wire 응답도 보낸다(04 §4.2 규칙 1–4). `process_exited`는 모든 pending request를 실패로 닫는다(04 §5, 15 §3 `process_exited`).
  2. pending table은 `AgentRuntimeSnapshot.pendingRequestIds`(15 §8.1)로 진단 가능하게 노출한다.
  3. `ApprovalDecision.outcome:"failed"`는 client 내부용이며 wire로 보내지 않는다(04 §4.2 규칙 4).
- **검출**: cleanup 누락 회귀 테스트(11 §): cancel/탭 닫기/process kill 각각에서 pending이 0으로 떨어지는지 assert. snapshot의 `pendingRequestIds` 길이를 텔레메트리로.

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

- **영향**: bounded queue saturation 시 메시지 드롭으로 transcript 정합성이 깨지거나, unbounded면 메모리 폭증. UI 렌더가 delta 폭주로 멈춘다.
- **완화**:
  1. backend transport는 bounded queue를 쓰고 saturation 시 `agent-runtime-backpressure{droppedMessages}`(15 §8.3)로 가시화한다. UI는 recoverable warning을 표시하고 pending approval은 자동 방치하지 않는다(05 §66).
  2. command output은 transcript content가 아니라 `command_output_delta`(15 §3)로 흐르게 하고, 대용량은 ring buffer/요약으로 캡한다.
  3. late-attach 신뢰성을 위해 message에 단조 증가 seq + snapshot/delta-since를 PTY와 동일 원리로 적용(후속, 15 §8.3 · 04 §3.4 · `research/codebase-backend.md` §2.3·§10 권고 3).
- **검출**: backpressure event 카운터. 대용량 출력 fixture(수 MB stdout) replay 시 드롭 0 또는 명시적 backpressure 신호 assert(11 §).

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
  1. Claude adapter는 npm `@agentclientprotocol/claude-agent-acp@0.51.0`을 고정한다(§2 갱신). ACP wire는 `protocolVersion=1`, schema `schema-v1.16.0` 기준.
  2. 0.50.0↔0.51.0 capability 차이는 CHANGELOG로 확인 후 고정 버전 근거를 문서에 남긴다(레지스트리 OQ-08).
  3. `initialize`/`session/new` 응답의 `protocolVersion`·capability를 metadata에 기록하고, 기대와 다르면 startup 경고(1.1과 동일 메커니즘).
- **검출**: 의존성 lock 검증 + startup capability assert. 버전 bump PR에서 fixture replay 회귀 통과 필수.

---

## 2. Resolved defaults (확정 기본값)

아래는 v1 구현이 **그대로 따르는** 확정 기본값이다. 변경하려면 이 문서를 갱신하고 관련 문서(05/06/07/10/15)에 반영해야 한다.

| # | 결정 | 값 / 정책 | 근거 |
|---|---|---|---|
| RD-1 | runtime gating | direct runtime은 첫 구현에서 **실험 flag 뒤**에 둔다. experimental Codex 기능은 그 안에서 한 단계 더 gate. | 위험 1.2 |
| RD-2 | transport 우선순위 | Codex·Claude 모두 **stdio 우선**. websocket은 후속(검증 후 optional), 1차 handler는 명시적 거부. | 05 §1, 07 §transport, 위험 1.3 |
| RD-3 | transcript full cache | 1차 범위에서 **제외**. provider replay(ACP `session/load`, Codex `thread/read`)와 metadata 저장에 집중. | [`10-persistence-migration.md`](10-persistence-migration.md) §40, 15 §7 |
| RD-4 | raw protocol log | **기본 off**. redacted debug mode만 둔다(비밀·자격 redaction 적용). | 09 §, 위험 1.1 |
| RD-5 | Claude adapter 의존성 | npm `@agentclientprotocol/claude-agent-acp@**0.51.0**` 고정(commit `23626c9`). | 15 §0(헤더), ref-claude, 위험 1.10 |
| RD-6 | Codex ref 핀 | `rust-v0.142.0` 기준 매핑. | 15 §0(헤더), ref-codex |
| RD-7 | ACP 핀 | schema `schema-v1.16.0`, wire `protocolVersion=1`. | 15 §0(헤더), ref-acp |
| RD-8 | startup allowlist 강화 | `command`/`args`/`env`는 adapter가 생성한 검증값만 허용. Rust handler가 **provider별 allowlist로 재검증**(임의 executable/shell string 차단). PTY 대비 의도적 강화. | 15 §8.1 주석, 07 §83, 09 §21, `research/codebase-backend.md` §6·§10 권고 6 |
| RD-9 | resume 비밀 scrub | `providerSessionId`/`providerThreadId`/`providerResumeToken`은 디스크 저장 직전 scrub(기존 `pty_id`/`resume_token`과 동일). history 미저장. | 15 §7.3 보안 경계, `research/codebase-backend.md` §4.2·§4.4·§10 권고 7 |
| RD-10 | unknown variant 처리 | adapter는 unknown method/variant를 **silent drop 금지**. `raw` 보존 + 로그/카운터. | 위험 1.1, 15 §0.2 |
| RD-11 | pending approval cleanup | cancel/turn 종료/process exit 시 unresolved approval을 `cancelled`로 닫고 wire 응답 전송. process exit은 모든 pending request 실패 처리. | 04 §4.2·§5, 위험 1.5 |
| RD-12 | node 설치 전제 | Claude adapter는 node 런타임 + SDK **optional dependency 포함** 설치를 전제. `--omit=optional` 금지, startup preflight 수행. | ref-claude §node, 위험 1.9 |
| RD-13 | thought / audio content | **(해소됨, D11)** thought/reasoning은 `agent_message`/`agent_message_delta`의 optional `channel?: "response" \| "thought"`(미지정 시 `"response"`)로 normalize한다(15 §3). thought delta는 messageId/contentIndex별 append, completed reasoning item이 thought 채널의 권위(reconcile)다(04 §3.2.2·§3.2.5). UI는 `channel==="thought"`를 접이식 thinking 블록(기본 collapsed)으로 렌더한다(08). `audio` content는 **미지원**(OQ-04). | 15 §3, 04 §3.2.2·§3.2.5, 05 §5.2, 06 §5, 08, OQ-01 |

> 기존 문서(보강 전)에 있던 5개 default(실험 flag, stdio 우선, transcript cache 제외, raw log off, npm 고정)는 모두 위 표에 흡수·구체화했다. npm 버전은 **0.50.0 → 0.51.0**으로 갱신(RD-5).

---

## 3. Open questions 레지스트리

다른 문서에서 "unverified" 또는 "결정 필요"로 올라온 항목을 한 곳에 집계한다. 구현 에이전트는 **해당 항목을 건드리기 전에** "구현 전 확인 방법"을 먼저 수행한다.

| ID | 질문 | 출처 문서 §| 현재 기본값(가정) | 구현 전 확인 방법 |
|---|---|---|---|---|
| OQ-01 | **(해소됨, D11)** `agent_thought_chunk`(ACP thought) / Codex `reasoning`에 대응하는 전용 event/content가 없다 — v1 처리 정책? | 15 §3, [`ref-acp-protocol.md`](ref-acp-protocol.md) §13.2·§14, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §6.3 | **확정**: `agent_message`/`agent_message_delta`에 optional `channel?: "response"\|"thought"` 추가(15 §3). thought delta는 messageId/contentIndex별 append, completed reasoning item이 권위(04 §3.2.2·§3.2.5). 05 §5.2: `item/reasoning/textDelta`→`agent_message_delta{channel:"thought"}`, completed reasoning item→`agent_message{channel:"thought", mode:"replace"}`(더 이상 `[]` 드롭 아님). 06 §5: `agent_thought_chunk`→`agent_message_delta/agent_message{channel:"thought"}`. | 해소 완료 — 다운스트림은 위 정책을 그대로 구현. UI 렌더(접이식 thinking 블록, 기본 collapsed)는 08 §5.1에서 확정. |
| OQ-02 | `TokenUsage` vs ACP `usage_update`(`used`/`size`/`cost`) — context gauge 표현에 04/15 필드 추가가 필요한가? | [`research/ux-reference.md`](research/ux-reference.md) §12·§266, 15 §5 `TokenUsage` | 현재 `TokenUsage`는 Codex 축만(input/output/cached/reasoning); ACP `used`만 보강 또는 raw 보존 | ACP `UsageUpdate{used,size}` 매핑 검토 후 04/15에 필드 추가 여부 결정. 08 context gauge 요구와 합의. |
| OQ-03 | ACP `Diff{oldText,newText}` → 15 `AgentContent.diff{patch}` 변환 규칙? | [`research/ux-reference.md`](research/ux-reference.md) §12, 15 §4 | adapter가 patch 생성(15 §4 주석) | `src/tools.ts`(`toolUpdateFromToolResult`)에서 diff content shape 확인 후 patch 생성 알고리즘 확정(06 §). |
| OQ-04 | ACP `audio` content 미지원 결정 시 강등/표시 정책? | [`ref-acp-protocol.md`](ref-acp-protocol.md) §13.2·§14, [`research/ux-reference.md`](research/ux-reference.md) §12 | v1 미지원(RD-13) | 미지원 placeholder 표시 vs 무시를 08 UI에서 확정. |
| OQ-05 | send/개행 키 바인딩 — `Enter`=전송 vs `Shift+Enter`=전송? | [`research/ux-reference.md`](research/ux-reference.md) §370·§428 | `Shift+Enter`=개행, `Enter`=전송(웹 관례) | 기존 CLCOMX composer UX 컨벤션 확인 후 08 §composer에서 통일. |
| OQ-06 | session/thread 목록 UI — Zed식 sidebar/switcher 도입 vs 기존 탭 모델 + turn status badge? | [`research/ux-reference.md`](research/ux-reference.md) §429 | 기존 탭 모델에 turn status badge 얹기 | 08 §에서 결정. 기존 탭 모델(`research/codebase-frontend.md`)과의 정합 확인. |
| OQ-07 | Codex `initialize`→`initialized` 핸드셰이크가 필수인가(없이 `thread/start` 가능?), 메시지 순서/타이밍 검증 | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §10·§606·§613·§614 | **v1 기본값(D12)**: `initialize`→`initialized` 핸드셰이크를 **항상 수행**(방어적 기본값). | **구현 전 확인**: app-server crate handler 읽고 핸드셰이크 필수 여부·실제 wire 캡처로 순서 검증. 05 §startup 시퀀스에 반영. |
| OQ-08 | claude-agent-acp `0.50.0` vs `0.51.0` capability 차이(diff 미인용) | [`research/ux-reference.md`](research/ux-reference.md) §430, [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) §6·§488 | `0.51.0` 고정(RD-5) | CHANGELOG 확인. 고정 버전과 ACP `schema-v1.16.0` 호환 재확인(01 재확인 체크). |
| OQ-09 | Anthropic이 서드파티 제품에 claude.ai 로그인/rate limit 제공을 허용하는가(정확 문구 미확인) | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) §1·§6·§482 | 사용자 본인 자격/키 전제, claude.ai 우회 금지(위험 1.7) | 공식 overview/permissions 페이지 문구 확인 후 09 §auth에 반영. |
| OQ-10 | 배포 대상의 node/claude/SDK 번들 버전(조사 머신 값과 다를 수 있음) | [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) §6·§119·§485 | 조사 머신 `node v24.14.0`/`claude 2.1.187`(unverified for target) | target 환경에서 node 버전·native binary resolve 가능 여부 preflight 확인(위험 1.9). |
| OQ-11 | Codex `ClientInfo`/`InitializeCapabilities` 정확 필드(capability opt-in 키, experimental 노출 제어) | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §10·§148 | **v1 기본값(D12)**: 최소 `ClientInfo`(`name`/`version`)만 전송, capabilities는 보수적(null/omit), experimental 키 미사용(unverified). | **구현 전 확인**: codex app-server `generate-ts` 산출물(`ClientInfo`/`InitializeCapabilities`)과 실측 wire로 필드 검증 후 05 §initialize에 반영. |
| OQ-12 | ACP image: base64 `data` → 15 `AgentContent.image.uri` 변환(data URI vs 저장 후 uri) | 15 §4 주석, [`ref-acp-protocol.md`](ref-acp-protocol.md) §13.2 | adapter가 data URI 또는 저장 후 uri 생성(15 §4) | 대용량 image 시 data URI 메모리 영향 검토 후 저장 정책 확정(06 §, 1.8과 연계). |
| OQ-13 | ACP `requires_action`/`running`/`idle` 합성 규칙(특히 permission pending ↔ `requires_action`) 확정 | [`ref-acp-protocol.md`](ref-acp-protocol.md) §13.1·§695, 04 §2.2 | client 합성: `session/request_permission` 수신 → `requires_action`(04 §2.2) | 04 §2.2 합성 규칙을 정본으로 확정하고 06 adapter에서 그대로 구현. |
| OQ-14 | Codex `reject_always` 등가 영구 거부 decision의 정확한 매핑 | [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §10·§615 | `decline`로 매핑 권장(unverified) | Codex decision enum schema 재확인 후 05 §approval 매핑 확정. |
| OQ-15 | Codex websocket transport·auth token 저장/redaction 정책 | 05 §12·§72, 07 §transport, 15 §8.1 | v1 미구현, 평문 저장 금지(RD-2·1.3) | websocket wire 검증 후 09 §에 저장/redaction 반영. v1은 게이트 유지. |
| OQ-16 | direct 세션 cross-restart 복원 — scrub로 재개 키가 디스크에 없어 앱 재시작 후 direct 대화 복원 불가. 허용할 것인가/대안? | [`10-persistence-migration.md`](10-persistence-migration.md) §4.5, 15 §7.3 | 1차 범위 **제외**(PTY resume와 동일). cold restore는 §4.4 복원 불가 처리 | (a) OS secret store 저장 또는 (b) provider session store가 sessionId만으로 최신 세션 resolve 가능한지 검증 후 결정. v1은 제외 유지. |
| OQ-17 | late-attach seq 메커니즘 부재 — process 생존 중 transcript surface unmount 시 store 재구성 불가 | [`10-persistence-migration.md`](10-persistence-migration.md) §4.3, 15 §8.3, [`research/codebase-backend.md`](research/codebase-backend.md) §2.3·§10 | **v1 기본값(D12)**: transcript surface를 process 생존 동안 **unmount 안 함**으로 회피(`display:none` 유지). message `seq` 필드는 **후속**. 08의 탭 전환/가상화 계약이 surface unmount를 유발하지 않음을 전제. | **구현 전 확인**: 08 §의 탭 전환·가상화 경로가 transcript surface를 unmount하지 않음을 확인. seq 도입 시 message payload에 단조 증가 seq + snapshot/delta-since 추가(07 §framing) 후 late-attach 재구성 활성화. |
| OQ-18 | `WorkspaceTabSnapshot` 확장(`runtime_kind`/`agent_runtime`)의 동기화 범위 — `merge_workspace_snapshot`/`applyWorkspaceWindowSnapshot`/`session-store-snapshot.ts` 영향 | [`10-persistence-migration.md`](10-persistence-migration.md) §3.2·§3.3, [`research/codebase-backend.md`](research/codebase-backend.md) §11, [`research/codebase-frontend.md`](research/codebase-frontend.md) §10 | serde default로 forward-compat 보장(가정); 복원 경로는 **미독·추정** | `service/window_ops.rs::merge_workspace_snapshot`와 `session-store-snapshot.ts` 본문 읽고 새 필드 전파 경로 확정 후 10 §3에 반영. |
| OQ-19 | Codex permissions approval(`item/permissions/requestApproval`) 응답 `{permissions: GrantedPermissionProfile, scope}` 구성 | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §7.1·§7.2, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §4.3 | **v1 기본값(D12)**: command/fileChange 승인만 지원. permission-profile escalation(`requestApproval`)은 **자동 decline**하고 원본은 `raw` 보존. CodexRouting(05 §6)은 원본 JSON-RPC id의 실제 타입(`string\|number`)을 보관하는 필드/메서드를 두어 응답 시 타입을 복원한다. | **구현 전 확인**: `permissions.rs`의 `GrantedPermissionProfile` schema 확인 후 05 §7.2 응답 구성 확정. CodexRouting id 타입 복원 단위 테스트(05). [09](09-permissions-security.md)와 escalation 정책 합의. |
| OQ-20 | `turn/start` approval/sandbox 정책 필드(`approvalPolicy`/`sandboxPolicy`/`model`/`effort`) v1 노출 여부·기본값 | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §2.4, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §6.5 | v1은 `threadId`/`input`만 전송, override 미설정 | [09](09-permissions-security.md)에서 sandbox/approval 기본값 정책 확정 후 05 §2.4에 반영. |
| OQ-21 | standalone `command/exec` 채널(`command/exec/outputDelta`, base64) v1 지원 범위 | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §8.1, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §3.3·§5.3 | v1 미지원 — thread 채널(`item/commandExecution/outputDelta`)만 | thread-less sandbox 실행 UI 요구 여부를 08과 합의. v1은 thread 채널만 유지. |
| OQ-22 | thread 채널 `item/commandExecution/outputDelta`의 stdout/stderr 구분 | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §8.1, [`ref-codex-app-server-protocol.md`](ref-codex-app-server-protocol.md) §5.2 | wire에 stream 정보 없음 → v1은 `stdout` 고정 | `item.rs` outputDelta payload에 stream 필드 존재 여부 재확인. 없으면 stdout 고정 유지. |
| OQ-23 | **(해소됨, D5)** turn cancel 소유권 — 어댑터가 `turn/interrupt` RPC 직접 전송 vs backend `agent_runtime_cancel`(`AgentRuntimeCancelTarget`)이 wire 변환 | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §7.3, [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §6.3, 15 §8.1 | **확정**: frontend adapter가 `turn/interrupt`(ref-codex §3.2) 등 turn/request cancel wire를 `agentRuntimeSend`로 **직접 전송**한다. backend `agent_runtime_cancel`은 wire 변환을 하지 않는다(07 §6.3·14 §5 정본). approval cancel 응답(JSONRPCResponse)도 어댑터가 직접 send. | 해소 완료 — 05 §7.3·07 §6.3·14 §5와 일치. 03 §경계는 adapter 전송으로 기술. |
| OQ-24 | `codexBin` 경로 override(settings 노출) 및 startup preflight(`codex --version` 일치 검증) | [`05-codex-app-server-adapter.md`](05-codex-app-server-adapter.md) §2.2·§11 | 기본 `codex`(PATH), settings override 미노출 | settings UI에 binary 경로 필드 추가 여부 결정([`research/codebase-frontend.md`](research/codebase-frontend.md) §7). preflight는 [11](11-testing-acceptance.md)에 추가. |
| OQ-25 | backend async 모델 — `std::thread`+`Arc<Mutex>` 유지 vs tokio 도입 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §3·§7.4, [`research/codebase-backend.md`](research/codebase-backend.md) §7·§11 | **std::thread 유지**(현 backend tokio import 0건, PTY 패턴 정합) | tokio 도입은 ADR 결정 사항([`adr-001-direct-agent-runtime.md`](adr-001-direct-agent-runtime.md)). backpressure/timeout 요구가 polling으로 불충분할 때만 재검토. v1은 std::thread. |
| OQ-26 | `decode_utf8_stream_chunk` 공용화 방식 — `pub(super)`→`pub(crate)` 가시성 상향 vs `features/io_util.rs` 추출 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §2, [`research/codebase-backend.md`](research/codebase-backend.md) §2.6·§11 | **가시성 상향**(최소 변경) | 추출(b) 선택 시 `features/terminal/tests.rs`의 `use super::parsing::...` import 갱신 범위 확인. transport.rs가 참조 가능해지면 됨. |
| OQ-27 | WSL cwd 전달 방식 — `wsl --cd <wslPath>` vs provider CLI cwd flag(codex `--cd`, claude launch param) | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §5.1, [`research/codebase-backend.md`](research/codebase-backend.md) §5.1 | **`wsl --cd`**(provider 무관) | 배포 대상 WSL 버전이 `--cd` 지원하는지 확인. 미지원 시 provider flag fallback 경로 05/06에 명시. |
| OQ-28 | direct runtime env 전달 방식 — `wsl.exe -e env KEY=VAL <exe>` vs `WSLENV` | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §5.1 | 미확정(redaction·미저장 경계만 고정, 15 §7.3) | provider별 필수 env(API key 등) 목록 확정 후 전달 메커니즘 선택. 평문 영속화 금지(10 §7.3). [09](09-permissions-security.md)와 합의. |
| OQ-29 | child wait/kill 동시성 모델 — blocking `child.wait()`가 `Mutex` lock 유지 시 `kill()`과 deadlock | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §5.3 | **v1 기본값(D12)**: `Child`를 move한 전용 wait thread + kill은 저장한 OS pid/handle로 수행(blocking wait 중 `Mutex` 미보유). `terminal/mod.rs`의 2-thread 선례를 인용. | **구현 전 확인**: tests.rs로 shutdown grace→kill 경로 deadlock 회피 검증(07 AC-5). lock 보유 구간이 wait를 감싸지 않음을 코드 리뷰로 확인. |
| OQ-30 | **(해소됨, D5)** `agent_runtime_cancel`의 backend 책임 범위 — `process` target만 처리(=shutdown), `request`/`turn`은 frontend가 wire 전송 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §6.3, 15 §8.1, OQ-23 | **확정**: backend `agent_runtime_cancel`은 `{type:"process"}` target만 처리(=shutdown)하고, `request`/`turn` target은 **no-op**(또는 pending id 정리만)이다. turn/request cancel wire는 frontend adapter가 `agentRuntimeSend`로 직접 전송한다(OQ-23, 07 §6.3·14 §5). | 해소 완료 — OQ-23과 동일 정본. command는 15 §8.2 계약대로 유지. |
| OQ-31 | distro allowlist / WSL path 존재 검증 여부 — `list_wsl_distros` 집합 검증, `test -d` 존재 확인 | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) §8·§9, [`commands/wsl.rs`] | distro 미검증(spawn 실패로 표면화), path는 **문자열 정규화만**(Windows에서 WSL fs stat 불가) | 존재 검증을 `WslShell::exec`로 할지 결정(UX vs 복잡도). v1은 문자열 검증 + allowlist executable만. |
| OQ-32 | **(해소됨, D10)** ACP v1 `session/update` variant 집합 개수 상충 — ref-acp §2(11종)와 ref-claude-agent-acp §2(13종)가 서로 다른 패키지 버전을 인용해 불일치 | [`ref-acp-protocol.md`](ref-acp-protocol.md) §2, [`ref-claude-agent-acp.md`](ref-claude-agent-acp.md) §2, [`06-claude-acp-adapter.md`](06-claude-acp-adapter.md) §5·§5.1 | **확정(13종 정본)**: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `plan_update`, `plan_removed`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`. ref-acp §2 / ref-claude-agent-acp §2 / 06 §5·§5.1이 모두 이 목록·개수에 일치해야 한다. | 해소 완료 — Stage 0에서 재검증된 정본. 세 문서의 variant 목록을 위 13종으로 동기화. |

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
| transport·framing·WSL 경계·allowlist | [`07-tauri-process-runtime.md`](07-tauri-process-runtime.md) | 전체 |
| 권한·보안·감사·redaction | [`09-permissions-security.md`](09-permissions-security.md) | 전체 |
| persistence·transcript 정책·scrub | [`10-persistence-migration.md`](10-persistence-migration.md) | 전체 |
| UI 구성·composer·thought/usage surface | [`08-ui-composition.md`](08-ui-composition.md) | 전체 |
| UX 근거·open questions | [`research/ux-reference.md`](research/ux-reference.md) | §11, §12 |
| backend 코드 현실(allowlist·scrub·backpressure) | [`research/codebase-backend.md`](research/codebase-backend.md) | §2, §4, §6, §10 |
