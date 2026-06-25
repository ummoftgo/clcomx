# UX Reference: 구조화된 Transcript UI 패턴

확인일: 2026-06-25

## 목적

이 문서는 CLCOMX가 terminal byte stream 대신 **구조화된 transcript UI**(doc [08-ui-composition.md](../08-ui-composition.md))를 만들 때 참고할 UX 패턴을 1차 자료에서 추출한 것이다. 조사 대상은 ACP(Agent Client Protocol) client 구현 가이드, Zed Agent Panel, OpenAI Codex IDE extension, Claude Code interactive/fullscreen 문서다. 각 패턴은 doc [04-normalized-agent-model.md](../04-normalized-agent-model.md)의 공통 모델(`AgentEvent`, `ToolCallUpdate`, `ApprovalRequest` 등)과 doc 08 transcript surface에 어떻게 매핑되는지 명시한다.

추출 원칙:

- 상호작용·레이아웃·정보구조 패턴만 추출한다. 시각/브랜딩/카피는 복제하지 않는다(doc [09-permissions-security.md](../09-permissions-security.md) 브랜드 항목 준수).
- **확인된 사실**은 출처 URL과 가능한 경우 git ref/version을 붙인다. 추정은 "추정"으로 명시한다.
- 기술 식별자/메서드/타입/enum 값은 원문 영어 그대로 둔다.

## 0. 자료 출처와 버전 앵커

| 자료 | URL | 버전/ref (확인일 2026-06-25) | 비고 |
|---|---|---|---|
| ACP 문서 | https://agentclientprotocol.com/protocol/overview | 문서 site, schema `schema-v1.16.0` (2026-06-24) | CLCOMX Claude adapter의 1차 protocol |
| ACP releases | https://github.com/agentclientprotocol/agent-client-protocol/releases | `schema-v1.16.0` (2026-06-24T14:10Z), `schema-v1.15.0`, `schema-v1.14.0` | schema 태그는 문서 protocol version과 별개 축 (doc 01 주의) |
| ACP tool calls | https://agentclientprotocol.com/protocol/tool-calls | site | tool call kind/status/content/permission |
| ACP content | https://agentclientprotocol.com/protocol/content | site | content block 5종 |
| ACP terminals | https://agentclientprotocol.com/protocol/terminals | site | command output embed |
| ACP prompt turn | https://agentclientprotocol.com/protocol/prompt-turn | site | streaming, stop reason, usage_update |
| ACP agent plan | https://agentclientprotocol.com/protocol/agent-plan | site | plan replace 규칙 |
| ACP session setup | https://agentclientprotocol.com/protocol/session-setup | site | initialize/capability, load replay |
| Zed Agent Panel | https://zed.dev/docs/ai/agent-panel | docs site | reference ACP client UI |
| Zed External Agents | https://zed.dev/docs/ai/external-agents | docs site | ACP 외부 에이전트 호스팅 |
| Codex IDE features | https://developers.openai.com/codex/ide/features | docs site | approval mode, composer |
| Codex IDE settings | https://developers.openai.com/codex/ide/settings | docs site | font/locale/WSL 설정 |
| Codex IDE | https://developers.openai.com/codex/ide | docs site | approval/sandbox 개념 |
| Claude Code interactive | https://code.claude.com/docs/en/interactive-mode | docs site | composer/shortcut/task list |
| Claude Code fullscreen | https://code.claude.com/docs/en/fullscreen | docs site | alt-screen transcript viewer |
| Claude Code permission modes | https://code.claude.com/docs/en/permission-modes | docs site | default/acceptEdits/plan/auto/dontAsk/bypassPermissions |

로컬 환경 확인값(2026-06-25): `codex-cli 0.142.0`, `2.1.187 (Claude Code)`, `@agentclientprotocol/claude-agent-acp@0.51.0`(npm latest). doc 01 source-map은 `claude-agent-acp` v0.50.0 기준이므로 구현 시 버전 차이를 재확인한다.

> 주의: ACP 문서 fetch는 요약 모델을 거쳤다. 아래에 인용한 enum/field 이름은 원문 표기를 그대로 옮겼으나, **구현 직전에 `schema/v1`의 실제 JSON Schema와 대조**해야 한다(doc 01 "구현 전 재확인 체크" 참조).

---

## 1. Transcript surface: 메시지와 streaming

### 1.1 확인된 패턴

**ACP** — prompt turn은 client가 `session/prompt`를 보내며 시작하고, agent는 `session/update` notification으로 진행 상황을 보고한다. message 관련 update variant는 다음과 같다(출처: ACP prompt-turn).

| `sessionUpdate` discriminator | 의미 | 핵심 필드 |
|---|---|---|
| `agent_message_chunk` | 모델의 text 응답 조각 | `messageId`. "같은 `messageId`는 같은 message에 속하고, `messageId`가 바뀌면 새 message" |
| `agent_thought_chunk` | reasoning/thought 조각 (별도 stream) | message와 구분되는 사고 과정 |
| `user_message_chunk` | user message 조각 (주로 `session/load` replay 시) | `session/load`에서 history 재생에 사용 |
| `tool_call` / `tool_call_update` | 아래 §2 | |
| `plan` | 아래 §4 | |
| `usage_update` | 아래 §6 | `used`, `size`, optional `cost` |

