# Glossary (용어집)

> 이 문서는 CLCOMX "Direct Agent Runtime" 계획 전체에서 쓰이는 용어를 한곳에 모은 **참조용 사전**이다. 새 용어를 정의하지 않는다 — 각 용어의 **정본**(타입은 [15](15-data-contracts.md), 규칙은 [04](04-normalized-agent-model.md), wire 사실은 `ref-*`, 코드 현실은 `research/*`)으로 연결만 한다. 정의가 충돌하면 링크된 정본 문서가 권위를 갖는다.
>
> 표기 규약: 기술 식별자(타입/메서드/필드/명령/경로/enum 값)는 원문 영어 그대로 둔다. 한국어 산문으로 의미를 설명한다.

조사 시점: 2026-06-25. 코드 스냅샷 기준: commit `e7a5f9e`; 구현 전 현재 작업트리와 대조.

---

## 1. 아키텍처 레이어 / 역할

| 용어 | 1–2줄 정의 | 정본 |
|---|---|---|
| **provider** | 실제 에이전트 백엔드 종류. CLCOMX에서는 `codex` / `claude` / `legacy-pty` 세 가지(`AgentProvider`). 한 세션을 누가 구동하느냐를 가리킨다. | [15](15-data-contracts.md) §1 `AgentProvider`, [04](04-normalized-agent-model.md) §1 |
| **adapter** | provider wire(Codex JSON-RPC / ACP `session/update`)를 CLCOMX 공통 `AgentEvent`로 변환하고, 반대로 CLCOMX 호출을 provider 요청으로 바꾸는 격리 계층. provider별로 하나씩(Codex / Claude / Legacy PTY). | [03](03-target-architecture.md) §Provider Adapter, [05](05-codex-app-server-adapter.md), [06](06-claude-acp-adapter.md) |
| **runtime (Tauri Process Runtime)** | Rust backend가 agent subprocess의 lifecycle, stdio framing, stderr capture, 종료, bounded queue/backpressure를 담당하는 계층. protocol 의미는 해석하지 않고 transport/framing만 책임진다. | [07](07-tauri-process-runtime.md), [15](15-data-contracts.md) §8, [03](03-target-architecture.md) §Tauri Process Runtime |
| **transport** | provider process와 메시지를 주고받는 물리 채널. v1은 `jsonrpc-stdio`(stdin/stdout JSON-RPC), `websocket`(Codex, 1차 미구현 권고). `AgentRuntimeStartParams.transportKind`로 표현. | [15](15-data-contracts.md) §8.1 `AgentRuntimeStartParams`, [07](07-tauri-process-runtime.md) |
| **Agent Runtime Port** | provider별 구현을 숨기는 TypeScript-facing interface. UI/store는 이 7개 메서드(`startSession`/`resumeSession`/`sendPrompt`/`cancelTurn`/`respondApproval`/`subscribeEvents`/`shutdown`)만 본다. | [15](15-data-contracts.md) §6 `AgentRuntimePort`, [03](03-target-architecture.md) §Agent Runtime Port |
| **Event Router** | 모든 provider event가 통과하는 라우터. provider/session/turn/request id를 기준으로 UI store와 pending request table에 분배한다. | [03](03-target-architecture.md) §Event Router, [12](12-implementation-workstreams.md) (`agent-event-router.ts`) |
| **Session Store** | transcript, tool card 상태, approval, process 상태, provider 원본 id를 보존하는 frontend 상태. direct runtime metadata와 legacy PTY metadata를 분리한다. | [03](03-target-architecture.md) §Session Store, [12](12-implementation-workstreams.md) (`agent-runtime-store.svelte.ts`) |
| **reducer** | `AgentEvent`를 받아 Session Store 상태를 갱신하는 순수 함수. upsert/append/replace/reconcile 규칙을 구현한다. | [04](04-normalized-agent-model.md) §3, [12](12-implementation-workstreams.md) (`agent-event-reducer.ts`) |
| **normalized model** | provider 차이를 흡수한 CLCOMX 내부 공통 데이터 모델. UI/persistence가 protocol에 직접 결합되지 않게 한다. 타입은 15, 규칙은 04. | [15](15-data-contracts.md) §1–§5, [04](04-normalized-agent-model.md) |
| **hexagonal architecture** | UI/저장소(내부)와 provider(외부)를 Port/Adapter로 분리하는 패턴. renderer는 provider-specific type을 직접 import하지 않는다. | [03](03-target-architecture.md) §패턴 |

