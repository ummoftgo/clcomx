# ADR-002: Long-session transcript 메모리 모델

> 이 ADR은 direct agent runtime(ADR-001)의 **frontend transcript view-model**이 긴 세션에서 unbounded로 증가하는 문제를 막기 위한 메모리 모델(shallow 반응형 표면 + sealed-turn 윈도우 eviction + 3-상태 turn residency + 격리 replay-reload)을 도입하는 결정을 기록한다. transcript view-model 타입은 재기술하지 않고 [`08-ui-composition.md`](08-ui-composition.md) §5를, 규칙(seal 불변식·seal 조건·3-상태·late-event)은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md) §3.7을, persistence 경계는 [`10-persistence-migration.md`](10-persistence-migration.md)를, 미확정/위험은 [`13-risks-open-questions.md`](13-risks-open-questions.md)(§1.12, OQ-52~54)로 연결한다. 도메인 타입 정본은 여전히 [`15-data-contracts.md`](15-data-contracts.md)다.

## Status

Accepted

확정 시점: 2026-06-26 (Claude↔Codex 토론 합의). ADR-001(direct agent runtime 도입)을 전제하며, 본 ADR은 그 frontend transcript 표면에만 적용된다. backend(07)·persistence(10)는 무변경이다.

---

## Context

### 자연 bounded였던 것이 사라진다 (검증됨)

기존 PTY/xterm runtime에서 transcript는 xterm.js의 **scrollback cap**으로 자연스럽게 bounded였다. 긴 세션이라도 화면 버퍼는 고정 라인 수를 넘지 않고, 그보다 오래된 출력은 xterm 내부에서 자동 폐기된다(`02-current-state.md` §5). 즉 메모리 상한이 terminal emulator 안에 내장돼 있었다.

direct agent runtime은 이 모델을 버린다. PTY byte stream 대신 **id가 붙은 구조화 DOM transcript**(message·tool call·approval·diff·plan·command output — 15 §3~§5)를 쌓고, 그 전체를 frontend in-memory view-model(`AgentRuntimeViewState`/`TranscriptItem`, 08 §5)에 보관한다. xterm의 scrollback cap에 해당하는 자동 상한이 더 이상 없으므로, 긴 세션에서 transcript 모델은 **unbounded로 증가**한다.

### DOM 가상화는 DOM만 bounded한다 (검증됨)

`MessageList.svelte`는 가상화(visible item만 mount)로 DOM 노드 수를 bounded한다(08 §7.2, ux-reference §1.1·§7.1). 그러나 가상화는 **item 레벨 DOM의 mount/unmount**일 뿐이고, 그 경계는 08 §7.2가 명시하듯 surface unmount 금지(10 §4.3)·반응형 store와 **별개 축**이다. unmount된 item이라도 그 데이터는 `AgentRuntimeViewState.transcript`(08 §5) 배열·반응형 store에 그대로 살아 있어야 seq 재구성 없이 안전하게 다시 mount된다(08 §7.2 주). 결과적으로:

- **DOM 노드 수**: 가상화로 bounded.
- **반응형 in-memory 모델(heap + 반응성 오버헤드)**: 미bounded — 세션 길이에 비례해 증가한다.

DOM 가상화(OQ-17)는 이 문제를 풀지 못한다. surface가 살아 있어도 heap을 줄여야 하므로, 본 ADR의 관심사는 가상화와 **직교**한다.

### 라이브 중 in-memory가 유일 사본이다 (검증됨)

persistence는 "replay 우선, full cache는 후속"을 불변식으로 둔다(10 §1 불변식 4: 1차 범위는 재개·복원용 metadata만 저장, transcript 복원은 provider replay에 의존). 즉 **transcript full cache는 1차 범위에서 제외**다(13 Resolved defaults). 그 결과 라이브 세션이 도는 동안 transcript 본문의 유일한 사본은 frontend in-memory view-model이다 — 디스크에도, backend replay log(07 §7.2 diagnostic-only bounded log)에도 사용자-visible 사본이 없다.