> 참고: 위 fetch 요약에는 `agent_thought_chunk`/`user_message_chunk`가 "제공된 본문에 없음"으로 표시됐으나, ACP는 두 variant를 정의한다(doc 06 `agent_thought`, doc 04 mapping 표에서 이미 전제). 구현 시 schema에서 정확한 discriminator를 확정한다 — **추정**.

**Claude Code(fullscreen)** — alt-screen rendering에서 **input box가 화면 하단에 고정**되고 출력이 stream되어도 움직이지 않는다. "Only visible messages are kept in the render tree" — 보이는 message만 render tree에 유지해 긴 대화에서도 메모리가 일정하다(출처: Claude Code fullscreen). 이것이 streaming transcript의 핵심 layout 원칙이다.

**Zed** — agent thread를 Agent Panel에 호스팅한다. user/agent 메시지가 thread로 누적되고, agent가 편집을 진행하는 동안 따라갈 수 있는 "Follow Agent"(crosshair icon)를 제공한다(출처: Zed Agent Panel).

### 1.2 CLCOMX 매핑

- `agent_message_delta`(doc 04) → message card에 append. Codex는 delta 먼저 반영 후 completion item으로 reconcile, ACP는 `agent_message_chunk`를 `messageId`별로 append(doc 06 upsert 규칙과 일치).
- reasoning/thought는 **별도 collapsible 블록**으로 둔다. doc 08 "reasoning/plan summary"에 해당. agent message와 시각적으로 구분하되 같은 turn 안에 배치.
- doc 08 "Responsive layout: transcript는 tab content 영역 기준 full-height flex layout"을 Claude fullscreen의 "고정 하단 input + 스크롤 transcript 영역" 구조로 구체화한다. composer는 sticky bottom, transcript는 그 위 scrollable region.
- 가상화(visible message만 mount)는 긴 transcript 성능을 위해 **권장 사항**으로 doc 08 Responsive layout에 추가할 만하다 — Claude fullscreen이 같은 전략을 명시적으로 채택.

```text
┌─ Transcript surface (scrollable, virtualized) ────────────┐
│  [user message]                                            │
│  [reasoning block ▸ collapsed]                             │
│  [agent message  ▌streaming…]                              │
│  [plan card]                                               │
│  [tool call card …]                                        │
│  ────────────────── (auto-follow anchor) ───────────────── │
├─ Composer (sticky bottom) ────────────────────────────────┤
│  [multiline input]            [status] [model] [send/stop] │
└────────────────────────────────────────────────────────────┘
```

---

## 2. Tool call card

### 2.1 확인된 패턴 (ACP가 가장 구체적)

**tool call 핵심 필드**(출처: ACP tool-calls):

| 필드 | 설명 |
|---|---|
| `toolCallId` | session 내 unique id |
| `title` | "human-readable title describing what the tool is doing" |
| `kind` | 시각 표현 선택용 분류 (아래) |
| `status` | 실행 lifecycle |
| `content` | 산출물 배열 |
| `locations` | 영향을 받은 파일들 (`path` 필수, `line` optional) — "follow-along" 추적용 |
| `rawInput` / `rawOutput` | 원본 파라미터/결과 |

**`kind` enum (ToolKind)** — client가 적절한 아이콘/표현을 고르는 힌트(출처: ACP tool-calls):

`read`, `edit`, `delete`, `move`, `search`, `execute`, `fetch`, `think`, `other`.

→ doc 04 `ToolCallUpdate.kind`와 **정확히 동일**(`read|edit|delete|move|search|execute|think|fetch|other`). 매핑 변환 불필요.

**`status` enum** — `pending`(입력 streaming 또는 user 승인 대기), `in_progress`(실행 중), `completed`, `failed`(출처: ACP tool-calls).

→ doc 04는 추가로 `cancelled`를 둔다. ACP에 `cancelled`가 status로 없으므로, adapter는 turn cancel 시 미완료 tool call을 `cancelled`로 닫는 변환을 자체 수행한다(doc 04 Store 규칙과 일치) — **CLCOMX 자체 규칙**.

**content 3종**(출처: ACP tool-calls):

1. **Content blocks**: 일반 text/image/resource (§3 content block 참조)
2. **Diffs**: `path`, `oldText`, `newText` 필드
3. **Terminals**: `type: "terminal"` + `terminalId` 참조로 live command output (§5 참조)

**Zed의 tool/edit 리뷰**(출처: Zed Agent Panel):

- "Changes Accordion": 어떤 파일이, 몇 개, 몇 줄 편집됐는지 surface.
- "Review Changes" 버튼(`shift-ctrl-r`)으로 multi-buffer 전체 변경 검토.
- hunk 단위 accept/reject 또는 전체 set 일괄 처리.
- `agent.single_file_review` 활성 시 inline diff를 개별 파일에 표시.

**Codex IDE** — transcript에 `web_search` item 등 tool call이 표시된다. diff는 "Change Preview & Application" 흐름으로 표시하고 로컬에 apply 가능(출처: Codex IDE, IDE features).