---

## 2. 세션 도메인 개념 (session / thread / turn / item)

provider마다 같은 단어가 다른 것을 가리킨다. 아래는 **CLCOMX 기준 의미**이고, provider 대응은 §7 대응표를 본다.

| 용어 | 1–2줄 정의 | 정본 |
|---|---|---|
| **session** | 한 작업 맥락. Codex `Thread.sessionId` 또는 ACP `SessionId`에 대응하는 세션 트리/resume 단위. CLCOMX 탭 1개 = 세션 1개. | [04](04-normalized-agent-model.md) §1, [15](15-data-contracts.md) §1.1 |
| **thread** | Codex v2의 대화 thread(`Thread.id`). 한 connection 위에서 여러 thread가 동시에 흐를 수 있다. ACP에는 thread 개념이 wire에 없다. | [15](15-data-contracts.md) §1.1, [ref-codex-app-server-protocol.md](ref-codex-app-server-protocol.md) §7.1 |
| **turn** | 한 번의 prompt→완료 사이클. Codex는 `Turn.id`(wire), ACP는 turn id가 wire에 없어 CLCOMX가 prompt 단위로 합성한다. cancel 대상 단위. | [04](04-normalized-agent-model.md) §1 "turn id 합성 규칙", [15](15-data-contracts.md) §1.1 |
| **item** | Codex transcript의 한 항목(`ThreadItem.id`). 메시지/명령 실행/파일 변경/reasoning이 모두 item이다. Codex upsert/reconcile 키. | [15](15-data-contracts.md) §1.1, [ref-codex-app-server-protocol.md](ref-codex-app-server-protocol.md) §6.3 |
| **message** | 사용자/agent의 대화 메시지. Codex는 itemId가 메시지 역할, ACP는 `ContentChunk.messageId`로 청크를 그룹핑(값이 바뀌면 새 메시지). | [04](04-normalized-agent-model.md) §3.1, [15](15-data-contracts.md) §1.1 |
| **tool call** | agent가 실행한 도구 호출(읽기/편집/실행/검색 등). card로 렌더링되며 status lifecycle을 갖는다. | [15](15-data-contracts.md) §5 `ToolCallUpdate`, [research/ux-reference.md](research/ux-reference.md) §2 |
| **plan** | 실행 계획 항목 목록. 매 update가 이전 plan을 **전부 교체**(replace-only). | [15](15-data-contracts.md) §5 `AgentPlanEntry`, [04](04-normalized-agent-model.md) §3.3 |
| **approval / permission** | agent가 위험 행동 전 사용자 승인을 받는 server→client 요청. CLCOMX는 `requestId`로 pending table을 관리한다. | [15](15-data-contracts.md) §5 `ApprovalRequest`, [04](04-normalized-agent-model.md) §4 |

---

## 3. 정본 타입 식별자 (15에서 정의)

아래 타입은 **재정의 금지**. import/링크만 한다 ([15](15-data-contracts.md) §9 type 인덱스).