이것이 두 가지를 동시에 강제한다.

1. in-memory 모델을 함부로 버리면 사용자가 그 transcript를 **다시 볼 수단이 없다**(라이브 중 영속 사본 부재). 따라서 eviction은 "무엇을 잃는지"를 명시적으로 다뤄야 한다.
2. 그럼에도 무한히 들고 있으면 긴 세션에서 heap·반응성이 모두 무너진다.

### 합의된 view-model·규칙 정본 (이 ADR이 전제하는 정본)

본 ADR이 도입하는 메모리 모델의 타입·규칙은 다른 곳에 정본이 있다. 본 ADR은 그것을 **채택하는 결정의 근거와 대안 기각 사유**만 기록한다.

- transcript view-model 타입(`TranscriptItem`/`AgentRuntimeViewState`/`TranscriptModel`/`TranscriptTurnResidency`)과 메모리 표면 형상의 정본은 [`08-ui-composition.md`](08-ui-composition.md) §5다(이 타입군은 15가 아니라 08 §5가 권위 — 15 §1~§5는 도메인 타입만, view-model은 08 §5).
- seal 불변식·seal 조건·3-상태 turn residency·late-event 규칙의 정본은 [`04-normalized-agent-model.md`](04-normalized-agent-model.md) §3.7이다. reducer 시그니처(`applyEvent(prev: TranscriptModel, event: AgentEvent): TranscriptModel`)와 그 순수성도 여기에 묶인다.
- 격리 replay-reload의 persistence 경계(디스크 미사용·full cache 아님·live 미병합)는 [`10-persistence-migration.md`](10-persistence-migration.md) §4.7(runtime scrollback replay)이며, §4.2 cold restore와 구분된다.

---

## Decision

CLCOMX는 direct runtime의 frontend transcript에 대해 **반응성과 heap을 둘 다 세션 길이와 무관하게 bounded로 만드는 메모리 모델**을 도입한다. 이 모델은 **frontend 전용**이고, backend(07)·persistence(10)의 wire/저장 계약을 변경하지 않는다. 핵심 4가지는 다음과 같다.

### D1. shallow 반응형 표면 — 반응성을 세션 길이와 무관하게 bounded

반응형 상태($state)는 transcript 본문 전체가 아니라 **얇은 표면**만 둔다: `visibleItemIds`(현재 보이는/활성 item id 목록)·`itemVersions`(item별 버전 카운터)·`status`·`pending`(approval/request 파생). transcript item **body**는 반응형이 아니라 plain `Map`(`itemsById`)에 둔다. streaming(`agent_message_delta`/`command_output_delta` 등 고빈도 event)은 body를 갱신하고 해당 item의 `itemVersion`만 bump한다 — 컴포넌트는 version 변화로만 재렌더한다.

→ 반응형 그래프가 추적하는 셀 수가 "보이는/활성 item + 버전 카운터"로 묶이므로, **반응성 오버헤드가 세션 길이와 무관하게 bounded**가 된다. body는 plain 객체라 Svelte 반응형 proxy 비용을 지지 않는다. 모델 형상·필드 정본은 08 §5(`TranscriptModel`).

### D2. sealed-turn 윈도우 eviction — heap을 bounded

메모리 윈도우 = **최근 N개 sealed turn** + 모든 unsealed/active turn(인터리빙된 turn 포함) + 현재 streaming turn. cap(N) 초과 시 **가장 오래된 sealed turn의 body를 evict**한다. active/unsealed turn은 절대 evict하지 않으므로 진행 중 대화의 정확성이 보장된다.

→ 라이브 윈도우가 항상 "최근 sealed N개 + 진행 중 전부"로 한정되므로 **heap이 bounded**가 된다. 윈도우/cap의 구체 수치는 미실측이라 OQ-52로 둔다(image cap은 OQ-12 연동). 무거운 item(diff/이미지/대용량 출력)은 bounded 표현 + 지연 로드로 별도 완화한다(13 §1.8 ring/요약; image는 OQ-12 연동).