**Claude Code(fullscreen)** — "Click a collapsed tool result to expand it... The tool call and its result expand together. Only messages that have more to show are clickable"(출처: Claude Code fullscreen). 즉 tool call과 result가 **한 쌍으로 collapse/expand**되고, 더 보여줄 내용이 있는 카드만 클릭 가능하다. `/focus` 모드는 tool call을 "one-line summary with edit diffstats"로 축약(출처: Claude Code fullscreen).

### 2.2 CLCOMX 매핑 (kind별 카드 표현)

doc 08 Tool Card 절을 다음 표로 구체화한다. `kind` 값은 ACP/doc 04 공통.

| `kind` | collapsed summary | expanded content | 비고 |
|---|---|---|---|
| `read` | `title` + 첫 location path | content block(text/resource), `locations` 목록 | follow-along: `locations[].line`로 점프 |
| `search` | `title` + match 수(있으면) | result content block | 긴 결과는 §7 접기 |
| `fetch` | `title` + URL/리소스명 | fetched content (text/resource) | network 행위는 승인과 연결 가능(doc 09) |
| `edit` | `path` + `+N/-M` diffstat | diff content(`path`/`oldText`/`newText`) → diff card | Zed "Changes Accordion" 스타일 diffstat |
| `delete` / `move` | operation + `path`(+`oldPath`) | `FileChangeSummary`(doc 04) | move는 old→new path |
| `execute` | command 1줄 + cwd | terminal embed(`terminalId`) stdout/stderr | §5 |
| `think` | 요약 1줄 | reasoning/plan 텍스트 | §1 reasoning 블록과 통합 가능 |
| `other` | `title` | `rawInput`/`rawOutput` JSON(접힘) | fallback 표현 |

- **collapse/expand는 tool call + result를 한 쌍으로 토글**(Claude fullscreen 패턴). doc 08에 "tool card는 nested card를 피한다" 원칙이 있으므로, diff/terminal은 tool card 안의 **단일 전용 영역**으로 두고 다단 중첩을 피한다.
- "더 보여줄 게 있는 카드만 expand 가능" 규칙을 채택하면, 빈 결과/짧은 결과 카드의 불필요한 클릭 affordance를 제거할 수 있다 — **권장**.
- `locations`를 doc 04 `FileLocation[]`로 보존하고, click 시 CLCOMX editor/파일 열기로 연결(Zed follow-along, Claude `Cmd/Ctrl`-click file path 패턴).
- diff card는 doc 04 `AgentContent` `{type:"diff"; path; patch}` 또는 ACP diff(`oldText`/`newText`)를 patch로 정규화해 표시. hunk 단위 accept/reject는 **provider가 승인 흐름을 제공할 때만** 노출(doc 09 "앱이 sandbox 우회 실행 금지").

---

## 3. Content block (메시지·tool 산출물 공통)

### 3.1 확인된 패턴 (ACP, 출처: ACP content)

5종 content block. type discriminator와 필드:

| `type` | 필수 필드 | optional 필드 |
|---|---|---|
| `text` | `text` | `annotations` |
| `image` | `data`(base64), `mimeType` | `uri`, `annotations`. prompt에 넣으려면 `image` prompt capability 필요 |
| `audio` | `data`(base64), `mimeType` | `annotations`. `audio` capability 필요 |
| `resource` (embedded) | `resource`(text variant: `uri`+`text`; blob variant: `uri`+`blob`) | `mimeType`, `annotations`. client-side context 포함에 선호 |
| `resource_link` | `uri`, `name` | `mimeType`, `title`, `description`, `size`(bytes), `annotations` |

### 3.2 CLCOMX 매핑

- doc 04 `AgentContent`는 `text|image|resource|terminal|diff|json` 6종. ACP의 `text`/`image`/`resource`(embedded)/`resource_link`를 다음으로 흡수:
  - `text` → `text`
  - `image` → `image`(doc 04 `uri`/`mimeType`). ACP base64 `data`는 adapter에서 data URI 또는 blob 저장 후 `uri`로 정규화 — **CLCOMX 자체 규칙**.
  - `resource`(embedded text) → `resource`(`uri`+`text`+`mimeType`)
  - `resource_link` → `resource`(`uri`+`mimeType`), `name`/`title`/`size`는 metadata로 보존(doc 04 `raw`)
  - `audio` → v1 미지원. doc 04 content 집합에 없음 → adapter가 `json`/`resource`로 강등하거나 unsupported 표시 — **추정/권장**.
- `annotations`는 v1 UI 필수 계약 아님. `ProviderRef.raw`에 보존(doc 04 "provider-specific payload 보존").

---

## 4. Reasoning / Plan summary 블록

### 4.1 확인된 패턴

**ACP plan**(출처: ACP agent-plan):

- `session/update`의 `sessionUpdate: "plan"`, `entries` 배열.
- `PlanEntry` 필드: `content`(string), `priority`(`high|medium|low`), `status`(`pending|in_progress|completed`).
- **replace 규칙**: "The Agent MUST send a complete list of all plan entries in each update... The Client MUST replace the current plan completely." 매 update가 이전 plan을 전부 대체한다. append/merge 금지.
- agent는 plan entry를 추가/삭제/수정할 수 있다.