| 타입 | 1–2줄 정의 | 정본 |
|---|---|---|
| **AgentEvent** | adapter가 provider wire를 변환해 emit하는 공통 이벤트 union(`type` discriminator). Event Router → reducer로 흐른다. | [15](15-data-contracts.md) §3 |
| **ProviderRef** | provider 원본 id(`sessionId`/`threadId`/`turnId`/`messageId`/`itemId`/`toolCallId`/`requestId`)와 `raw`를 보존하는 라우팅 키 컨테이너. 모든 `AgentEvent`가 들고 다닌다. | [15](15-data-contracts.md) §1, §1.1 |
| **AgentContent** | transcript/tool card가 렌더링하는 content 블록 union(`text`/`image`/`resource`/`terminal`/`diff`/`json`). | [15](15-data-contracts.md) §4 |
| **ToolCallUpdate** | tool call의 상태/내용 부분 갱신(id 기준 upsert). `content`/`locations`는 전체 교체 의미. | [15](15-data-contracts.md) §5 |
| **ApprovalRequest** | 승인 요청(`id`/`title`/`options`/`toolCallId?`). | [15](15-data-contracts.md) §5 |
| **ApprovalOption** | 승인 선택지(`kind`: `allow_once`/`allow_always`/`reject_once`/`reject_always`/`cancel`/`other`). | [15](15-data-contracts.md) §5 |
| **ApprovalDecision** | 승인 결정 결과(`outcome`: `selected`/`cancelled`/`failed`, `optionId?`). `failed`는 client 내부 전용. | [15](15-data-contracts.md) §5 |
| **AgentSessionStatus** | CLCOMX 공통 세션 상태(`starting`/`ready`/`running`/`requires_action`/`idle`/`failed`/`exited`). | [15](15-data-contracts.md) §2, [04](04-normalized-agent-model.md) §2 |
| **AgentPlanEntry** | 실행 계획 항목(`content`/`status`/`priority?`). | [15](15-data-contracts.md) §5 |
| **TokenUsage** | 토큰 사용량(`inputTokens`/`cachedInputTokens`/`outputTokens`/`reasoningOutputTokens`). Codex 축. | [15](15-data-contracts.md) §5 |
| **FileLocation / FileChangeSummary** | 파일 위치(`path`/`line?`/`column?`) / 파일 변경 요약(`operation`/`diff?`). | [15](15-data-contracts.md) §5 |
| **AgentRuntimePort** | §1 참조. provider 구현을 숨기는 TS interface. | [15](15-data-contracts.md) §6 |
| **AgentRuntimeMetadata** | direct runtime 세션 재개/복원용 metadata. resume 키류는 디스크 저장 시 scrub 대상. | [15](15-data-contracts.md) §7.1 |
| **JsonRpcMessage** | JSON-RPC 메시지 4종 union(request/notification/response/error). `jsonrpc` 필드는 optional(Codex는 생략, ACP는 `"2.0"`). | [15](15-data-contracts.md) §8.1 |
| **AgentRuntimeStartParams** | process/transport 기동 파라미터(`transportKind` 태그). `command` 필드는 없고 backend가 provider로 executable을 resolve한다. `args`/`env`는 adapter 생성값만 허용하며 backend가 재검증한다. | [15](15-data-contracts.md) §8.1 |
| **AgentRuntimeEvent** | Rust runtime이 emit하는 transport 레벨 event(`message`/`stderr`/`exit`/`error`/`backpressure`). raw JSON-RPC를 그대로 올린다. | [15](15-data-contracts.md) §8.3 |

---

## 4. 이벤트 적용 규칙 (upsert / append / replace / reconcile)

규칙 정본은 모두 [04](04-normalized-agent-model.md) §3이다.

| 용어 | 1–2줄 정의 | 정본 |
|---|---|---|
| **upsert** | id가 있으면 갱신, 없으면 새로 만든다. message/tool call은 id 기준 upsert(Codex `itemId`, ACP `messageId`/`toolCallId`). | [04](04-normalized-agent-model.md) §3.1 |
| **append** | 기존 content 뒤에 chunk를 붙인다. `mode:"append"` 또는 ACP `*_chunk`(같은 `messageId` 누적). | [04](04-normalized-agent-model.md) §3.1, §3.3 |
| **replace** | 기존 content를 통째로 교체한다. `mode:"replace"`, ACP `tool_call_update.content`/`locations`, `plan`은 전부 replace. | [04](04-normalized-agent-model.md) §3.1, §3.3 |
| **reconcile** | streaming delta로 점진 렌더 후, 최종 completed item을 권위로 삼아 정합화. 키는 Codex `itemId`. 메시지는 delta=completed 가정 가능, plan/reasoning은 completed가 권위. | [04](04-normalized-agent-model.md) §3.2, [ref-codex-app-server-protocol.md](ref-codex-app-server-protocol.md) §7 |
| **sequence (seq)** | provider가 순서를 보장하지 않을 때 adapter가 event에 부여하는 단조 증가 번호. store dedup/정렬·late-attach 신뢰성용. | [04](04-normalized-agent-model.md) §3.4, [15](15-data-contracts.md) §8.3 |
| **순서 보존** | 같은 session 안에서 message/tool 갱신의 수신 순서를 보존하는 불변식. | [04](04-normalized-agent-model.md) §3, §3.4 |