### D3. 3-상태 turn residency — silent corruption 방지

각 turn은 `TranscriptTurnResidency`(08 §5 정의) = `"unsealed" | "sealed-retained" | "evicted-tombstone"`의 한 상태를 가진다. 규칙 정본은 04 §3.7.

- **`unsealed`**: 도착하는 모든 event를 apply한다(정상 누적).
- **`sealed-retained`**: body는 유지하되 turn은 "닫힘"으로 본다. 늦은 same-turn event가 오면 **unseal → patch → reseal** 하고 telemetry를 남긴다(silent drop 아님).
- **`evicted-tombstone`**: body가 없다. 늦은 event는 **apply하지 않고**(body가 없어 apply 불가) `droppedLateEventCount`만 증가시킨다. tombstone 자체는 작은 LRU/TTL로 bounded(`tombstones = LRU<turnId> + droppedLateEventCount`, 08 §5).

→ "닫힌/버린 turn에 늦은 event가 와서 조용히 어긋나는" silent corruption을 막는다. retained 구간은 patch+telemetry로 보정, tombstone 구간은 drop을 카운트로 가시화한다.

**seal 조건**(04 §3.7 정본): 종료 신호(Codex `turn/completed` · ACP `stopReason`) + open item 0 + pending approval/request 0 + turn-level 슬롯(usage/plan/diff) 반영 + 짧은 quiescence grace를 모두 만족할 때만 turn을 seal한다. quiescence grace가 필요한 이유는 `turn/completed` 직후 same-turn 보조 notification이 도착할 수 있는지가 미확정이기 때문이다(OQ-53 — 구현 직전 wire 실측).

### D4. 격리 replay-reload — tombstone 구간의 read-only history inspection

tombstone 구간을 스크롤백하면 그 자리에 "이전 기록 불러오기" notice를 둔다. 사용자가 요청하고 metadata가 `canLoad`이면, **read-only 격리 scratch replay 세션**(ACP `session/load` · Codex `thread/read`)으로 과거 구간을 조회한다. 이 scratch 세션은 **live store에 병합하지 않는다** — 조회 후 폐기한다. `canLoad`가 아니면 "사용 불가" notice를 표시한다.

→ 이것은 복원(cold restore)도 영속 캐시도 아닌 **read-only history inspection**이다. live transcript에 다시 끼워 넣지 않으므로 진행 중 turn·라우팅·반응형 표면과 충돌하지 않는다. persistence 경계 정본은 10 §4.7(runtime scrollback replay; 디스크 미사용·full cache 아님·live 미병합)이며 §4.2 cold restore와 구분된다. Codex `thread/read includeTurns`가 gap-only인지 전체 snapshot인지는 격리 replay 범위에 직결되므로 OQ-54로 둔다.

### 명명·범위 제약

- 이 메커니즘은 **"turn residency / memory residency"**로 부른다 — protocol "item lifecycle"(15/04의 도메인 상태 전이)과 구분하기 위해서다.
- DOM 가상화(OQ-17)와 **별개**다: surface가 살아 있어도(unmount 안 해도) heap이 줄어든다(반응형 표면이 얇고 body가 evict되므로).
- cold·tombstone 상태는 **runtime-only**이고 영속되지 않는다 — 디스크/metadata에 기록하지 않는다(10 무변경).

---

## Alternatives considered

대안마다 "무엇을 했을 것인가 → 왜 기각했는가"를 기록한다. 채택안은 토론에서 A를 정련한 결과다.

### A. 2-tier 반응형/비반응형 분리 (전면 freeze + drop)