**Claude Code task list**(출처: Claude Code interactive):

- 복잡한 multi-step 작업에서 task list 생성, terminal status 영역에 pending/in_progress/complete 표시.
- `Ctrl+T`로 토글, 화면에 최대 5개 표시. context 압축에도 persist.

**Codex** — "Chat"(plan만, 변경 없음) mode가 계획 단계를 분리(출처: Codex IDE features).

### 4.2 CLCOMX 매핑

- doc 04 `plan_updated` event + `AgentPlanEntry`(`id?`, `content`, `status: pending|in_progress|completed`, `priority?: low|medium|high`)가 ACP `PlanEntry`와 **정합**(priority 값 동일, status 값 동일).
- **plan card는 항상 전체 교체(replace)** 로 렌더한다. ACP 규칙을 doc 04 `plan_updated`에 그대로 적용 — 이미 doc 04 mapping에 `plan_update → plan_updated`로 명시됨. doc 08 Store 규칙에 "plan은 replace-only"를 명문화 권장.
- plan card는 transcript 상단부 또는 turn 내 고정 위치에 두고, status별 아이콘(pending/in_progress/completed)으로 진행 표현. Claude task list처럼 **접기 가능 + 최대 N개 표시 + 더보기**를 doc 08에 추가 권장.
- reasoning(thought)와 plan은 doc 08에서 "reasoning/plan summary"로 묶여 있으나, 정보구조상 **둘을 분리**한다: reasoning = 자유 텍스트 collapsible, plan = 구조화 entry 목록(replace). doc 08 명시 권장.

---

## 5. Command 실행 / Terminal embed

### 5.1 확인된 패턴 (ACP terminals가 1차)

**capability**: client는 `initialize` 응답의 `clientCapabilities`에 `terminal: true`를 알려야 terminal 흐름 지원(출처: ACP terminals).

**method**(출처: ACP terminals):

| method | 동작 |
|---|---|
| `terminal/create` | `sessionId`, `command`, `args`, `env`, `cwd`, `outputByteLimit`로 명령 실행, 즉시 `terminalId` 반환(완료 대기 안 함) |
| `terminal/output` | 현재 상태 조회: `output`(현재까지 text), `truncated`(byte limit 초과 여부), `exitStatus`(`exitCode`+`signal`, 완료 시에만) |
| `terminal/wait_for_exit` | 완료까지 block, `exitCode`+`signal` 반환 |
| `terminal/kill` | 실행 중 명령 종료, terminal은 이후 output/wait 조회용으로 유효 유지 |
| `terminal/release` | 명령 kill + `terminalId` 무효화 |

**embed**: tool call content에 `type: "terminal"` + `terminalId`로 포함. "When a terminal is embedded in a tool call, the Client displays **live output as it's generated** and continues to display it even after the terminal is released"(출처: ACP terminals).

**output 관리**: `outputByteLimit` 초과 시 client가 **앞부분부터 truncate**(문자 경계 유지)(출처: ACP terminals).

**Claude Code(fullscreen)** — tool output을 click으로 expand/collapse, file path는 `Cmd/Ctrl`-click으로 열기(출처: Claude Code fullscreen). shell mode(`!` prefix)는 real-time progress/output을 transcript에 표시(출처: Claude Code interactive).

### 5.2 CLCOMX 매핑

- doc 04 `command_output_delta`(`stream: stdout|stderr`, `delta`)와 `terminal_output_delta`(`ptyId`, `seq`, `delta`)가 핵심. ACP의 `terminal/output` polling 또는 stream을 adapter가 `command_output_delta`로 정규화한다.
- doc 08 "execute: command, cwd, stdout/stderr terminal embed"를 다음으로 구체화:
  - card head: `command` + `cwd`(긴 명령은 doc 08 wrapping/horizontal scroll 규칙).
  - body: **고정 높이 + resize handle** terminal embed(doc 08 명시). live append, release 후에도 표시 유지(ACP 규칙).
  - footer: `exitStatus`(`exitCode`/`signal`) — 완료 시 노출. `truncated`면 "앞부분 잘림" 표시 + §7 "open full terminal log" 행동(doc 05 "bounded buffer + open full terminal log"와 일치).
- stdout/stderr stream 구분 보존(doc 05). ANSI는 terminal embed 내부에서만 처리(doc 05). doc 09 "stderr diagnostic은 기본 collapsed".
- doc 08 Focus 원칙: terminal embed가 app shortcut을 가로채지 않게 한다(이미 doc 08 명시). xterm은 embed/보조 dock/legacy fallback 용도로만(doc 08 "Terminal의 새 역할").

---

## 6. 세션/스레드 목록, turn 상태, 토큰 사용량

### 6.1 확인된 패턴

**ACP session 상태**(출처: ACP prompt-turn, session-setup):