---

## 5. transport / protocol 어휘

| 용어 | 1–2줄 정의 | 정본 |
|---|---|---|
| **ACP (Agent Client Protocol)** | Claude adapter의 1차 protocol. JSON-RPC 2.0 정식(`jsonrpc:"2.0"`). wire `protocolVersion = 1`; schema artifact는 T0.0/OQ-41에서 확정한다(`schema-v1.16.0`은 baseline 후보). | [ref-acp-protocol.md](ref-acp-protocol.md) §1, [15](15-data-contracts.md) 머리말 |
| **app-server (Codex app-server)** | Codex adapter의 1차 연결면. JSON-RPC 유사이나 `jsonrpc` 필드를 보내지도 기대하지도 않는다. pinned `rust-v0.142.0`. | [ref-codex-app-server-protocol.md](ref-codex-app-server-protocol.md) §1.2, [15](15-data-contracts.md) 머리말 |
| **JSON-RPC** | request/notification/response/error 4종 메시지 규약. CLCOMX는 `JsonRpcMessage` union으로 양 provider를 표현(`jsonrpc` optional). | [15](15-data-contracts.md) §8.1 `JsonRpcMessage` |
| **stdio** | stdin/stdout 파이프로 JSON-RPC를 주고받는 transport. v1 Codex/Claude 모두 stdio 우선. | [13](13-risks-open-questions.md) Resolved defaults, [15](15-data-contracts.md) §8.1 |
| **framing** | byte stream에서 개별 JSON-RPC 메시지 경계를 잘라내는 작업. backend runtime 책임이며 protocol 의미는 해석하지 않는다. | [07](07-tauri-process-runtime.md) §Framing, [15](15-data-contracts.md) §8.3 |
| **capability** | initialize 단계에서 교환하는 기능 협상값. ACP는 `clientCapabilities`(`fs`/`terminal`)·`agentCapabilities`(`loadSession`/`resume`)·`promptCapabilities`(image/audio/embeddedContext). | [ref-acp-protocol.md](ref-acp-protocol.md) §session-setup, [ref-claude-agent-acp.md](ref-claude-agent-acp.md) §1 |
| **initialize** | protocol 버전 협상 + capability 교환 단계. process spawn과 분리되며, 끝나야 세션이 `ready`가 된다. | [04](04-normalized-agent-model.md) §2.1 규칙 1, [07](07-tauri-process-runtime.md) |
| **stopReason** | ACP turn 종료 사유(`end_turn`/`max_tokens`/`max_turn_requests`/`refusal`/`cancelled`). CLCOMX `turn_completed.status`로 축약하고 원본은 raw 보존. | [ref-acp-protocol.md](ref-acp-protocol.md) §3.6, [research/ux-reference.md](research/ux-reference.md) §6 |
| **session/update** | ACP의 진행 상황 notification. message/tool/plan/usage variant를 담는다. ACP에는 별도 `state_update`가 없다. | [ref-acp-protocol.md](ref-acp-protocol.md) §13, [15](15-data-contracts.md) §2 ACP 주의 |
| **serverRequest/resolved** | Codex가 pending approval이 다른 경로로 해결됐음을 알리는 notification. 해당 `requestId`를 닫는다. | [04](04-normalized-agent-model.md) §4.2, [ref-codex-app-server-protocol.md](ref-codex-app-server-protocol.md) §4.4 |

---

## 6. 권한 / 보안 / 영속화 어휘