- **내용**: transcript를 hot tier(반응형)와 cold tier(비반응형, freeze)로 나누고, cold tier item은 반응형 그래프에서 빼서(freeze) 메모리를 줄인다. 오래된 item은 통째로 drop한다.
- **기각 사유**:
  1. item을 통째로 freeze/drop하면, 늦게 도착하는 same-turn event를 안전하게 흡수할 경로가 사라진다 — frozen item에 patch가 와도 반영 수단이 없어 silent corruption 위험이 생긴다.
  2. tier 경계를 item 단위로 그으면 turn 인터리빙(한 turn의 item들이 다른 turn 사이에 섞여 도착, 04 §1)에서 같은 turn이 hot/cold로 쪼개져 seal 판단·patch 판단이 불안정해진다.
  3. cold tier의 "freeze"가 반응성만 끄고 body는 들고 있으면 heap은 여전히 unbounded다 — 문제의 절반밖에 못 푼다.
  → **폐기**. Codex 토론에서 freeze/drop의 위험(silent corruption·tier 경계 불안정)을 제거하고, 채택안(shallow 반응형 + bounded id-index)으로 정련했다.

### B. disk-spill cold cache (오래된 transcript를 디스크로 내려 캐싱)

- **내용**: 윈도우를 벗어난 transcript를 디스크에 spill해서 영속 캐시로 두고, 필요 시 디스크에서 되읽는다.
- **기각 사유**:
  1. 이는 사실상 **transcript full cache**다. 그러나 "replay 우선, full transcript cache는 후속"이 persistence 불변식이다(10 §1 불변식 4, 13 Resolved defaults). disk-spill cold cache는 그 "full cache 후속" 결정과 정면 충돌한다.
  2. 디스크 spill을 도입하면 scrub 경계(15 §7.3, 10 §6)·retention·포맷을 새로 정의해야 하고, 1차 범위(metadata-only)를 넘어선다.
  → **보류**. full transcript cache가 후속 단계로 결정되면 그때 함께 검토한다. v1은 디스크를 건드리지 않는다.

### C. hot 윈도우만 유지 + 나머지는 항상 on-demand replay

- **내용**: 메모리에는 hot 윈도우만 두고, 그 밖의 모든 과거 구간은 보일 때마다 provider replay로 즉석 재구성한다.
- **기각 사유**:
  1. provider replay 단위가 coarse하다(turn/thread 단위 — ACP `session/load`, Codex `thread/read`; 범위는 OQ-54 미확정). 스크롤할 때마다 coarse replay를 돌리면 UX가 최악이 된다(지연·점프·중복).
  2. replay를 live store에 병합하려 들면 진행 중 turn·라우팅과 충돌한다(채택안 D4가 격리 scratch로 분리한 이유와 동일한 위험).
  → **보류**. 채택안은 replay를 "tombstone 구간의 read-only 격리 조회"로만 제한해(D4) coarse replay를 상시 경로가 아니라 명시적 inspection 경로로 둔다.

### 채택안 = shallow 반응형 표면 + bounded id-index Map

채택안은 A의 의도(반응성 비용을 줄인다)를 살리되 freeze/drop 위험을 제거한다. body를 freeze하는 대신 **반응형 표면을 얇게**(D1) 만들고(body는 plain Map), item을 통째로 drop하는 대신 **sealed-turn 윈도우로 evict**(D2)하며, 닫힌/버린 turn은 **3-상태 residency**(D3)로 늦은 event를 명시 처리하고, 잃은 구간은 **격리 replay-reload**(D4)로 read-only 조회한다.

---

## Consequences

### Positive

- **반응성 bounded**(D1): 반응형 표면이 `visibleItemIds`/`itemVersions`/`status`/`pending`으로 한정되므로 반응성 오버헤드가 세션 길이와 무관하다. 고빈도 streaming은 body 갱신 + version bump로 흡수된다.
- **heap bounded**(D2): 라이브 윈도우가 "최근 sealed N개 + 진행 중 전부"로 한정되어 긴 세션에서도 heap이 상한을 갖는다.
- **silent corruption 방지**(D3): seal 불변식(04 §3.7)과 3-상태 residency로, 닫힌/버린 turn에 늦은 event가 와도 조용히 어긋나지 않는다(retained=unseal/patch/reseal+telemetry, tombstone=drop count).
- **read-only history는 유지**(D4): tombstone 구간도 deferred replay-consumer의 **read-only history 부분만** v1에 도입해, 과거 구간을 격리 조회할 수 있다. live와 분리돼 진행 중 대화와 충돌하지 않는다.
- DOM 가상화(OQ-17)와 **직교**하므로, surface unmount 금지(10 §4.3) 등 기존 경계를 건드리지 않고 heap을 줄인다.