- turn은 `session/prompt` 시작, `session/update` 진행, `StopReason`으로 종료.
- `StopReason` 값: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`(출처: ACP prompt-turn).
- `session/cancel`로 turn 중단. "Agent SHOULD stop all language model requests and tool call invocations as soon as possible" 후 `cancelled` stop reason 응답(출처: ACP prompt-turn).
- `usage_update`: `used`(현재 context 소비 토큰, 필수), `size`(session 총 capacity, 필수), `cost`(optional: `amount`+`currency` ISO 4217)(출처: ACP prompt-turn fetch).

**Zed**(출처: Zed Agent Panel / External Agents):

- 토큰 카운트를 profile selector 근처에 표시. threshold 근접 시 auto-compaction, 수동 `/compact`.
- thread 관리: New Thread(`cmd-n`), Thread Switcher(`ctrl-tab`로 최근 thread 순환), Threads Sidebar(`cmd-alt-j`, 프로젝트별 그룹), Archive(`shift-backspace`).
- External agent: "Zed hosts the thread in the Agent Panel and Threads Sidebar, while the External Agent usually owns its own runtime, auth, model selection, tools". ACP 외부 에이전트 thread가 native thread와 함께 sidebar에 표시됨.

**Claude Code**(출처: Claude Code interactive):

- session 이름은 plan 내용으로 자동 명명, `/rename`로 변경.
- PR review status를 footer에 clickable link로(상태 색상 underline) — turn-level 상태 표시의 한 예.

### 6.2 CLCOMX 매핑

- doc 04 `AgentSessionStatus`(`starting|ready|running|requires_action|idle|failed|exited`)가 turn 상태의 source of truth. ACP `running`/`requires_action`/`idle`을 doc 06 mapping대로 흡수. UI는 session list/탭에 status badge로 표시(running/idle 구분은 Zed turn 상태 표시와 동치).
- `StopReason`은 doc 04 `turn_completed.status`(`completed|failed|cancelled`)로 축약하되, 원본 `end_turn|max_tokens|max_turn_requests|refusal|cancelled`는 `ProviderRef.raw`/metadata 보존(doc 04 원칙). `refusal`/`max_tokens`는 transcript에 별도 notice(doc 08 "error/retry notice")로 표시 권장.
- 토큰 사용량: doc 04 `TokenUsage`(`inputTokens`/`cachedInputTokens`/`outputTokens`/`reasoningOutputTokens`)는 Codex 축이고, ACP `usage_update`는 `used`/`size`(+cost) 축이다. **두 축은 다르다.** UI는 다음을 표시할 수 있게 둔다 — **권장 매핑**:
  - "context 사용량 게이지" = ACP `used`/`size`(Zed의 token-near-profile 표시와 동치). Codex에는 직접 대응 필드가 없을 수 있어 turn usage 합산으로 근사.
  - "turn별 토큰" = Codex `TokenUsage`. ACP에는 input/output 세분이 없을 수 있으므로 optional.
  - doc 04에 `usage_update` 대응 필드(`contextUsed`/`contextSize`/`cost`)를 추가할지 **open question** — 현재 doc 04 `TokenUsage`에는 없음.
- session/thread 목록: Zed 패턴(sidebar, 프로젝트별 그룹, switcher, archive)을 doc 08의 미정 영역으로 추가 권장. CLCOMX는 탭/세션 모델이 이미 있으므로 turn status badge + 토큰 게이지를 우선 적용.

---

## 7. 긴 출력 / 접기 / 스크롤 / 포커스 / 접근성

### 7.1 확인된 패턴

**Claude Code(fullscreen)** — 긴 transcript UI의 가장 구체적인 1차 자료(출처: Claude Code fullscreen):

- **auto-follow**: 새 출력이 stream되면 하단으로 따라감. 위로 스크롤하면 auto-follow 일시 정지("Scrolling up pauses auto-follow so new output does not pull you back"). `Ctrl+End` 또는 맨 아래 스크롤로 재개.
- **단, 응답이 필요한 dialog(permission prompt 등)는 auto-scroll 설정과 무관하게 항상 view로 스크롤**된다.
- collapsed tool result는 click으로 expand, 다시 click으로 collapse. "Only messages that have more to show are clickable."
- 스크롤 단축키: `PgUp`/`PgDn`(반 화면), `Ctrl+Home`(대화 시작), `Ctrl+End`(최신 + auto-follow 재개).
- `/focus` 모드: 마지막 prompt + tool call 1줄 요약(diffstat 포함) + 최종 응답만 표시(밀도 축소 뷰).
- transcript viewer(`Ctrl+O`): less-스타일 검색(`/`, `n`/`N`), `[`로 native scrollback에 펼쳐 쓰기(`Cmd+F`/tmux 검색 가능), `?`로 단축키 패널.
- 메모리: 보이는 message만 render tree 유지(가상화).

**Codex IDE 설정**(출처: Codex IDE settings): `chat.fontSize`(대화+composer), `chat.editor.fontSize`(코드/diff 렌더), `chatgpt.localeOverride`(UI 언어). → 접근성(폰트 크기)·i18n 설정 포인트.

### 7.2 CLCOMX 매핑

- doc 08 Focus/shortcut 원칙을 다음으로 보강:
  - **auto-follow + 위로 스크롤 시 정지** 패턴 채택. doc 08에 "transcript는 streaming 중 하단 추종, 사용자가 스크롤하면 일시 중단, 명시적 행동으로 재개" 추가 권장.
  - **approval card는 auto-scroll 설정과 무관하게 항상 화면에 노출**(§8과 연결). 이미 doc 08 "approval request가 active인 동안 composer 상태/cancel behavior 명확히"와 정합.
- 긴 출력/터미널 embed: doc 08 "고정 높이 + resize handle", doc 05 "bounded buffer + open full terminal log". ACP `truncated` flag와 `outputByteLimit`를 그대로 활용(앞부분 truncate). "전체 로그 열기"는 raw diagnostic view(doc 08 xterm 새 역할)로 라우팅.
- 밀도 축소 뷰(Claude `/focus`)는 CLCOMX "compact transcript" 옵션으로 고려 가능 — **권장/옵션**.
- 접근성/포커스 관리:
  - collapsible 요소(tool card, reasoning, plan)는 키보드 토글 + ARIA expanded 상태 노출 — **권장**(원문은 terminal TUI라 ARIA 언급 없음; CLCOMX는 web/Tauri WebView이므로 적용).
  - composer focus와 terminal embed focus 분리(doc 08 이미 명시). modal escape/Space toggle 회귀 보호(doc 08).
  - 폰트 크기/locale를 설정으로 분리(Codex 설정 패턴). doc 08 i18n namespace(`agentRuntime.*`)에 신규 UI text 추가.

---

## 8. 권한/승인(approval) 프롬프트 UX

### 8.1 확인된 패턴

**ACP `session/request_permission`**(출처: ACP tool-calls requesting-permission):

- request: `sessionId`(필수), `toolCall`(승인 대상 tool call update, 필수), `options`(사용자 선택지 배열, 필수).
- `PermissionOption` 필드(모두 필수): `optionId`(unique id), `name`(표시 label), `kind`(아이콘/UI 힌트).
- `PermissionOptionKind` 4종: `allow_once`, `allow_always`, `reject_once`, `reject_always`.
- 응답 `RequestPermissionOutcome` 2형: `selected`(`optionId` 포함), `cancelled`("the prompt turn was cancelled — overrides pending permission requests if the session is terminated").

**Claude Code permission modes**(출처: Claude Code permission modes):

- 모드: `default`(읽기만 무프롬프트), `acceptEdits`(읽기+편집+일부 fs 명령), `plan`(읽기만, 변경 없음), `auto`(분류기 안전검사 하에 대부분 실행), `dontAsk`(사전 승인 tool만), `bypassPermissions`(모두 실행).
- `Shift+Tab`으로 `default → acceptEdits → plan` 순환. status bar에 현재 모드 표시.
- protected path 쓰기는 `bypassPermissions` 제외 전 모드에서 auto-approve 안 됨. `.claude/` 쓰기 프롬프트는 "Yes, and allow Claude to edit its own settings for this session" 옵션 제공(= allow-always-scoped 예).
- permission dialog 안에서 `Left/Right arrows`로 tab 이동.

**Codex approval modes**(출처: Codex IDE / IDE features):

- "Chat"(계획만), "Agent"(working dir 내 자동, 외부/네트워크는 승인 필요), "Agent (Full Access)"(무승인). approval mode = 언제 물을지, sandbox mode = 무엇을 읽/쓸지(출처: Codex IDE).

**Zed**(출처: Zed Agent Panel): Tool Permissions가 호출을 "allowed, denied, or confirmed"로 제어.

### 8.2 CLCOMX 매핑

- doc 04 `ApprovalRequest`/`ApprovalOption`이 ACP와 **정합**:
  - `ApprovalOption.kind`: `allow_once|allow_always|reject_once|reject_always|cancel|other` ⊇ ACP `allow_once|allow_always|reject_once|reject_always`. `cancel`/`other`는 CLCOMX 확장.
  - `ApprovalDecision`: `outcome: selected|cancelled|failed` + `optionId`. ACP `selected(optionId)`/`cancelled`와 정합.
- **핵심 불변식**(doc 08/09 이미 명시, 재확인):
  - provider가 보낸 `options`를 **그대로** 보존·표시한다. 표시하지 않은 option을 임의 선택하지 않는다(doc 09).
  - label은 i18n key로 감싸되(`agentRuntime.approval.*`), `optionId`/`kind`는 원본 유지(doc 06/08).
  - turn cancel / session shutdown / process exit 시 pending approval을 `cancelled`(또는 `failed`)로 닫고 provider에 명시 응답(doc 04/05/06/09). ACP "cancelled overrides pending permission requests"와 정합.
- approval card vs modal: ACP request는 `toolCall`을 포함하므로, **해당 tool card 인라인 승인**(Claude inline prompt 스타일)과 **blocking modal**(전체 화면 차단) 중 선택 가능. doc 08은 둘 다 허용("approval card/modal"). 권장:
  - 단일 tool 승인 → 해당 tool card 하단 인라인 option 버튼(§7 "approval은 항상 view로 스크롤" 적용).
  - destructive/높은 권한(escalation, sandbox 우회) → modal(doc 08 modal escape 회귀 보호).
- 진행 중 표시: tool call `status: pending`(승인 대기)와 `in_progress`(실행 중)를 시각적으로 구분. session status `requires_action`(doc 04)로 탭/세션 badge 갱신.
- **자동 허용(allow_always)은 doc 09 정책상 audit trail 준비 전까지 도입 안 함.** ACP `allow_always`/Claude `acceptEdits`/Codex Full Access 같은 "기억하는 승인"은 UI에 옵션이 와도 CLCOMX 저장은 별도 설정+감사 경계가 갖춰진 뒤 활성화(doc 09).
- 모드 표시: Codex permission profile/sandbox mode, Claude permission mode를 session metadata로 표시(doc 09 Sandbox 절). 모드 전환 UI(Shift+Tab 순환 등)는 provider가 노출하는 범위에서만 — **provider 의존**.

---

## 9. Composer(입력창) 패턴

### 9.1 확인된 패턴

**Zed**(출처: Zed Agent Panel):

- multiline: `shift-alt-escape`로 editor 확장.
- `@`-mention: files, directories, symbols, previous threads, skills, diagnostics, branch diffs, URLs(fetch). 멀티라인 코드 붙여넣기는 자동으로 @-mention 포맷, `cmd-shift-v`로 raw paste.
- image: 파일시스템에서 drag, 또는 copy-paste.
- selection: `cmd->` 또는 `agent: add selection to thread`.
- stop: "stop button"으로 생성 중단.

**Claude Code**(출처: Claude Code interactive):

- multiline: `\`+`Enter`(모든 터미널), `Option+Enter`(macOS, Option-as-Meta), `Shift+Enter`(iTerm2/WezTerm/Ghostty/Kitty/Warp/Apple Terminal/Windows Terminal), `Ctrl+J`(무설정), paste mode.
- image paste: `Ctrl+V`/`Cmd+V`(iTerm2)/`Alt+V`(WSL) → 커서 위치에 `[Image #N]` chip 삽입(위치 참조 가능).
- `@`: file path mention 자동완성. `/`: command/skill. `!`: shell mode.
- 중단: `Esc`(현재 응답/tool call 중단, 작업물 유지), `Esc Esc`(입력 비우기 또는 rewind), `Ctrl+C`(중단 또는 입력 clear).
- model 전환(`Option+P`), extended thinking 토글(`Option+T`), 모드 순환(`Shift+Tab`).
- prompt suggestion: 첫 진입 시 git history 기반 grayed 예시, `Tab`/`Right`로 채택.

**Codex IDE**(출처: Codex IDE features): image drag-and-drop(VS Code는 Shift hold), `@example.tsx` file 참조, model switcher(chat input 아래), reasoning effort(low/medium/high).

### 9.2 CLCOMX 매핑

doc 08 Composer 절을 다음으로 구체화:

- **multiline 입력**: CLCOMX는 Tauri WebView이므로 터미널 키 제약이 없다. `Shift+Enter`=개행, `Enter`=전송을 기본으로(웹 관례). `Enter`=전송 / `Cmd/Ctrl+Enter`=전송 등 정책은 기존 CLCOMX 컨벤션에 맞춤 — **CLCOMX 결정 필요**.
- **image 첨부**: doc 08 "image paste attachment". paste/drag 모두 지원. ACP는 `image` prompt capability + base64 `data` 필요(§3) → adapter가 capability 확인 후에만 활성화(doc 06 "image: capability 확인 후 활성화"). Claude `[Image #N]` chip처럼 **위치 참조형 chip** 권장.
- **file/resource mention**: doc 08 "file/resource mention". `@`-mention(Zed/Claude/Codex 공통 관례) 채택 권장. ACP wire는 absolute path/file URI로 정규화(doc 06 "상대 경로는 표시용, wire는 absolute"). mention 대상은 provider capability(`promptCapabilities.embeddedContext` 등)와 일치시킴.
- **send/cancel/중단**: doc 08 "send/cancel button". 생성 중이면 send 버튼을 **stop 버튼으로 전환**(Zed/Claude 패턴). stop → ACP `session/cancel`(doc 06)/Codex turn cancel(doc 05). doc 04 "turn cancel 시 pending approval cancelled" 불변식 적용.
- **active runtime/provider indicator**: doc 08 "active runtime/provider indicator". provider/model/permission-mode를 composer 근처에 표시(Zed의 profile/token near-composer, Codex model switcher 패턴). i18n `agentRuntime.status.*`.
- approval active 동안 composer 상태: doc 08 명시대로 입력 가능 여부/cancel behavior를 명확히. ACP는 permission 응답 전 turn이 멈춰 있으므로, composer는 "승인 대기 중" 상태 표시 + cancel만 허용 권장 — **권장**.

---

## 10. Session 초기화/복원이 UI에 주는 영향

### 10.1 확인된 패턴 (ACP, 출처: ACP session-setup)

- `initialize`: protocol version 협상 + capability 교환. client는 `clientCapabilities`(예: `fs`, `terminal`), agent는 `agentCapabilities`(`loadSession`, `sessionCapabilities.resume`/`close`/`additionalDirectories`, `mcpCapabilities.http`/`sse`), `promptCapabilities`(image/audio/embeddedContext).
- `session/new`: `cwd`(absolute) + `mcpServers`. `sessionId` 반환.
- `session/load`(capability `loadSession` 필요): agent가 **전체 대화를 `session/update` notification으로 replay**한 뒤 원 요청에 응답. replay update는 `user_message_chunk`/`agent_message_chunk` 등 + `messageId` 포함.
- `session/resume`(capability `sessionCapabilities.resume`): **history replay 안 함**. context/MCP 재연결만.

### 10.2 CLCOMX 매핑

- doc 06 mapping(`session/new→session_started`, `session/load replay→transcript 재구성`)과 정합. UI 함의:
  - `session/load` 진행 중에는 transcript에 "복원 중" 상태 + replay event를 순서대로 누적(doc 04 순서 보존). replay 완료 전까지 composer를 잠그거나 로딩 표시 — **권장**.
  - `session/resume`는 replay가 없으므로, CLCOMX가 자체 저장한 transcript(doc 10 persistence)를 그대로 표시하고 context만 재연결. doc 10과 연계.
  - capability에 따라 composer 기능(image/audio/mention)을 동적 enable/disable(doc 06 "ACP capability에 맞춰 content type 제한"). doc 08 composer는 capability 기반 feature gating 적용 — **권장**.

---

## 11. doc 08 보강 제안 요약 (다운스트림 구현용 체크리스트)

아래는 본 조사 결과를 doc 08-ui-composition에 반영할 구체 항목이다. (확인=출처 있음, 권장=조사 기반 제안, 결정필요=CLCOMX 정책 미정)

| # | 항목 | 근거 | 분류 |
|---|---|---|---|
| 1 | transcript = sticky-bottom composer + 그 위 scrollable·가상화 영역 | Claude fullscreen | 권장 |
| 2 | tool call + result를 한 쌍으로 collapse/expand, 더 보여줄 게 있는 카드만 토글 | Claude fullscreen | 권장 |
| 3 | kind별 카드 표현 표(§2.2) 채택 | ACP tool-calls + doc 04 | 확인(kind/status 정합) |
| 4 | diff card: oldText/newText 또는 patch, hunk accept/reject는 provider 승인 흐름 있을 때만 | ACP diff content, Zed review, doc 09 | 권장 |
| 5 | terminal embed: 고정높이+resize, live append, release 후 유지, truncated 표시 + 전체로그 열기 | ACP terminals, doc 05 | 확인 |
| 6 | plan card는 replace-only, status/priority 아이콘, 접기+더보기 | ACP agent-plan, Claude task list | 확인(replace 규칙) |
| 7 | reasoning(자유텍스트 collapsible)과 plan(구조화 replace)을 분리 | ACP thought vs plan | 권장 |
| 8 | approval: 단일 tool 인라인 / escalation modal, options 원본 보존, label만 i18n | ACP request_permission, doc 09 | 확인(불변식) |
| 9 | approval card는 auto-scroll 설정과 무관하게 항상 view로 | Claude fullscreen | 확인 |
| 10 | auto-follow + 위로 스크롤 시 정지 + 명시적 재개 | Claude fullscreen | 권장 |
| 11 | composer: @-mention, image chip, send↔stop 전환, provider/model/mode indicator | Zed/Claude/Codex | 권장 |
| 12 | capability 기반 composer feature gating(image/audio/mention) | ACP session-setup/content | 권장 |
| 13 | turn status badge + context 사용량 게이지(used/size) + turn 토큰 | ACP usage_update, Codex TokenUsage, Zed | 권장 / 결정필요(doc 04 필드 추가) |
| 14 | StopReason(refusal/max_tokens 등)을 error/retry notice로 표시, 원본 보존 | ACP prompt-turn, doc 04 | 권장 |
| 15 | session/load replay 중 로딩 상태 + 순서 누적, resume은 저장본 표시 | ACP session-setup, doc 06/10 | 확인 |
| 16 | collapsible 요소 키보드 토글 + ARIA expanded, 폰트/locale 설정 분리 | Codex settings + 접근성 일반 | 권장 |

---

## 12. 미해결/재확인 필요 (open questions)

1. **doc 04 `TokenUsage` vs ACP `usage_update`** — context gauge(`used`/`size`/`cost`)를 표현하려면 doc 04에 필드 추가가 필요한가? 현재 `TokenUsage`는 Codex 축(input/output/cached/reasoning)만 있다. (결정필요)
2. **`agent_thought_chunk` / `user_message_chunk` 정확한 discriminator** — fetch 요약에서 누락. `schema/v1`(`schema-v1.16.0`) JSON Schema로 확정 필요(doc 01 재확인 체크).
3. **ACP diff content 필드(`oldText`/`newText`) vs doc 04 `diff`(`patch`)** — adapter에서 patch 변환 규칙 확정 필요.
4. **`audio` content** — v1 미지원 결정 시 강등/표시 정책 확정(§3.2).
5. **send/개행 키 바인딩** — Enter=전송 vs Shift+Enter=전송. 기존 CLCOMX UX 컨벤션과 통일 필요(§9.2).
6. **session/thread 목록 UI** — Zed식 sidebar/switcher를 도입할지, 기존 CLCOMX 탭 모델에 turn status badge만 얹을지(§6.2).
7. **claude-agent-acp 버전** — 로컬 npm latest는 0.51.0, doc 01은 0.50.0. ACP schema(`schema-v1.16.0`)와 호환 protocol version을 어댑터 의존성 고정 시 재확인(doc 01).