| 용어 | 1–2줄 정의 | 정본 |
|---|---|---|
| **permission mode** | "언제 물을지"를 정하는 모드. Claude `default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions`, Codex Chat/Agent/Agent(Full Access). CLCOMX는 표시·전달만 하고 임의 우회 금지. | [09](09-permissions-security.md), [research/ux-reference.md](research/ux-reference.md) §8 |
| **sandbox mode** | "무엇을 읽/쓸지"를 정하는 모드(permission mode와 별개 축). | [research/ux-reference.md](research/ux-reference.md) §8.1 (Codex IDE) |
| **allow_always / acceptEdits** | "기억하는 승인". audit trail 준비 전까지 CLCOMX 저장 비활성화(옵션이 와도 한 번만 허용으로 취급). | [09](09-permissions-security.md), [research/ux-reference.md](research/ux-reference.md) §8.2 |
| **scrub** | 디스크 저장 직전 비밀 필드를 제거하는 작업. `provider_session_id`/`provider_thread_id`/`provider_resume_token`은 기존 `pty_id`/`resume_token`처럼 scrub 대상. | [15](15-data-contracts.md) §7.3 보안 경계, [10](10-persistence-migration.md), [research/codebase-backend.md](research/codebase-backend.md) §4.2 |
| **allowlist** | Rust handler가 backend-resolved executable/`args`/`env`를 provider별로 재검증해 임의 executable/shell string을 차단하는 목록. PTY 대비 의도적 강화 지점. | [15](15-data-contracts.md) §8.1 주의, [09](09-permissions-security.md), [research/codebase-backend.md](research/codebase-backend.md) §6 |
| **pending request table** | resolve되지 않은 approval/server request를 `requestId`로 관리하는 구조. cancel/exit 시 cleanup이 필수. | [04](04-normalized-agent-model.md) §4, §5, [15](15-data-contracts.md) §8.1 `AgentRuntimeSnapshot.pendingRequestIds` |
| **approval cleanup** | turn cancel/shutdown(process 생존)은 unresolved approval을 `cancelled`로 닫고 wire 응답; process exit(사망)은 `failed`(내부, wire 미전송)로 닫는 불변식. ACP/Codex MUST와 대응. | [04](04-normalized-agent-model.md) §4.2, §5.0 |
| **migration** | 기존 `workspace.json`에 runtime kind/metadata를 optional 확장으로 더해 forward/backward 호환을 유지하는 작업. | [10](10-persistence-migration.md), [15](15-data-contracts.md) §7.2, §7.3 |
| **replay (session/load, thread/read)** | 과거 대화를 provider가 update notification으로 다시 흘려보내 transcript를 재구성하는 것. capability(`loadSession`) 필요. | [research/ux-reference.md](research/ux-reference.md) §10, [15](15-data-contracts.md) §6 `ResumeSessionParams.replay` |
| **resume (session/resume, thread/resume)** | history replay 없이 context/MCP만 재연결하는 재개. | [research/ux-reference.md](research/ux-reference.md) §10, [15](15-data-contracts.md) §6 |
| **backpressure** | bounded queue가 포화될 때 메시지 누락을 알리는 신호. `agent-runtime-backpressure` event로 보고. | [15](15-data-contracts.md) §8.3, [07](07-tauri-process-runtime.md) |

---

## 7. legacy 터미널 어휘 / 3축 구분