### Negative

- reducer가 단순 누적이 아니라 **TranscriptModel + 3-state eviction**을 다뤄야 해 복잡해진다(`applyEvent(prev, event): TranscriptModel`, 04 §3.7 규칙 구현; 12 T1.1).
- seal 판정(종료 신호 + open item 0 + pending 0 + turn-level 슬롯 + quiescence grace)이 추가 상태를 요구하고, grace 타이밍이 잘못되면 조기/지연 seal이 발생할 수 있다(OQ-53 wire 실측 전까지 보수적 grace).
- 격리 replay 뷰(scratch 세션 생성·폐기·live 미병합·running 충돌 회피)가 별도 컴포넌트로 추가된다(12 T5.6, Phase 5).
- 윈도우/cap 수치가 미실측이라(OQ-52) 초기 값은 보수적으로 두고 실측 후 조정해야 한다.

### Risks (→ 13으로 연결)

- **Long-session transcript memory (S2)**: 본 ADR이 막으려는 위험 자체의 레지스트리 항목. 윈도우/cap·seal·tombstone·격리 replay의 미실측 변수가 여기 모인다. → 13 §1.12.
- **윈도우/cap 수치 미실측**: 너무 작으면 사용자가 자주 tombstone에 부딪히고, 너무 크면 heap이 다시 커진다. image cap은 OQ-12 연동. → 13 OQ-52.
- **same-turn 늦은 notification 도착 여부**: `turn/completed`(Codex)·`stopReason`(ACP) 이후 same-turn 보조 notification이 오는지에 따라 seal grace가 정해진다. 구현 직전 wire 실측 필요. → 13 OQ-53. late same-turn fixture는 **reducer/store event fixture**로 검증하고(adapter fixture 아님), 실제 wire 확인은 OQ-53로 둔다(11).
- **격리 replay 범위 불확실**: Codex `thread/read includeTurns`가 gap-only인지 전체 snapshot인지에 따라 격리 replay가 조회하는 범위가 달라진다. → 13 OQ-54.

---

## 교차 참조

| 대상 | 문서 | 절 |
|---|---|---|
| seal 불변식·seal 조건·3-상태·late-event 규칙 정본 | [`04-normalized-agent-model.md`](04-normalized-agent-model.md) | §3.7 |
| transcript view-model 타입 정본(`TranscriptModel`/`TranscriptItem`/`AgentRuntimeViewState`/`TranscriptTurnResidency`) | [`08-ui-composition.md`](08-ui-composition.md) | §5 |
| DOM 가상화(별개 축) | [`08-ui-composition.md`](08-ui-composition.md) | §7.2 |
| runtime scrollback replay(read-only, live 미병합) | [`10-persistence-migration.md`](10-persistence-migration.md) | §4.7 (§1 replay 우선 불변식, §4.2 cold restore와 구분) |
| 도메인 타입 정본 | [`15-data-contracts.md`](15-data-contracts.md) | §1~§5 |
| 위험·OQ | [`13-risks-open-questions.md`](13-risks-open-questions.md) | §1.12, OQ-52~54, §1.8(무거운 item) |
| reducer/store fixture·수용 | [`11-testing-acceptance.md`](11-testing-acceptance.md) | late same-turn event fixture |
| 구현 워크스트림 | [`12-implementation-workstreams.md`](12-implementation-workstreams.md) | T1.1, T1.3, T1.4, T5.6 |
| 용어 | [`16-glossary.md`](16-glossary.md) | turn residency / memory residency |
| 전제 ADR | [`adr-001-direct-agent-runtime.md`](adr-001-direct-agent-runtime.md) | 전체 |