| 용어 | 1–2줄 정의 | 정본 |
|---|---|---|
| **PTY** | pseudo-terminal. 기존 CLCOMX가 agent를 실행하는 방식. direct runtime 도입 후에도 보조 셸·명령 embed·fallback으로 보존. | [02](02-current-state.md), [research/codebase-backend.md](research/codebase-backend.md) §2 |
| **xterm (xterm.js)** | 기존 터미널 emulator. direct runtime에서는 embed/보조 dock/legacy fallback·raw diagnostic view 용도로만 사용. | [02](02-current-state.md), [research/ux-reference.md](research/ux-reference.md) §5.2 |
| **legacy** | 기존 PTY/xterm 경로. `AgentProvider`의 `legacy-pty`, `SessionRuntimeKind`의 `pty`로 표현. 삭제하지 않는다. | [04](04-normalized-agent-model.md) §3.5, [15](15-data-contracts.md) §1 |
| **fallback** | direct runtime 실패 시 legacy PTY 경로로 되돌아가는 대비책. | [12](12-implementation-workstreams.md) Phase 6, [13](13-risks-open-questions.md) |
| **terminal_output_delta** | legacy PTY/embedded terminal의 byte stream을 보존하는 event. transcript 모델로 끌어올리지 않는다. | [15](15-data-contracts.md) §3, [04](04-normalized-agent-model.md) §3.5 |
| **command_output_delta** | thread 채널의 명령 실행 stdout/stderr 증분(`stream`/`delta`). transcript의 execute tool card에 흐른다. terminal_output_delta와 구분. | [15](15-data-contracts.md) §3, [research/ux-reference.md](research/ux-reference.md) §5 |

### 7.1 헷갈리기 쉬운 3축 (반드시 구분)

세 enum은 **독립된 축**이다. 한쪽 값을 다른 쪽으로 확장하지 않는다.

| 축 | 타입 | 값 | 의미 | 정본 |
|---|---|---|---|---|
| 어떤 runtime으로 구동하나 (persistence) | `SessionRuntimeKind` | `pty` / `direct-codex` / `direct-claude` | 세션 host 종류. 디스크에 저장. | [15](15-data-contracts.md) §7.1 |
| process/transport 실행 방식 (transport) | `transportKind` (in `AgentRuntimeStartParams`) | `jsonrpc-stdio` / `websocket` | provider process와의 물리 채널. | [15](15-data-contracts.md) §8.1 |
| 한 host 내부 surface 토글 (UI) | `SessionViewMode` | `terminal` / `editor` | 같은 세션 안에서 보여줄 화면. **`agent`로 확장하지 않는다.** | [15](15-data-contracts.md) §7.2 주의, [research/codebase-frontend.md](research/codebase-frontend.md) §5, §9 |

> 핵심: `SessionRuntimeKind`는 "host가 무엇인가", `transportKind`는 "어떻게 연결하나", `SessionViewMode`는 "host 내부에서 무엇을 보여주나"다. runtimeKind를 viewMode에 섞으면 안 된다([15](15-data-contracts.md) §7.2 주의).

---

## 8. Codex / ACP / CLCOMX 용어 대응표

같은 개념을 부르는 이름이 provider마다 다르다. CLCOMX 정규화 결과는 `ProviderRef`/`AgentEvent`/`ToolCallUpdate` 등이다. 정확한 매핑표 정본은 Codex [ref-codex-app-server-protocol.md](ref-codex-app-server-protocol.md) §8, ACP [ref-acp-protocol.md](ref-acp-protocol.md) §13.

| 개념 | Codex (app-server v2) | ACP (v1) | CLCOMX (normalized) | 비고 |
|---|---|---|---|---|
| 세션 트리/resume 단위 | `Thread.sessionId` | `SessionId` | `ProviderRef.sessionId` | resume 키 후보 |
| 대화 thread | `Thread.id` (`threadId`) | (없음) | `ProviderRef.threadId` | Codex 라우팅 1차 키 |
| turn | `Turn.id` (`turnId`) | (wire id 없음, prompt 1회=turn) | `ProviderRef.turnId` | ACP는 CLCOMX가 합성 ([04](04-normalized-agent-model.md) §1) |
| transcript item | `ThreadItem.id` (`itemId`) | (메시지는 `messageId`) | `ProviderRef.itemId` | Codex upsert 키 |
| 메시지 청크 그룹 | (itemId가 역할) | `ContentChunk.messageId` | `ProviderRef.messageId` | ACP upsert 키 |
| tool call | `commandExecution`/`fileChange`/`mcpToolCall` item id | `ToolCallId` | `ProviderRef.toolCallId` | tool card upsert 키 |
| approval 요청 id | JSON-RPC `id` (+`approvalId?`) | JSON-RPC `id` | `ProviderRef.requestId` | 응답 매칭 키 |
| agent 메시지 스트림 | `item/agentMessage/delta` → `item/completed` | `agent_message_chunk` (messageId) | `agent_message_delta` + `agent_message` | Codex는 reconcile, ACP는 chunk append |
| 사용자 메시지 | `UserInput` item | `user_message_chunk` (replay 시) | `user_message` | |
| reasoning/thought | `reasoning` item | `agent_thought_chunk` | `agent_message_delta` + `agent_message`의 `channel:"thought"` | 전용 event 없이 thought 채널로 흐름(해소됨) — [15](15-data-contracts.md) §3, [04](04-normalized-agent-model.md) §3.2.2 |
| 실행 계획 | `turn/plan/updated` (`TurnPlanStep`) | `plan` (`PlanEntry`) | `plan_updated` + `AgentPlanEntry` | replace-only |
| tool 분류 | item type | `ToolKind` (10종, `switch_mode` 포함) | `ToolCallUpdate.kind` (9종) | `switch_mode`→`other` |
| tool 상태 | `CommandExecutionStatus` (`inProgress`/`completed`/`failed`/`declined`) | `ToolCallStatus` (`pending`/`in_progress`/`completed`/`failed`) | `ToolCallUpdate.status` | ACP엔 `cancelled` 없음→client 합성, Codex `declined`→`failed` |
| 승인 선택지 종류 | decision enum | `PermissionOptionKind` (4종) | `ApprovalOption.kind` (6종) | `cancel`/`other`는 CLCOMX 확장 |
| 승인 응답 | `{ id, result:{ decision } }` (jsonrpc 없음) | `{ jsonrpc:"2.0", id, result:{ outcome } }` | `ApprovalDecision` | adapter가 envelope 변환 ([04](04-normalized-agent-model.md) §4.1) |
| turn 종료 신호 | `turn/completed` | `stopReason` (응답) | `turn_completed.status` | `completed`/`failed`/`cancelled` |
| 토큰 사용량 | `TokenUsageBreakdown` | `UsageUpdate` (`used`/`size`) | `TokenUsage` (Codex 축) | 두 축 다름 ([research/ux-reference.md](research/ux-reference.md) §6) |
| 세션 상태 | `ThreadStatus` (`notLoaded`/`idle`/`active`/`systemError`) | (wire 없음, client 합성) | `AgentSessionStatus` | [04](04-normalized-agent-model.md) §2.2 |
| 에러 | `error` (`willRetry`/`codexErrorInfo`) | JSON-RPC error | `error` (`recoverable`) | [04](04-normalized-agent-model.md) §5 |
| 파일 변경 | `fileChange` item (`FileUpdateChange`) | `Diff{oldText,newText}` content | `FileChangeSummary` / `AgentContent{diff}` | adapter가 patch 생성 ([15](15-data-contracts.md) §4) |
| 명령 실행 | `commandExecution` item + `outputDelta` | `terminal/*` + `type:"terminal"` content | `command_output_delta` / `AgentContent{terminal}` | [research/ux-reference.md](research/ux-reference.md) §5 |

---

## 9. 교차 참조

| 대상 | 문서 |
|---|---|
| 모든 타입 정의(정본) | [15-data-contracts.md](15-data-contracts.md) |
| 상태 머신·upsert/reconcile·approval 생명주기 규칙(정본) | [04-normalized-agent-model.md](04-normalized-agent-model.md) |
| Codex wire 사실 | [ref-codex-app-server-protocol.md](ref-codex-app-server-protocol.md) |
| ACP wire 사실 | [ref-acp-protocol.md](ref-acp-protocol.md) |
| Claude ACP 구현체 | [ref-claude-agent-acp.md](ref-claude-agent-acp.md) |
| UX 패턴 어휘(transcript/approval/composer) | [research/ux-reference.md](research/ux-reference.md) |
| backend/frontend 코드 현실 | [research/codebase-backend.md](research/codebase-backend.md), [research/codebase-frontend.md](research/codebase-frontend.md) |
| 미확정 용어/정책 | [13-risks-open-questions.md](13-risks-open-questions.md) |
