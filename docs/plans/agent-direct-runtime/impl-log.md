# Direct Agent Runtime — 구현 로그 / 게이트 결정 기록

> 이 문서는 구현 세션의 preflight 결과와 게이트 결정(T0.0/T2.0/H4 및 관련 OQ)을 기록한다. 13의 결정 정본을 인용·구체화하며, 구현 에이전트가 따르는 확정값을 모은다.

확인일: 2026-06-26. 구현 브랜치: `feat/agent-runtime-impl` (기점 `feat/agent-runtime`).

## 2026-07-01 E2E 재검증 — OQ-60 이후 전체 Windows pack

- OQ-60 post-start fatal notice/no-fallback E2E spec이 `agent-runtime` project에 추가된 뒤, direct runtime 변경이 기존 PTY/설정/복원/링크/보조 터미널 pack을 깨지 않는지 전체 Windows E2E pack을 재확인했다.
- GREEN: `npm run test:e2e:wsl -- --skip-build` 통과. 실행 범위는 `smoke`, `settings`, `windows-tabs`, `workspace-restore`, `image-paste`, `agent-runtime`, `terminal-input`, `terminal-links`, `terminal-aux` 9 projects / 29 tests다. `agent-runtime` project는 새 post-start fatal no-fallback spec을 포함해 18 tests로 통과했다. 이 실행은 Windows mirror-local Edge WebDriver와 Tauri debug app을 runner가 관리한 것으로, 별도 수동 앱 launch는 수행하지 않았다.
- 이 검증은 OQ-60 E2E 하한 추가 후 기존 PTY/legacy E2E pack의 현재 회귀 하한을 다시 고정한다. 실제 설치 editor process focus/line reveal(OQ-61), plan 포함 Codex live turn과 Claude ACP live same-turn 후보 캡처(OQ-53), 대용량 세션 운영 튜닝(OQ-52)은 여전히 별도 후속 범위다.

## 2026-07-01 E2E 보강 — OQ-60 post-start fatal notice/no-fallback 하한

- OQ-60은 fresh direct start 실패 fallback과 기동 완료 후 fatal runtime error/exit 처리를 분리해야 한다. 단위 테스트는 post-start `recoverable:false`와 abnormal `process_exited`가 fallback panel/PTY callback으로 승격되지 않는 하한을 갖고 있었지만, 실제 Windows app-boundary E2E에서는 아직 post-start fatal runtime error notice 경로를 직접 덮지 않았다.
- RED: `e2e/agent-runtime/agent-runtime.test.ts`에 `keeps a post-start fatal runtime error on the notice path without fallback` spec을 추가했다. `fatal runtime error please` prompt 이후 transcript notice와 fallback panel 부재를 기대했지만, 기존 test-mode mock은 fatal runtime error를 emit하지 않아 `npm run test:e2e:wsl -- --skip-build --project agent-runtime`가 18개 중 해당 spec timeout으로 실패했다.
- 수정: Codex test-mode mock의 `turn/start` prompt가 `fatal runtime error`를 포함하면 정상 mock 응답 스크립트 처리 후 `agent-runtime-error{recoverable:false, code:"framing_broken"}`를 emit하도록 했다. 이는 start reject/fallback 경로가 아니라 기동 완료 후 runtime error event 경로만 자극한다. Rust RS-19 mock 계약에는 Codex 전용 trigger, Claude 비적용, `thread/start` 비적용 assert를 추가했다.
- GREEN: `cargo test --manifest-path src-tauri/Cargo.toml rs19_mock_jsonrpc_responses_are_valid_and_provider_specific` 통과, 최신 Windows build 포함 `npm run test:e2e:wsl -- --project agent-runtime` 통과(1 file / 18 tests). 수동 앱 launch는 수행하지 않았고, E2E runner가 관리한 Tauri debug app 경계에서만 확인했다. Full provider taxonomy와 post-start recovery UX는 계속 13 OQ-60 후속이다.

## 2026-07-01 E2E 보강 — OQ-53 ACP late candidate raw-debug 검출

- OQ-53의 live Claude ACP wire 실측은 아직 남아 있지만, E2E-10 raw debug analyzer 경계가 ACP `session/prompt` stopReason 이후 `session/update` 후보를 실제 앱 경로에서 잡을 수 있는지는 검증되지 않았다. test-mode Claude mock에 `late update` prompt 전용 delayed `session/update{sessionUpdate:"plan_update"}`를 추가하고, E2E가 opt-in raw debug log를 analyzer로 읽어 ACP late candidate를 검출하도록 보강했다.
- RED: 새 E2E spec `detects an ACP late session/update candidate from raw protocol debug logs`를 추가한 뒤 `npm run test:e2e:wsl -- --skip-build --project agent-runtime`가 17개 중 해당 1개만 timeout으로 실패했다. 첫 GREEN 시도에서도 최신 build 기준 timeout이 반복됐고, 실패 raw log를 확인하니 `session/prompt` outbound log가 stopReason response 뒤에 기록되고, delayed update는 fixture-local `s-mock` sessionId를 써서 analyzer의 same-session 판정에 걸리지 않았다.
- 원인 수정: `write_message_with_values`는 mock writer가 newline 수신 즉시 inbound를 emit하기 전에 outbound raw debug log를 기록하도록 순서를 조정했다. Claude test-mode prompt mock은 `session/update`와 delayed `plan_update`에 실제 outbound `params.sessionId`를 사용한다. 이는 live provider 실측을 대체하지 않고, raw debug log의 logical send/receive ordering과 routing key를 E2E에서도 재현 가능하게 만드는 진단 경계 보강이다.
- GREEN: `cargo test --manifest-path src-tauri/Cargo.toml rs19_mock_jsonrpc_responses_are_valid_and_provider_specific` 통과, `cargo test --manifest-path src-tauri/Cargo.toml e2e10_outbound_protocol_debug_log_is_opt_in_and_redacted` 통과, `npm run test -- src/lib/features/agent-runtime/service/debug-log-analyzer.test.ts` 통과(3 tests), 최신 Windows build 포함 `npm run test:e2e:wsl -- --project agent-runtime` 통과(1 file / 17 tests). 통과 raw log ordering은 `session/prompt` out(sessionId `sess-1`) → `session/update:agent_message_chunk` seq 3 → stopReason response seq 4 → delayed `session/update:plan_update` seq 5다. 수동 앱 launch와 live Claude provider turn 생성은 수행하지 않았다.

## 2026-06-30 E2E 재검증 — 전체 Windows pack

- 사용자 지시에 맞춰 수동 앱 launch는 하지 않고 E2E runner 경유로만 검증했다. 직전 `agent-runtime` 단독 E2E 이후, direct runtime 변경이 legacy PTY/설정/복원/링크/보조 터미널 pack을 깨지 않는지 확인하기 위해 전체 Windows E2E pack을 순차 실행했다.
- GREEN: `npm run test:e2e:wsl -- --skip-build` 통과. 실행 범위는 `smoke`, `settings`, `windows-tabs`, `workspace-restore`, `image-paste`, `agent-runtime`, `terminal-input`, `terminal-links`, `terminal-aux` 9 projects / 27 tests다. 이 실행은 Windows mirror-local Edge WebDriver와 Tauri debug app을 runner가 관리한 것으로, 별도 수동 앱 조작은 수행하지 않았다.
- 이 검증으로 E2E-1..12 및 기존 PTY E2E pack의 현재 하한은 재확인됐다. live provider same-turn notification wire capture(OQ-53), 실제 설치 editor focus/line reveal(OQ-61), 대용량 세션 운영 튜닝(OQ-52)은 여전히 별도 실측 범위다.

## 2026-06-30 실측 — OQ-53 Codex simple turn same-turn 후보 없음

- 앱 수동 launch 없이 `codex app-server --stdio`를 직접 기동하는 stdio probe로 Codex live wire를 1회 캡처했다. probe는 `/tmp/clcomx-oq53-probe`에서 `initialize`→`initialized`→`thread/start`→tool-free `turn/start` prompt를 보내고, raw debug-like JSONL(`/tmp/oq53-codex-raw-debug.jsonl`)과 요약(`/tmp/oq53-codex-summary.json`)을 생성했다. 최초 probe는 `approvalsReviewer:"autoReview"` enum 값이 wire schema와 맞지 않아 실패했고, `auto_review`로 수정한 뒤 GREEN으로 재실행했다.
- GREEN: `node /tmp/oq53_codex_probe.mjs` 통과. 결과는 outbound 4건, inbound 28건, terminal turn 1건, `postCompletionGraceMs=1500`, `lateEvents=[]`다. `thread/tokenUsage/updated`는 inbound `seq=25`, `thread/status/changed`는 `seq=27`, `turn/completed`는 마지막 inbound `seq=28`로 도착했다. 따라서 이 단순 turn에서는 `turn/completed` 뒤 같은 `(threadId,turnId)` 보조 notification 후보가 관측되지 않았다.
- 이 실측은 OQ-53의 하한을 좁힐 뿐 전체 해소는 아니다. 도구 실행·approval·diff·plan이 포함된 Codex turn, Claude ACP `session/prompt` stopReason 뒤 `session/update` 후보, 실제 앱 debug log 경유 capture는 아직 남아 있다. `/tmp` probe raw log는 임시 진단 산출물이며 repository fixture로 커밋하지 않았다. probe 실행 중 `/tmp/.codex`가 trusted project가 아니라는 Codex warning이 stderr에 찍혔지만, wire ordering 판정 자체에는 영향을 주지 않는다.

## 2026-06-30 보강 — OQ-53 terminal marker evidence

- `analyzeRawProtocolDebugLog`의 `lateEvents=[]`만으로는 종료 marker가 실제로 관측된 "no late"인지, 종료 marker를 못 찾아 비어 있는 것인지 구분할 수 없었다. OQ-53 실측 증거로 쓰려면 판정 전제인 Codex `turn/completed` / ACP `session/prompt` stopReason response marker 자체를 분석 결과에 노출해야 한다.
- `analyzeRawProtocolDebugLog`가 `terminalMarkers[]`를 반환하게 했다. Codex는 `turn/completed`의 실제 envelope(`params.threadId` + `params.turn.id`)을, ACP는 outbound `session/prompt` id와 inbound stopReason response를 연결한 session/request key를 marker로 남긴다. 기존 `lateEvents[]` 판정은 그대로 유지한다.
- RED: `debug-log-analyzer.test.ts`에 Codex/ACP terminal marker 기대값을 추가하자 `terminalMarkers`가 `undefined`라 실패했다. GREEN: 같은 targeted test 통과(3 tests). 추가로 `e2e/agent-runtime/agent-runtime.test.ts` E2E-10 raw debug spec이 analyzer를 직접 호출해 일반 Codex prompt와 approval mock turn의 terminal marker(`turn-mock-1`, `turn-mock-2`)를 확인하고 `lateEvents=[]`를 assert하도록 보강했다. 검증: `npm run test:e2e -- --project agent-runtime --reporter=dot`는 WSL import/transform OK(16 skipped), `npm run test:e2e:wsl -- --skip-build --project agent-runtime` 통과(1 file / 16 tests). 수동 앱 launch는 수행하지 않았다.

## 2026-06-30 실측 — OQ-53 Codex tool-bearing turn same-turn 후보 없음

- 앱 수동 launch 없이 `codex app-server --stdio`를 직접 기동하는 별도 stdio probe로 Codex live tool-bearing turn을 1회 캡처했다. probe cwd는 `/tmp/clcomx-oq53-tool-probe`이고, prompt는 `seed.txt`를 읽고 `oq53-output.txt`에 `OQ53_TOOL_OK`를 쓰는 shell command를 요청했다. raw log는 `/tmp/oq53-codex-tool-raw-debug.jsonl`, summary는 `/tmp/oq53-codex-tool-summary.json`에 남겼다.
- GREEN: `node /tmp/oq53_codex_tool_probe.mjs` 통과. 결과는 inbound 33건, outbound 4건, terminal turn 1건, commandExecution item 2건(`item/started` seq 19, `item/completed` seq 20), `thread/tokenUsage/updated` seq 21/30, `thread/status/changed` seq 32, `turn/completed` seq 33, `lateEvents=[]`, `postCompletionGraceMs=2000`, output file content `OQ53_TOOL_OK`다. 따라서 이 tool-bearing shell command turn에서는 `turn/completed` 뒤 같은 `(threadId,turnId)` 보조 notification 후보가 관측되지 않았다.
- 단, 이 probe에서는 `item/commandExecution/requestApproval` 같은 server request가 발생하지 않았다(`serverRequests=0`). 따라서 당시에는 "도구 실행 포함 Codex turn" 하한만 좁혔고, approval request가 실제로 오가는 live turn, diff/plan 포함 turn, Claude ACP `session/prompt` stopReason 뒤 `session/update` 후보를 OQ-53 잔여로 남겼다. `npx --no-install tsx`로 raw log를 repo analyzer에 직접 먹이는 일회성 확인은 이 환경에서 멈춰 중단했고, 로컬 `node_modules/.bin/tsx`는 없어 실행하지 못했다. 대신 probe 자체의 raw-order 요약, analyzer 단위 테스트, E2E-10 analyzer 연결 검증을 근거로 남긴다.

## 2026-07-01 실측 — OQ-53 Codex approval request turn same-turn 후보 없음

- 앱 수동 launch 없이 `codex app-server --stdio`를 직접 기동하는 stdio probe로 Codex live approval request turn을 1회 캡처했다. probe cwd는 `/tmp/clcomx-oq53-approval-probe`이고, `thread/start`는 `sandbox:"read-only"`, `turn/start`는 `sandboxPolicy:{type:"readOnly",networkAccess:false}`와 `approvalPolicy:"on-request"`를 사용했다. prompt는 read-only sandbox에서 `oq53-approval-output.txt` 생성을 요청해 command approval을 유도했다. raw log는 `/tmp/oq53-codex-approval-raw-debug.jsonl`, summary는 `/tmp/oq53-codex-approval-summary.json`에 남겼다.
- GREEN: `node /tmp/oq53_codex_approval_probe.mjs` 통과. 결과는 inbound 37건, outbound 5건, terminal turn 1건, server request 1건, approval response 1건, commandExecution item 2건, `lateEvents=[]`, `postCompletionGraceMs=2500`, output file content `OQ53_APPROVAL_OK`다. ordering은 `item/started` seq 19 → `item/commandExecution/requestApproval` seq 20(`id=0`) → client `{decision:"accept"}` 응답 → `serverRequest/resolved{requestId:0}` seq 21 → `thread/status/changed` seq 22 → `item/completed` seq 23 → `thread/tokenUsage/updated` seq 24/34 → `thread/status/changed` seq 36 → `turn/completed` seq 37이다.
- 따라서 command approval이 실제로 오가는 Codex live turn에서도 `turn/completed` 뒤 같은 `(threadId,turnId)` 보조 notification 후보는 관측되지 않았다. 다만 이 결과는 Codex command approval 1회 하한이며, 이 시점에는 diff/plan 포함 Codex live turn과 Claude ACP `session/prompt` stopReason 뒤 `session/update` 후보를 OQ-53 잔여로 남겼다.

## 2026-07-01 실측 — OQ-53 Codex fileChange diff turn same-turn 후보 없음

- 앱 수동 launch 없이 `codex app-server --stdio`를 직접 기동하는 stdio probe로 Codex live fileChange/diff turn을 1회 캡처했다. probe cwd는 `/tmp/clcomx-oq53-diff-plan-probe`이고, `target.txt`를 seed한 뒤 workspace-write sandbox에서 provider file editing path(`apply_patch`/fileChange)를 사용해 `beta`를 `beta-updated`로 바꾸고 `gamma`를 추가하도록 요청했다. raw log는 `/tmp/oq53-codex-diff-plan-raw-debug.jsonl`, summary는 `/tmp/oq53-codex-diff-plan-summary.json`에 남겼다.
- GREEN: `node /tmp/oq53_codex_diff_plan_probe.mjs` 통과. 결과는 inbound 84건, outbound 4건, terminal turn 1건, fileChange item 2건, `turn/diff/updated` 3건, `lateEvents=[]`, `postCompletionGraceMs=2500`, output file content `alpha\nbeta-updated\ngamma\n`다. ordering은 fileChange `item/started` seq 66 → fileChange `item/completed` seq 67 → `turn/diff/updated` seq 68/71/82 → `thread/tokenUsage/updated` seq 69/80 → `thread/status/changed` seq 83 → `turn/completed` seq 84이다.
- 따라서 fileChange와 turn-level diff가 실제로 오가는 Codex live turn에서도 `turn/completed` 뒤 같은 `(threadId,turnId)` 보조 notification 후보는 관측되지 않았다. 같은 prompt에서 짧은 plan을 요청했지만 `turn/plan/updated`/plan item은 발생하지 않았다(`turnPlanUpdates=0`, `planItems=0`). OQ-53 잔여는 plan 포함 Codex live turn과 Claude ACP `session/prompt` stopReason 뒤 `session/update` 후보로 좁힌다.

## 2026-06-30 보강 — OQ-53 analyzer inbound seq strictness

- OQ-53 raw debug analyzer가 inbound entry의 reader-local `seq`가 없을 때 JSONL line index로 값을 보정하고 있어, 현재 raw debug 포맷이 아닌 malformed/구버전 로그도 same-turn late evidence처럼 판정할 수 있었다. 직전 E2E 보강으로 mock path까지 inbound `seq`를 남기게 했으므로, analyzer도 `seq` 없는 inbound entry를 증거로 쓰지 않아야 한다.
- `analyzeRawProtocolDebugLog`는 outbound entry(`session/prompt` 추적)는 그대로 허용하되, inbound entry는 양의 정수 `seq`가 있을 때만 terminal marker/late 후보 판정에 사용한다. `07-tauri-process-runtime.md` §11 raw protocol log 포맷 설명도 inbound entry의 reader-local 1-based `seq` 포함으로 동기화했다.
- RED: `debug-log-analyzer.test.ts`에 inbound `seq`가 없는 Codex `turn/completed`→`item/completed` 로그를 `lateEvents=[]`로 기대하는 테스트를 추가하자 기존 fallback 때문에 late 후보가 생성되어 실패했다. GREEN: `npm run test -- src/lib/features/agent-runtime/service/debug-log-analyzer.test.ts` 통과(3 tests). 앱 수동 launch, live provider turn 생성, same-turn late notification wire capture는 수행하지 않았다.

## 2026-06-30 보강 — OQ-53 test-mode raw debug inbound seq

- 사용자 지시에 따라 앱 수동 launch 없이 Windows `agent-runtime` E2E부터 재검증했다. 기존 suite는 통과했지만, raw debug E2E의 test-mode mock path가 real stdout reader와 달리 inbound debug entry에 `seq`를 남기지 않는 차이를 확인했다. OQ-53 분석기는 raw debug JSONL의 arrival order/`seq`를 evidence로 쓰므로, mock 기반 E2E에서도 같은 하한을 검증해야 한다.
- `MockSink`가 runtime의 `message_seq` counter를 공유하고, mock inbound `emit_mock_jsonrpc_line`이 `write_protocol_debug_log_with_values(..., Some(seq))`로 기록하도록 보강했다. real reader의 redaction/raw bridge 경계는 유지하고, outbound entry는 계속 seq 없이 둔다.
- RED: `e2e/agent-runtime/agent-runtime.test.ts` raw debug spec에 inbound entry `seq` 정수 검증을 추가한 뒤 `npm run test:e2e:wsl -- --skip-build --project agent-runtime`가 raw debug 케이스에서 `Number.isInteger(entry.seq) === false`로 실패했다. GREEN: 최신 Windows build 포함 `npm run test:e2e:wsl -- --project agent-runtime` 통과(1 file / 16 tests). 추가 확인: `cargo test --manifest-path src-tauri/Cargo.toml rs19_mock_jsonrpc_responses_are_valid_and_provider_specific -- --nocapture`, `cargo test --manifest-path src-tauri/Cargo.toml e2e10_ -- --nocapture`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 통과. 앱 수동 launch, live provider turn 생성, same-turn late notification wire capture는 수행하지 않았다.

## 2026-06-30 보강 — OQ-53 Codex turn/completed analyzer envelope

- OQ-53 raw debug log analyzer의 Codex terminal marker fixture가 `turn/completed`를 `{threadId, turnId}`처럼 단순화해 보고 있었다. 실제 ref-codex shape는 `turn/completed` params가 `{threadId, turn:{id,...}}`이고, 이후 `item/*`/`turn/*` 보조 notification이 `{threadId, turnId}`를 가진다. 기존 analyzer는 실제 `params.turn.id` 형태를 terminal marker로 잡지 못해, 다음 raw capture에서 late 후보를 놓칠 수 있었다.
- `codexTurnKey`가 direct `params.turnId`와 `params.turn.id`를 모두 읽도록 보강했다. 이는 OQ-53 wire 실측 자체를 대체하지 않고, 캡처가 생겼을 때 실제 Codex envelope을 분석할 수 있게 하는 판정 경계 보강이다.
- RED: `npm run test -- src/lib/features/agent-runtime/service/debug-log-analyzer.test.ts`가 실제 `turn/completed` envelope fixture에서 lateEvents `[]`로 실패했다. GREEN: 같은 targeted test 통과(2 tests). 앱 launch, live provider turn 생성, same-turn late notification wire capture, seal grace 재튜닝은 수행하지 않았다.

## 2026-06-30 보강 — OQ-60 repeated invalid framing broken code

- OQ-60의 framing code seed에서 1회 invalid JSON은 `framing_invalid_json`, 1회 line-too-large는 `framing_line_too_large`로 보존하지만, 5회 연속 invalid/cap 초과로 reader latch에 들어가는 순간은 recoverable 원인별 오류가 아니라 framing 붕괴로 노출되어야 한다. 기존 구현은 5번째 invalid line의 `recoverable:false` event에도 code를 `framing_invalid_json`으로 유지했다.
- `emit_framing_error`가 fatal latch 진입 시 code를 `framing_broken`으로 승격하게 했다. EOF-like incomplete JSON/raw newline fatal 경로의 `framing_broken` 동작은 유지하고, latch 이후 stdout drop 경계도 그대로 둔다.
- RED: `cargo test --manifest-path src-tauri/Cargo.toml oq60_repeated_invalid_lines_escalate_to_framing_broken_code_and_latch -- --nocapture`가 5번째 event code `framing_invalid_json`으로 실패했다. GREEN: `cargo test --manifest-path src-tauri/Cargo.toml framing -- --nocapture` 통과(5 tests). 앱 launch, live provider turn 생성, post-start recovery UX 설계/구현, provider별 full taxonomy는 수행하지 않았다.

## 2026-06-30 문서 동기화 — OQ-56 ACP resource source boundary

- OQ-56의 잔여 "ACP resource source"가 현재 핀에서 바로 구현 가능한 provider-backed 검색 누락인지 재확인했다. `@agentclientprotocol/sdk@0.29.0` schema와 `@agentclientprotocol/claude-agent-acp@0.51.0` dist에는 prompt content `resource_link`/embedded `resource`, `PromptCapabilities.embeddedContext`, `available_commands_update`는 있지만 resource search/list request는 없다.
- 현재 Claude ACP adapter는 `AgentRuntimePort.searchResources`를 명시적으로 구현하되 `[]`를 반환하고 outbound ACP request를 만들지 않는다. `AgentTranscriptSurface`는 provider 결과가 없거나 실패하면 기존 workspace file fallback을 사용한다. 이 경계는 `claude-acp-adapter.test.ts` OQ-56과 `AgentTranscriptSurface.test.ts` OQ-56이 이미 고정한다.
- 따라서 이번 slice는 기능 코드를 추가하지 않고 HANDOFF/08/13 문서만 현재 코드·핀에 맞게 좁혔다. OQ-56은 provider-backed richer image resource source, `$` trigger, 그리고 향후 ACP protocol/package가 resource search/list RPC를 제공하거나 별도 client-side source 정책이 필요해질 때의 후속으로 남긴다. 앱 launch와 live provider turn 생성은 수행하지 않았다.

## 2026-06-30 보강 — OQ-60 transport framing error code seed

- OQ-60의 남은 범위 중 새 UX 설계가 필요한 post-start recovery는 건드리지 않고, 현재 transport/backend가 이미 안정적으로 분류 가능한 framing error에만 optional `AgentRuntimeErrorCode` seed를 추가했다. `AgentEvent.error`/`agent-runtime-error`는 기존 `{message,recoverable}` 호환을 유지하면서 `code?`를 받을 수 있고, backend framing은 `framing_invalid_json`/`framing_line_too_large`/`framing_broken`만 채운다. Codex/Claude adapter는 runtime error `code`가 있으면 normalized `error` event로 보존한다.
- RED: `npm run test -- src/lib/features/agent-runtime/service/transport.test.ts src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.test.ts -t "diagnostic event|runtime error event"`가 `code` 미전달로 실패했고, `cargo test --manifest-path src-tauri/Cargo.toml ac4b_fatal_framing_latches_and_suppresses_followup_stdout -- --nocapture`는 테스트 emitter signature가 기존 trait와 맞지 않아 컴파일 실패했다. GREEN: 동일 targeted frontend 테스트가 통과했고, `cargo test --manifest-path src-tauri/Cargo.toml framing -- --nocapture`도 통과했다(4 tests: fatal framing, recoverable invalid JSON, line-too-large, classify fatal). 앱 launch, live provider turn 생성, post-start recovery UX 설계/구현, provider별 full taxonomy는 수행하지 않았다.

## 2026-06-30 보강 — OQ-53 raw debug log inbound seq

- OQ-53 same-turn late notification 실측을 앱 launch 없이 바로 닫을 수 있는지 먼저 확인했다. `codex app-server --stdio` read-only probe와 현재 Codex session JSONL을 대조했지만, rollout JSONL은 raw app-server notification envelope이 아니라 app history/event stream이므로 종료 신호 뒤 same-turn 보조 notification 여부를 판정하는 wire evidence로 쓰지 않는다.
- 대신 다음 live provider capture가 arrival order를 재현 가능하게 남기도록, opt-in raw protocol debug JSONL의 inbound entry에 backend reader-local 1-based `seq`를 기록하게 했다. raw log는 계속 `CLCOMX_AGENT_DEBUG_LOG` opt-in, redacted `line`, inbound/outbound `direction` 경계를 유지하며, outbound/mock helper에는 실제 reader seq 의미가 없으므로 새 seq를 만들지 않는다.
- RED: `cargo test --manifest-path src-tauri/Cargo.toml e2e10_raw_protocol_debug_log_is_opt_in_and_redacted -- --nocapture`가 기존 raw log entry에 `seq`가 없어 `left: Null right: 1`로 실패했다. GREEN: 같은 targeted run 통과, 이어서 `cargo test --manifest-path src-tauri/Cargo.toml e2e10_ -- --nocapture` 통과(5 tests). 별도 수동 앱 launch, live provider turn 생성, same-turn late notification wire capture는 수행하지 않았으므로 OQ-53 자체는 미해소로 유지한다.

## 2026-06-30 보강 — OQ-53 raw debug log same-turn analyzer

- OQ-53 live wire capture 자체는 아직 남아 있지만, 캡처가 생겼을 때 사람이 수동으로 line order를 대조하는 대신 재현 가능한 판정 경계가 필요했다.
- `debug-log-analyzer.ts`에 `analyzeRawProtocolDebugLog`를 추가했다. 이 유틸은 opt-in raw debug JSONL의 `direction`/`seq`/`line`을 읽어 Codex `turn/completed` 이후 같은 `(threadId,turnId)` notification과 ACP `session/prompt` stopReason response 이후 같은 `sessionId`의 `session/update` 후보를 `lateEvents`로 보고한다.
- RED: `npm run test -- src/lib/features/agent-runtime/service/debug-log-analyzer.test.ts`가 분석기 모듈 부재로 import 실패했다. GREEN: 같은 targeted test 통과(2 tests). 실제 provider wire capture, seal grace 재튜닝, adapter fixture 교체는 수행하지 않았으므로 OQ-53은 계속 부분 구현/실측 미정으로 둔다.

## 2026-06-30 실측/보강 — OQ-10 local WSL target, OQ-46 reasoning summary authority

- 앱 launch 없이 현재 로컬 WSL target의 Claude runtime 조건을 재확인했다. `node --version`은 `v24.11.1`, `which node`는 `/home/xenia/.nvm/versions/node/v24.11.1/bin/node`, `npm ls @agentclientprotocol/claude-agent-acp @agentclientprotocol/sdk --depth=1`은 `claude-agent-acp@0.51.0` + transitive `sdk@0.29.0`, `node node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --cli --version`은 `2.1.187 (Claude Code)`를 반환했다. OS/WSL은 Ubuntu 24.04.4 LTS, WSL2 `6.18.33.2-microsoft-standard-WSL2`였고, `CLAUDE_CODE_EXECUTABLE`/`CLAUDE_CONFIG_DIR` override는 설정돼 있지 않았다. 따라서 OQ-10은 현재 로컬 WSL target 기준 native binary resolve까지 확인됐고, 릴리스/설치 배포 matrix 재확인은 별도 잔여로 남긴다.
- OQ-46은 `codex app-server --stdio` read-only probe로 `thread/list{limit:20}` pagination 3쪽에서 48개 thread를 수집하고, 각 thread에 `thread/read{includeTurns:true}`를 보내 item type만 집계했다(본문 content 미출력). 결과는 `reasoning` item 2,026개 모두 `summaryOnly`, `contentOnly=0`, `both=0`, `neither=0`, `summarySegments=6,685`, `contentSegments=0`이었다. 이에 따라 Codex completed reasoning 권위 텍스트를 `summary[]` join으로 좁히고, `summary[]`가 비어 있는 schema-drift/legacy 입력에만 `content[]` fallback을 남겼다.
- 아래 2026-06-29 이전 로그의 OQ-46 "미해소/보수 매핑" 표현은 당시 상태 기록이며, 최신 정본은 이 섹션과 13 OQ-46의 `summary[]` 권위 결정이다.
- RED: `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts -t "reasoning completed → summary is the authoritative thought text"`가 기존 concat 구현에서 `c1/c2`까지 포함해 실패했다. GREEN: 같은 `-t "reasoning completed"` targeted run 통과(2 selected tests), 이어서 `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts src/lib/features/agent-runtime/adapters/codex/codex-fixture-replay.test.ts src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.test.ts` 통과(3 files / 81 tests), `git diff --check` 통과. 별도 수동 앱 launch, 실제 live provider turn 생성, same-turn late notification wire capture, 실제 external editor focus/line reveal은 수행하지 않았다.

## 2026-06-29 검증 — direct runtime current local sweep

- 11 §8/§9와 13 레지스트리를 다시 대조했다. 앱 launch 없이 구현·검증 가능한 FE-11e ACP capability gate와 Codex reasoning/OQ-46 매핑은 현재 코드와 단위 테스트가 문서 요구를 덮고 있었고, Claude node/entry preflight/OQ-10은 native binary startup preflight를 추가 보강했다. 이후 2026-06-30 실측에서 OQ-46은 `summary[]` 권위로 해소됐고, OQ-10은 현재 로컬 WSL target native resolve까지 확인됐다. Windows `agent-runtime` 앱 E2E는 아래 별도 실행 기록으로 닫았고, 남은 미체크 항목은 기존 PTY E2E, same-turn late notification wire capture, 실제 external editor process focus/line reveal, 대용량 세션 운영 튜닝 성격으로 분류된다.
- 현재 worktree 기준 로컬 sweep: `npm run test` 통과(131 files, 986 tests), `cargo test --manifest-path src-tauri/Cargo.toml` 통과(162 Rust tests + doc-tests 0), `npm run check` 통과(`svelte-check` 0 errors/0 warnings + `vite build` + `cargo check`). 이어서 공식 로컬 gate인 `npm run verify`도 통과했다(`test` 131 files/986 tests, `test:rust` 162 tests, `check` 0 errors/0 warnings + Vite build + cargo check). Vite build의 500 kB chunk warning은 기존 번들 크기 경고로 남았고 exit code는 0이었다.
- E2E corpus import/skip 확인: `npx vitest run --config ./vitest.e2e.config.ts --project agent-runtime --reporter=dot` 통과(1 file / 14 tests skipped), `npx vitest run --config ./vitest.e2e.config.ts --reporter=dot` 통과(9 files / 25 tests skipped). 현재 Linux/WSL 환경의 `describe.skipIf(process.platform !== "win32")` guard 때문에 실제 앱 구동 없이 transform/import 경계만 확인했다.
- 별도 수동 앱 launch, live provider turn 생성, same-turn late notification wire capture, 실제 external editor process focus/line reveal 검증은 수행하지 않았다. Windows `agent-runtime` E2E 실제 실행은 아래 기록으로 11 §8의 해당 앱 실행 체크를 닫고, 11 §9의 OQ-53 및 OQ-61의 실제 external editor focus/line reveal 실측은 닫지 않는다. OQ-46/OQ-54는 별도 read-only app-server probe로 닫았다.

완료 감사 결과:

| 범위 | 현재 판정 | 근거 | 닫기 전 필요한 것 |
|---|---|---|---|
| 11 §8.6 local gate | 닫힘 | `npm run verify` 통과(`test` 986, Rust 162, `check` 0/0) | 없음 |
| 11 §7 direct E2E corpus | 닫힘(agent-runtime project) | `e2e/agent-runtime/agent-runtime.test.ts` 14개 spec, Windows `test:e2e:wsl -- --install-tools --project agent-runtime` 통과 | 전체 E2E pack은 별도 범위 |
| 11 §8.3 legacy PTY 보존 | 부분 닫힘 / 기존 PTY pack 미완료 | Windows E2E-6 fallback과 direct toggle-off legacy PTY host 통과, workspace restore spec 준비 | Windows 앱에서 기존 legacy PTY E2E(`smoke`, `terminal-input`, `terminal-aux`, workspace restore) 통과 |
| 11 §8.4 탭 전환·editor location | 앱 E2E 하한 닫힘 / 실제 external focus 미완료 | FE-21/OQ-61 단위 테스트, Windows E2E-9/E2E-11 통과 | 실제 external editor process focus/line reveal 확인 |
| 11 §8.5 raw protocol log | 닫힘 | Rust raw-log/redaction tests, frontend transport guard tests, Windows E2E-10 통과 | 없음 |
| 13 OQ-10 node/native preflight | 코드 하한 닫힘 / 현재 로컬 WSL target 실측 닫힘 / 배포 matrix 잔여 | node `--version` + Claude `node <adapterEntryPath> --cli --version` native probe, launch env 전달, 2026-06-30 로컬 WSL target `node v24.11.1` + Claude `2.1.187` resolve 확인 | 릴리스/설치 배포 matrix의 node/claude/SDK 버전·OS/WSL 조합 확인 |
| 11 §9 provider wire·운영 실측 | 부분 닫힘 / 후속 실측 | OQ-46 summary 권위 실측, OQ-53 합성 late-event fixture, OQ-54 scratch replay/full snapshot 실측, OQ-52 bounded cap 구현 | same-turn late notification wire capture와 대용량 세션 운영 튜닝 |

## 2026-06-29 검증 — Windows agent-runtime E2E 실행

- 사용자 지시에 따라 별도 수동 앱 launch는 하지 않고, WSL mirror 기반 Windows E2E만 실행했다. 최초 `npm run test:e2e:wsl -- --project agent-runtime`는 현재 shell PATH에 `powershell.exe`가 없어 runner 진입 전 실패했다. `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` 절대경로 실행은 정상이라 interop 자체가 아니라 PATH 문제로 분리했다.
- Windows mirror의 `package.json`/`package-lock.json`에는 `@xterm/addon-serialize`가 있었지만 `C:\temp\clcomx\node_modules`가 stale해 첫 빌드에서 import resolve가 실패했다. 문서화된 설치 포함 경로로 전환해 `--install-tools`를 붙였고, Windows `npm ci`가 mirror 의존성을 갱신한 뒤 frontend build와 Tauri debug build가 통과했다.
- 확인: `env PATH="$PATH:/mnt/c/Windows/System32/WindowsPowerShell/v1.0:/mnt/c/Windows/System32" npm run test:e2e:wsl -- --install-tools --project agent-runtime` 통과. 결과: `agent-runtime` project 1 file / 14 tests passed. 포함 범위는 direct Codex/Claude mock prompt, Claude permission allow, Codex approval allow/reject/stop cancel, E2E-11 internal editor 및 external default/picker command payload, recent history direct host, E2E-10 raw log default-off/opt-in redaction, fallback/legacy PTY, E2E-9 direct+PTY tab switch host 유지다.
- 잔여: 전체 E2E pack(`smoke`, `terminal-*`, workspace restore 등), 실제 Codex/Claude provider wire capture, 실제 external editor process focus/line reveal, 별도 수동 앱 launch는 수행하지 않았다.

## 2026-06-29 보강 — OQ-10 Claude native binary startup preflight

- OQ-10/위험 1.9는 node 존재·버전뿐 아니라 `@anthropic-ai/claude-agent-sdk` optional dependency 또는 `CLAUDE_CODE_EXECUTABLE` override로 Claude native binary가 resolve되는지도 start 전에 확인하라고 요구한다. 기존 backend preflight는 resolved node의 `--version`만 확인했기 때문에 optional dependency 누락은 adapter process가 뜬 뒤 prompt/SDK 호출에서야 드러날 수 있었다.
- `TrustedPathResolver`/`CachingResolver`에 Claude native preflight를 추가하고, start 직전 `preflight_launch_for_start`가 provider=`claude`일 때 `node <adapterEntryPath> --cli --version` 성격의 probe를 실행하도록 했다. probe는 `launch.non_secret_env`를 받아 `CLAUDE_CODE_EXECUTABLE` 같은 검증된 override가 실제 launch와 같은 env 조건에서 적용되도록 한다. 실패하거나 빈 출력이면 redacted launch audit을 남기고 spawn으로 진행하지 않는다. shell probe는 실패 출력도 stderr로 다시 내보내 audit/setup error에 원인이 남도록 했다.
- RED: `cargo test --manifest-path src-tauri/Cargo.toml rs10k_claude_start_preflight_runs_native_binary_probe -- --nocapture`가 `preflight_launch_for_start` native probe 인자 부재로 컴파일 실패했고, `rs10m_claude_native_preflight_receives_launch_env`도 env 전달 인자 부재로 컴파일 실패했다. shell failure output 보존 helper도 `resolver::tests` RED로 먼저 고정했다. GREEN: `cargo test --manifest-path src-tauri/Cargo.toml rs10 -- --nocapture` 통과(11 tests), `cargo test --manifest-path src-tauri/Cargo.toml resolver::tests -- --nocapture` 통과(2 tests). 앱 launch, Windows E2E, 실제 target node/claude/native binary 실측은 수행하지 않았다.

## 2026-06-29 보강 — OQ-56 resource action empty-query source flow

- OQ-56은 resource action button이 draft 끝에 `@` token을 열어 기존 resource palette 흐름으로 진입한다고 정의한다. `AgentComposer`는 빈 query로 `resourceSearch("")`를 호출했지만, `AgentTranscriptSurface.searchResourceMentions`와 `AgentRuntimeController.searchResources`가 빈 query를 조기 `[]`로 버려 surface 경유 버튼 클릭에서는 provider/workspace source가 기본 후보를 제공할 수 없었다.
- controller와 surface의 빈 query early return을 제거해 빈 query도 provider-backed source와 workspace fallback source에 전달하도록 했다. 실제 source가 빈 query에서 후보를 제공할지 여부는 각 source가 결정한다. 기존 Rust `search_session_files`의 empty-query 빈 결과 정책은 유지하고, custom/provider/test source는 기본 후보를 돌려줄 수 있다.
- RED: `npm run test -- src/lib/features/agent-runtime/controller/agent-runtime-controller.test.ts -t "empty resource query"`는 `port.searchResources` 호출 0회로 실패했고, `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "resource action button opens workspace fallback"`는 resource palette 부재로 실패했다. GREEN: 두 targeted test가 통과했다. 앱 launch, Windows E2E, 실제 ACP richer resource source 검증은 수행하지 않았다.

## 2026-06-29 보강 — Codex shutdown awaits approval cancel wire

- 04 §4.2/§5와 11 S3는 shutdown 시 pending approval을 backend shutdown 전에 cancelled wire response로 닫는 순서를 요구한다. 기존 Codex app-server `shutdown()`은 `closePending(rt, "shutdown")`을 호출했지만 내부 `deps.send(...)`를 `void` fire-and-forget으로 실행해 async transport에서는 cancel response 완료 전에 backend shutdown이 시작될 수 있었다.
- `closePending`을 await 가능한 cleanup 루틴으로 바꾸고, shutdown 경로에서는 pending approval cancel response send를 await한 뒤 backend shutdown으로 넘어가게 했다. exit 경로는 wire를 보내지 않으므로 내부 cleanup만 fire-and-forget으로 유지한다. shutdown 중 cancel response send가 이미 닫힌 transport 때문에 실패하면 내부 cleanup을 권위로 두고 backend shutdown은 계속 진행한다.
- RED: `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.test.ts -t "S3: shutdown awaits async"`가 cancel response release 전 `shutdown` 호출 1회로 실패했다. GREEN: 같은 targeted test 통과. 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — Claude ACP shutdown awaits approval cancel wire

- 04 §4.2/§5와 11 S3는 shutdown 시 pending approval을 backend shutdown 전에 cancelled wire response로 닫는 순서를 요구한다. 기존 Claude ACP `shutdown()`은 `closePending(rt, true)`를 호출했지만 내부 `deps.sendMessage(...)`를 `void` fire-and-forget으로 실행해 async transport에서는 cancel response 완료 전에 `shutdownRuntime`이 시작될 수 있었다.
- `closePending`을 await 가능한 cleanup 루틴으로 바꾸고, shutdown 경로에서는 pending approval cancel response send를 await한 뒤 backend shutdown으로 넘어가게 했다. exit/failSession 경로는 wire를 보내지 않으므로 기존처럼 내부 cleanup만 비동기 fire-and-forget으로 유지한다. shutdown 중 cancel response send가 이미 닫힌 transport 때문에 실패하면 내부 cleanup을 권위로 두고 backend shutdown은 계속 진행한다.
- RED: `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts -t "S3: shutdown awaits async"`가 cancel response release 전 `shutdownRuntime` 호출 1회로 실패했다. GREEN: 같은 targeted test 통과. 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — replay scratch loader dispose-after-use guard

- 10 §4.7/11 FE-27은 provider replay를 별도 scratch 세션으로 1회 조회하고 조회 성공/실패 뒤 폐기한다고 요구한다. `ReplayPanel`은 이미 조회 뒤 `dispose()`를 호출하지만, `createPortReplayLoader` 자체는 `dispose()` 이후 `loadHistory()`를 다시 호출하면 cached replay promise를 재사용해 폐기된 scratch 결과를 다시 돌려줄 수 있었다.
- `createPortReplayLoader.loadHistory()`가 disposed 상태에서는 빈 결과를 반환하고, `dispose()`가 cached replay promise를 해제하도록 했다. 또한 replay load가 진행 중인 상태에서 `dispose()`가 먼저 이기면, 뒤늦게 `resumeSession`이 완료되어도 in-flight event 배열이나 late failure rejection을 caller에게 돌려주지 않는다. 이미 시작된 조회 결과를 live store에 병합하지 않는 기존 경계는 유지한다. dispose 전 provider replay 실패는 기존처럼 rejection으로 남아 `ReplayPanel` unavailable 경로를 탄다.
- RED: `npm run test -- src/lib/features/agent-runtime/service/runtime-replay.test.ts -t "does not reopen"`가 dispose 이후에도 이전 replay event를 반환해 실패했고, `-t "in-flight replay"`는 dispose 이후 늦게 도착한 replay event/rejection을 반환해 각각 실패했다. GREEN: targeted tests 통과. 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — Codex unknown ThreadItem variant raw diagnostics

- 13 RD-10은 unknown method뿐 아니라 unknown variant도 silent drop하지 않고 raw 보존 + counter로 가시화하라고 요구한다. 기존 Codex mapper는 알 수 없는 notification method(CX-15c)는 기록했지만, `item/started`/`item/completed` 내부의 v1 밖 `ThreadItem` variant는 `[]`만 반환해 counter와 raw diagnostic에 남지 않았다.
- `mapItemStarted`/`mapItemCompleted`의 default 분기에 `recordUnknownPayload({ method:"item/...", params:{threadId,turnId,item} })`를 추가했다. transcript event는 계속 만들지 않고, 지원 밖 variant를 UI 이벤트로 오인하지 않는 경계는 유지한다.
- RED: `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts -t "CX-15d"`가 unknown count `0`으로 실패했다. GREEN: 같은 targeted test 통과. 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — Claude ACP unknown notification raw diagnostics

- 04 §5/06 §6.4/RD-15는 알 수 없는 ACP notification(id 없음)을 응답 없이 무시하되 raw payload와 counter로 가시화하라고 요구한다. 기존 `session/update` mapper 단위는 `unknownRaw`를 남겼지만, `claude-acp-adapter` 통합 경계의 알 수 없는 notification과 malformed `session/update`는 outbound 없음만 검증돼 adapter-level raw 보존을 확인하기 어려웠다.
- `claude-acp-adapter`에 Codex mapper와 동형의 module-level unknown diagnostic getter/reset을 추가하고, 미지원 server request·미지원 notification·malformed `session/update` 및 mapper가 unknown으로 분류한 `session/update` payload를 진단 raw log에 남기도록 했다. server request는 기존처럼 `-32601` error 응답을 유지한다.
- RED: `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts -t "CL-27b"`가 `resetClaudeAcpUnknownNotifications is not a function`으로 실패했다. GREEN: 같은 targeted test 통과, 이어서 `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts` 통과(34 tests). 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — approval audit decidedBy propagation

- 09 §3.4/12 T1.6은 approval audit이 `decidedBy:"user"|"auto"|"cleanup"`를 남기도록 요구하지만, adapter-side cancel/shutdown/exit cleanup이 emit한 `approval_resolved{cancelled|failed}`는 store에서 기본 user 결정으로 audit될 수 있었다. Codex permission-profile 자동 decline과 `serverRequest/resolved`처럼 사용자 클릭 없이 닫는 mapper 경로도 주체가 명시되지 않았다.
- `approval_resolved` AgentEvent에 optional `decidedBy` metadata를 추가했다. 생략 시 기존 사용자 응답 경로와 호환되도록 store는 `"user"`로 해석하고, Codex/Claude cleanup emit은 `"cleanup"`, Codex permission-profile auto-decline은 `"auto"`로 표기한다. `ApprovalDecision` wire shape 자체는 바꾸지 않았다.
- RED: `agent-runtime-store.svelte.test.ts -t "adapter cleanup approval_resolved"`는 audit entry가 `user`로 남아 실패했고, Codex/Claude adapter cleanup targeted tests 및 `codex-wire-mapper.test.ts -t "auto-decline|serverRequest/resolved closes"`도 `decidedBy` 부재로 실패했다. GREEN: 같은 targeted suites가 통과했다. 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — public diagnostic transport dispose race

- OQ-59 경계에서 `createAgentTransportController`는 raw `agent-runtime-message`를 public으로 노출하지 않고 stderr/exit/error/backpressure diagnostic event만 구독한다. 이 public diagnostic controller의 `start()` 중 `dispose()`가 먼저 호출되면, 늦게 resolve된 `listen()`의 `unlisten` 함수가 `unlisteners`에 들어온 뒤 해제되지 않는 race가 있었다.
- `createAgentTransportController`에 generation guard를 추가해 dispose와 listen resolve가 교차한 경우 늦게 도착한 구독도 즉시 해제한다. 이미 정상 등록된 구독의 dispose 동작과 raw message 미구독 정책은 유지했다.
- RED: `npm run test -- src/lib/features/agent-runtime/service/transport.test.ts -t "dispose가 start 중"`가 늦게 도착한 `unlisten` 미호출(0/4)로 실패했다. GREEN: 같은 targeted test 통과, 이어서 `npm run test -- src/lib/features/agent-runtime/service/transport.test.ts` 통과(1 file, 11 tests), `npm run test -- src/lib/features/agent-runtime/service` 통과(3 files, 17 tests). 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 검증 — direct runtime local sweep

- 문서/현재 구현 대조 후, 남은 수용 체크박스 중 실제 Windows 앱 E2E 실행이 필요한 항목(E2E-6/7/9/10/11, legacy PTY E2E)은 이번 범위에서 닫지 않았다. 대신 앱 launch 없이 가능한 local verification을 넓혀 direct runtime 구현의 단위·컴포넌트·Rust 경계를 재확인했다.
- 확인: `npm run test -- src/lib/features/agent-runtime` 통과(34 files, 422 tests), `cargo test --manifest-path src-tauri/Cargo.toml` 통과(157 Rust tests + doc-tests), `npx --no-install svelte-check --tsconfig ./tsconfig.json` 0 errors/0 warnings.
- 추가 확인: `npm run test` 통과(131 files, 975 tests), `npm run check` 통과(`svelte-check` 0 errors/0 warnings + `vite build` + `cargo check`). Vite build의 500 kB chunk warning은 기존 번들 크기 경고로 남았고, exit code는 0이었다.
- `npx vitest run --config ./vitest.e2e.config.ts --project agent-runtime --reporter=dot`는 현재 Linux/WSL 환경에서 1 file / 14 tests skip으로 import/transform 경계만 확인했다. 앱 launch, Windows E2E 실제 실행, 실제 external editor focus/line reveal 검증은 수행하지 않았다.

## 2026-06-29 보강 — compact Authorization stderr redaction

- 09 §5.1/§5.2의 TB-2 stderr emit 경계에서 `Authorization: Bearer <value>`처럼 공백이 있는 header scheme은 이미 마스킹됐지만, 일부 logger가 `Authorization:Bearer <value>` 또는 `Authorization=Bearer <value>`처럼 marker와 scheme 사이 공백을 제거하면 다음 값 토큰이 평문으로 남을 수 있었다.
- `transport::redact`의 후속 토큰 redaction marker에 compact `Authorization:Bearer`/`Authorization:Token`/`Authorization:Basic` 및 equals variant를 추가해, 뒤따르는 credential 값은 `[REDACTED]`로 숨기도록 했다. stderr reader는 line별로 emit하므로 auth marker 예약 상태도 line 경계 밖으로 유지해 `Authorization:Bearer\n<value>` 형태까지 마스킹한다.
- RED: `cargo test --manifest-path src-tauri/Cargo.toml masks_compact_bearer_header_value`가 `compact-token-123` 및 `equals-token-123` 평문 노출로 실패했고, `cargo test --manifest-path src-tauri/Cargo.toml masks_compact_bearer_header_value_across_stderr_lines`는 line 간 redaction state helper 부재로 컴파일 실패했다. GREEN: 두 targeted test가 통과했다. 앱 launch, Windows E2E, 실제 provider stderr 실측은 수행하지 않았다.

## 2026-06-29 보강 — OQ-61 direct editor foreground notice

- OQ-61 direct location wiring 이후 `SessionShell` direct host는 external resolve/open 실패는 `directFileOpenNotice`로 표시했지만, direct embedded editor의 quick-open/list workspace 같은 foreground editor 오류는 `reportForegroundError` callback이 no-op이라 사용자에게 드러나지 않았다.
- `reportForegroundError`를 기존 direct file-open notice surface에 연결해, direct editor foreground 오류도 `role="status"` notice로 표시되도록 했다. 테스트 fixture는 embedded editor의 open-file action을 노출하고, `SessionShell.test.ts`는 quick-open 파일 목록 조회 실패가 direct notice로 표면화되는지 검증한다.
- RED: `npm run test -- src/lib/features/session/view/SessionShell.test.ts -t "foreground errors"`가 `role="status"` 부재로 실패했다. GREEN: 같은 targeted test가 통과했다(1 file, 1 test selected). 앱 launch, Windows E2E, 실제 external editor focus/line reveal 검증은 수행하지 않았다.

## 2026-06-29 보강 — OQ-52 heavy item byte-cap regression

- OQ-52 v1 기본 cap 구현은 이미 reducer가 `tool rawInput/rawOutput`, image data URI, file diff patch를 hot-window byte 계산에 포함하는 상태였지만, 기존 증거는 turn count cap, text byte cap, terminal stderr 중심이라 heavy body별 회귀 경계가 충분히 직접적이지 않았다.
- `agent-event-reducer.test.ts`에 NM-31f/g/h를 추가해 작은 injected `HOT_WINDOW_BYTES`에서 raw body, image body, diff body가 각각 두 번째 sealed turn 입력 시 oldest sealed turn eviction을 유발하는지 고정했다. 이는 운영 수치 확정이나 heavy item별 ring/summary 정책 도입이 아니라, 현재 v1 bounded heap 불변식의 회귀 테스트 보강이다.
- 확인: `npm run test -- src/lib/features/agent-runtime/controller/agent-event-reducer.test.ts -t "NM-31f|NM-31g|NM-31h"` 통과(1 file, 3 tests selected). 앱 launch, Windows E2E, 실제 대용량 세션 성능 실측은 수행하지 않았다.

## 2026-06-29 보강 — OQ-56 ACP resource source fallback boundary

- OQ-56의 잔여 범위 중 ACP provider-backed richer resource source는 아직 protocol/source 정책이 미확정이므로 v1 구현 완료로 승격하지 않는다. 대신 Claude ACP adapter가 `AgentRuntimePort.searchResources`를 명시적으로 구현하되 빈 결과를 반환해, UI가 provider source 미지원/빈 결과를 workspace file fallback으로 낮추는 경계를 코드로 고정했다.
- `AgentTranscriptSurface`는 direct-claude 세션에서 provider search가 `[]`를 반환하면 기존 `searchSessionFiles(sessionId, workDir, query, 8)` fallback을 호출하고, 선택한 workspace file을 `AgentContent{type:"resource", uri:"file://..."}`로 전송한다. 이는 ACP richer source 구현이 아니라 v1 미지원 경계 + fallback 경계 보강이다.
- 확인: `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts` 통과(1 file, 33 tests), `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "OQ-56"` 통과(1 file, 5 selected tests), `npx --no-install svelte-check --tsconfig ./tsconfig.json` 0 errors/0 warnings, 변경 파일 `git diff --check` 통과. 앱 launch, Windows E2E, 실제 ACP richer resource source 검증은 수행하지 않았다.

## 2026-06-29 보강 — E2E-11 external editor picker command payload spec 추가

- OQ-61 external picker 흐름은 `SessionShell.test.ts` 단위 경계로는 검증됐지만, `e2e/agent-runtime/agent-runtime.test.ts`에는 default editor payload spec만 있어 실제 Windows E2E 실행 시 picker 경로를 별도로 확인하지 못했다.
- E2E-11 external picker spec을 추가했다. spec은 `fileOpenTarget:"external"`, `fileOpenMode:"picker"`, `defaultEditorId:"code"`를 seed하고, `location please` prompt → `cmd-location-1` 완료 → location row 클릭 → editor picker modal 표시 → `cursor` 선택 → `editor-open-events.jsonl`의 editor/path/line/column payload를 확인한다.
- 확인: `npx vitest run --config ./vitest.e2e.config.ts --project agent-runtime --reporter=dot`는 현재 Linux/WSL 환경에서 1 file / 14 tests skip으로 transform/import를 확인했다. 앱 launch, Windows E2E 실제 실행, 실제 외부 editor process focus/line reveal 검증은 수행하지 않았다.

## 2026-06-29 보강 — E2E-11 external editor command payload spec 추가

- E2E-11 external target을 실제 spec으로 만들려면 test-mode `src/lib/example.ts` location이 `resolve_terminal_path`와 `open_in_editor`까지 통과해야 했다. 기존 internal fixture는 `read_session_file`만 보강했기 때문에 external target에서는 실제 FS metadata 부재로 path resolution이 실패할 수 있었다.
- `resolve_terminal_path`는 `CLCOMX_TEST_MODE`에서 세션 `workDir` 내부 `src/lib/example.ts` fixture를 실제 파일 없이 `ResolvedTerminalPath`로 해석한다. `open_in_editor`는 test mode에서 실제 editor process를 띄우지 않고, stateDir `editor-open-events.jsonl`에 `{editorId,windowsPath,line,column,isDirectory}` payload를 JSONL로 기록한다.
- 이 과정에서 `CLCOMX_TEST_MODE`를 쓰는 Rust 테스트들이 모듈-local env guard를 각자 사용해 병렬 실행 시 env 복원이 교차될 수 있음을 확인했다. `app_env::test_support::set_test_mode_env()` 공유 guard로 통일해 `cargo test ... test_mode_` 필터가 안정적으로 통과하게 했다.
- `e2e/agent-runtime/agent-runtime.test.ts`에 E2E-11 external default-editor spec을 추가했다. spec은 `fileOpenTarget:"external"`, `fileOpenMode:"default"`, `defaultEditorId:"cursor"`를 seed하고, `location please` prompt → `cmd-location-1` 완료 → location row 클릭 → `editor-open-events.jsonl`의 editor/path/line/column payload를 확인한다.
- RED: `cargo test --manifest-path src-tauri/Cargo.toml test_mode_resolves_location_fixture_without_real_file`는 `Path does not exist`로 실패했고, `cargo test --manifest-path src-tauri/Cargo.toml test_mode_open_in_editor_records_launch_payload`는 `editor-open-events.jsonl` 부재로 실패했다.
- GREEN: 같은 두 Rust targeted test가 통과했고, `npx vitest run --config ./vitest.e2e.config.ts --project agent-runtime --reporter=dot`는 현재 Linux/WSL 환경에서 1 file / 13 tests skip으로 transform/import를 확인했다. 앱 launch, Windows E2E 실제 실행, 실제 외부 editor process focus/line reveal 검증은 수행하지 않았다.

## 2026-06-29 보강 — E2E-11 internal editor spec 추가

- E2E-11을 실제 spec으로 추가하려면 Codex location mock이 가리키는 `src/lib/example.ts`를 internal editor가 읽을 수 있어야 했다. 기존 `CLCOMX_TEST_MODE`는 WSL file list/search mock은 제공했지만 `read_session_file`은 실제 파일만 요구해, Windows E2E에서 fixture 파일 부재로 internal editor open이 실패할 수 있었다.
- `read_session_file`은 세션 root 허용 검사를 통과한 뒤에만 test-mode fixture `src/lib/example.ts`를 반환한다. fixture content는 line 12가 존재하게 구성해 `locations[{line:12,column:4}]` reveal 경로를 검증할 수 있게 했다.
- `e2e/helpers/agent-runtime.ts`에 `clickAgentToolLocation`을 추가하고, `e2e/agent-runtime/agent-runtime.test.ts`에 E2E-11 internal target spec을 추가했다. spec은 stateDir `setting.json`으로 `fileOpenTarget:"internal"`을 seed하고, `location please` prompt → `cmd-location-1` 완료 → location row 클릭 → `InternalEditor` shell의 `data-active-path`/`data-active-line`/`data-active-column`을 확인한다.
- RED: `cargo test --manifest-path src-tauri/Cargo.toml read_session_file_returns_test_mode_location_fixture`는 fixture read fallback 부재로 `Path does not exist` 실패했다.
- GREEN: 같은 Rust targeted test가 통과했고, `npx vitest run --config ./vitest.e2e.config.ts --project agent-runtime --reporter=dot`는 현재 Linux/WSL 환경에서 1 file / 12 tests skip으로 transform/import를 확인했다. 앱 launch, Windows E2E 실제 실행, external editor focus/line reveal 검증은 수행하지 않았다.

## 2026-06-29 보강 — OQ-61 E2E 관찰 지점 준비

- E2E-11을 안정적으로 작성하려면 location row를 role/text가 아니라 stable selector로 찾고, internal editor open 후 active path/line/column을 DOM에서 관찰할 수 있어야 한다. 기존 `ToolCallCard` location button은 class/text 기반으로만 찾을 수 있었고, `InternalEditor` shell은 active path/line/column을 attribute로 노출하지 않았다.
- `agentToolLocationTestId(itemId,index)`를 추가하고 `ToolCallCard` location button에 `data-testid`로 연결했다. `InternalEditor` root shell에는 `data-active-path`, `data-active-line`, `data-active-column`을 노출해 E2E가 editor state를 안정적으로 assert할 수 있게 했다.
- RED: `ToolCallCard.test.ts -t "emits the raw file location"`는 `agentToolLocationTestId` 부재로 실패했고, `InternalEditor.test.ts -t "exposes active path"`는 `data-active-path` 부재로 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/tool-cards/ToolCallCard.test.ts` 통과(1 file, 10 tests), `npm run test -- src/lib/components/InternalEditor.test.ts` 통과(1 file, 6 tests). 앱 launch, Windows E2E, E2E-11 spec 추가는 수행하지 않았다.

## 2026-06-29 보강 — OQ-61 Codex locations mock/mapper 기반

- E2E-11(tool location editor open)을 작성하려면 test-mode mock이 `ToolCallUpdate.locations[]`까지 도달할 수 있는 provider item을 만들어야 하지만, 기존 Codex mock은 prompt/approval lifecycle만 생성했고 mapper도 `commandExecution`의 generated baseline 밖 `locations[]`를 버렸다.
- `codex-wire-mapper.ts`는 `commandExecution` raw item에 optional `locations[]`가 있으면 valid `{path,line,column}`만 `ToolCallUpdate.locations`로 보존한다. generated `ThreadItem.ts`는 수정하지 않고, provider/test-mode 확장 field를 방어적으로 읽는 경계로 뒀다.
- Rust test-mode Codex mock은 `location` prompt에서 `cmd-location-N` commandExecution item을 `locations:[{path:"src/lib/example.ts",line:12,column:4}]`와 함께 started/completed lifecycle로 emit한다. 이로써 E2E-11 spec 작성 입력 기반은 마련됐지만, location row 클릭 후 internal/external editor focus·line reveal을 확인하는 Windows 앱 E2E는 아직 수행하지 않았다.
- RED: `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts -t "commandExecution with locations"`는 `update.locations` 누락으로 실패했고, `cargo test --manifest-path src-tauri/Cargo.toml rs19_mock_jsonrpc_responses_are_valid_and_provider_specific`는 mock delayed line에 `"locations"`가 없어 실패했다.
- GREEN: 같은 두 targeted command가 통과했다. 앱 launch, Windows E2E, E2E-11 spec 추가는 수행하지 않았다.

## 2026-06-29 문서 동기화 — OQ-61 잔여 E2E 범위 현재화

- `HANDOFF.md`의 시작 전 확인 섹션이 OQ-61 보강 이후에도 tool location editor 연결 상태를 해소/잔여 예시에 반영하지 않았다. 현재 `SessionShell` direct host는 callback 경계, internal editor open, external default editor, external picker 단위 흐름까지 구현했고, 남은 것은 실제 Windows 앱에서 editor focus/line reveal을 확인하는 E2E slice다.
- 11 §7 E2E 시나리오 표에도 tool location editor open 항목이 없어, OQ-61의 남은 Windows 검증이 §8/§9에만 흩어져 있었다. E2E-11을 추가하고 당시 `e2e/agent-runtime/agent-runtime.test.ts`에는 아직 spec이 없음을 명시했다. 이후 별도 보강에서 internal target E2E-11 spec을 추가했다.
- HANDOFF의 해소 예시에 OQ-61 단위 흐름을 추가하고, 열린 예에는 Windows 앱 internal/external editor focus·line reveal E2E를 명시했다. 문서 동기화만 수행했고 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — OQ-61 direct location external editor flow

- OQ-61의 direct host location open은 internal editor까지만 연결돼 있었고, `settings.interface.fileOpenTarget/fileOpenMode/defaultEditorId`가 external로 설정된 경우에도 direct tool location click이 내부 embedded editor로 열렸다. 이는 terminal link click과 direct tool location click의 기본 file-open 정책이 갈라지는 문제다.
- `SessionShell` direct host가 기존 terminal file-link action 정책을 재사용하도록 보강했다. internal target은 기존처럼 WSL 절대/상대 path를 internal editor facade로 열고, external target은 `resolve_terminal_path`로 `ResolvedTerminalPath.windowsPath`를 얻은 뒤 configured default editor 또는 editor picker 선택 editor로 `open_in_editor`를 호출한다. line/column은 direct `FileLocation` 값을 보존해 internal tab state와 external editor launch payload에 반영한다.
- RED: `npm run test -- src/lib/features/session/view/SessionShell.test.ts`가 external default editor 설정에서도 `openInEditor` 호출이 없고 internal editor가 열려 실패했으며, picker 설정에서도 `editor-picker-modal`이 렌더되지 않아 실패했다.
- GREEN: 같은 테스트 파일이 통과했다(1 file, 5 tests). 앱 launch, Windows E2E의 실제 외부 editor 실행/focus/line reveal 검증은 수행하지 않았다.

## 2026-06-29 보강 — OQ-61 direct location internal editor wiring

- 08 §4.3/13 OQ-61은 tool location row가 raw `FileLocation`을 상위로 전달하는 callback 경계까지만 구현돼 있고, direct host의 실제 editor open wiring을 후속으로 남겼다. `SessionShell` direct host가 기존 `createEditorFacade`와 `TerminalEmbeddedEditorSurface`를 직접 소유하도록 해, `AgentTranscriptSurface.onOpenLocation`을 internal editor open으로 연결했다.
- location path가 WSL 절대 경로면 그대로 사용하고, 상대 경로면 session `workDir` 기준으로 보정한다. line/column은 editor tab state와 session editor state에 보존된다. 당시에는 외부 editor picker/default editor flow를 direct tool location에는 붙이지 않고 OQ-61 후속 범위로 남겼으며, 이후 별도 OQ-61 external editor flow 보강에서 연결했다.
- RED: `npm run test -- src/lib/features/session/view/SessionShell.test.ts`가 direct host에 location click 버튼/handler가 없어 `host-open-location`을 찾지 못해 실패했다.
- GREEN: 같은 테스트 파일이 통과했다(1 file, 3 tests). 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — OQ-47 commandActions escalation guard

- OQ-47은 Codex approval severity에서 `commandActions` 위험도와 `availableDecisions` 같은 추가 wire 신호를 잔여로 남겼다. 현재 generated `CommandAction`은 `read`/`listFiles`/`search`/`unknown` 4종뿐이므로 이 집합은 기존 command approval과 같이 `normal`로 유지하되, raw/future payload가 `write`/`edit`/`delete`/`move`/`execute`/`fetch`류 부수효과 action type을 명시하면 `severity:"escalation"`으로 올리도록 방어선을 추가했다.
- RED: `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts`가 raw/future `commandActions:[{type:"write"}]` 입력에서 `normal`을 반환해 실패했다.
- GREEN: 같은 테스트 파일이 통과했다(1 file, 41 tests). 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — tool location click callback boundary

- 08 §4.3은 `ToolCallUpdate.locations[]` 표시 후 editor/file-open 연결을 결정 필요로 남겼다. 당시 direct host는 `Terminal.svelte` 내부 editor facade를 우회하므로 실제 internal/external editor open wiring은 후속(OQ-61)으로 남기고, location row가 상위 handler로 raw `FileLocation`을 전달할 수 있는 UI/host callback 경계를 먼저 닫았다. 이후 internal editor와 external default/picker 흐름은 별도 OQ-61 보강에서 연결했다.
- `ToolCallCard`는 `onOpenLocation`이 주입된 경우 expanded location row를 접근 가능한 버튼으로 렌더한다. 표시 문자열은 `redactDisplayText(formatLocation(...))`를 거치지만 callback에는 raw `{path,line,column}`을 그대로 넘긴다. `MessageList`와 `AgentTranscriptSurface`도 이 callback을 끊지 않고 전달한다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/tool-cards/ToolCallCard.test.ts -t "emits the raw file location"`가 location row 버튼 부재로 실패했다. 이어서 `npm run test -- src/lib/features/agent-runtime/view/MessageList.test.ts -t "wires tool location"`와 `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "wires tool location"`가 callback 전달 부재로 실패했다.
- GREEN: 같은 targeted tests 3개가 각각 통과했다. 앱 launch, Windows E2E, 실제 editor open 연결은 수행하지 않았다.

## 2026-06-29 보강 — tool collapsed summary redaction

- 09 §5/TB-4는 raw detail뿐 아니라 화면 표시 직전 credential-like 값이 줄어야 한다는 경계다. `ToolCallCard`의 expanded content/location/raw detail은 redaction을 거쳤지만, collapsed summary와 `title` 속성은 provider `title` 또는 첫 `locations[].path`를 그대로 사용해 접힌 카드에서 secret-shaped 문자열이 노출될 수 있었다.
- `ToolCallCard.test.ts`에 첫 location path가 `Authorization: Bearer ...` 형태일 때 collapsed summary text와 tooltip title이 `[REDACTED]`로 표시되는 회귀 테스트를 추가했다. `ToolCallCard.svelte`는 raw summary를 별도로 계산한 뒤 `redactDisplayText(rawSummary)`를 헤더 표시와 title에 사용한다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/tool-cards/ToolCallCard.test.ts -t "redacts credential-like values from the collapsed summary"`가 접힌 카드 text에서 `account-token-123`을 관측해 실패했다.
- GREEN: 같은 targeted test 통과. 이어서 `npm run test -- src/lib/features/agent-runtime/view/tool-cards/ToolCallCard.test.ts` 통과(1 file, 9 tests), `npm run test -- src/lib/features/agent-runtime/view/display-redaction.test.ts src/lib/features/agent-runtime/view/tool-cards/CommandOutputCard.test.ts src/lib/features/agent-runtime/view/tool-cards/ToolCallCard.test.ts src/lib/features/agent-runtime/view/MessageList.test.ts` 통과(4 files, 25 tests). 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — running composer Enter no-queue guard

- 08 §6.5는 `running` 상태에서 draft 입력은 활성으로 두되, 다음 prompt queue 정책은 아직 결정 필요로 남긴다. 하지만 `AgentComposer`의 Enter handler는 `running`에서도 `send()`를 호출해 stop 버튼이 보이는 상태에서 키보드 전송만 추가 prompt를 queue처럼 내려보낼 수 있었다.
- `AgentComposer.test.ts`에 `running` 중 textarea가 비활성화되지 않으면서 Enter가 `onSend`를 호출하지 않고 draft를 보존하는 회귀 테스트를 추가했다. `AgentComposer.svelte`는 Enter 처리 시 `canStop`이면 전송하지 않도록 제한해, 명시적인 stop 버튼만 cancel 경로를 타게 했다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts -t "keeps the draft editable while running"`가 `onSend` 호출 1회를 관측해 실패했다.
- GREEN: 같은 targeted test 통과. 이어서 `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts` 통과(1 file, 30 tests). 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — reasoning/thought collapsed render guard

- 08 §6.2는 `channel:"thought"` stream을 response message와 분리된 접이식 thinking 블록으로 렌더하고, 기본 collapsed 상태와 ARIA `aria-expanded` 토글을 제공하라고 정의한다. reducer/adapter 쪽 thought channel 누적은 이미 검증되어 있었지만, `MessageList`/`MessageBubble` 렌더 경계에서 본문이 기본 숨김 상태인지 직접 잠그는 증거가 부족했다.
- `MessageList.test.ts`에 store dispatch → `MessageList` → `MessageBubble` 경로를 검증하는 reasoning case를 추가했다. `agent_message_delta{channel:"thought"}` 본문이 기본 collapsed 상태에서는 보이지 않고, `agentReasoningToggle`의 `aria-expanded=false`가 클릭 후 `true`로 바뀌며 본문이 표시되는지 확인한다.
- 확인: `npm run test -- src/lib/features/agent-runtime/view/MessageList.test.ts -t reasoning` 통과(1 file, 1 test selected). 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — OQ-60 post-start fatal no-fallback surface guard

- OQ-60은 post-start fatal/exit recovery UX와 typed failure-code taxonomy를 후속 결정으로 남기지만, v1 하한은 "fresh start 실패만 fallback panel, 기동 완료 후 fatal/exit는 notice/status 경로"로 이미 정해져 있었다. `AgentTranscriptSurface.test.ts`에 기동 완료 후 `error{recoverable:false}`와 abnormal `process_exited`가 각각 error notice + `failed`/`exited` status로 남고 `agent-runtime-fallback` panel 및 PTY fallback callback을 호출하지 않는 회귀 테스트를 추가했다.
- 확인: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t OQ-60` 통과(1 file, 2 tests selected). 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 문서 동기화 — HANDOFF OQ-56 잔여 범위 현재화

- `HANDOFF.md`의 시작 전 확인 섹션이 아직 provider-backed `@` source와 image attach button을 OQ-56 후속 예시로 안내하고 있었다. 현재 구현은 workspace file + Codex `fuzzyFileSearch`/`skills/list` `@` mention, resource action button, image file 선택/paste/drop/reference token 경로를 이미 닫았으므로 13 OQ-56과 충돌했다.
- HANDOFF의 해소 예시는 현재 구현 범위로 넓히고, 열린 OQ-56 예시는 ACP resource source, provider-backed richer image source, `$` composer 후속으로 좁혔다. 문서 동기화만 수행했고 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — OQ-56 image reference token

- image attach/paste/drop UI는 이미 data URI `AgentContent.image`를 전송했지만, text draft 안에는 provider가 읽을 수 있는 위치 참조 token이 남지 않았다. `AgentComposer`가 non-empty draft에 locale 기반 `[Image #N]`/`[이미지 #N]` reference token을 삽입하고, attachment chip에도 같은 token을 표시하도록 보강했다. file picker는 draft 끝에 붙이고, paste/drop은 async file read 전에 보존한 textarea selection 위치에 삽입한다. image-only prompt는 기존처럼 token 없이 허용한다. attachment 제거 시 대응 token을 draft에서 제거하고 남은 attachment/token은 현재 prompt 순서로 재번호 매김하며, prompt 전송 후 다음 prompt는 다시 #1부터 시작한다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts -t "image reference"`가 non-empty draft에 token이 추가되지 않아 실패했고, cursor 보존 케이스는 `-t "textarea cursor"`에서 paste token이 draft 끝에 붙어 실패했다. 이후 추가 RED로 `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts -t "renumbers remaining image references|starts image reference numbering"`가 삭제 후 남은 token이 `[Image #2]`로 남고 다음 prompt도 `[Image #2]`에서 시작해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts -t image` 통과(1 file, 7 tests selected), `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts -t "renumbers remaining image references|starts image reference numbering"` 통과(1 file, 2 tests selected), `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts` 통과(1 file, 29 tests), `npm run test -- src/lib/features/agent-runtime src/lib/i18n/key-parity.test.ts` 통과(35 files, 410 tests), `npm run check:frontend` 통과(svelte-check 0 errors/0 warnings + Vite build OK, 기존 chunk-size warning만), 변경 파일 `git diff --check` 통과. 실제 Windows 앱 E2E와 앱 launch는 현재 scope에서 명시되지 않아 실행하지 않았다.

## 2026-06-29 보강 — OQ-56 Codex skills/list @mention source

- Codex `skills/list`는 `/` slash command source가 아니라 `@` skill mention source로 문서화되어 있었지만, 실제 `searchResources`는 `fuzzyFileSearch` file 후보만 반환했다. skill 후보를 단순 file resource로 섞으면 outbound가 `UserInput.mention`으로 내려가 skill 의미가 사라지므로, 후보와 `AgentContent.resource`에 optional `resourceKind:"skill"`/`text:<skill name>` metadata를 보존했다.
- Codex adapter `searchResources`가 `fuzzyFileSearch{query, roots:[workDir], cancellationToken:null}`와 `skills/list{cwds:[workDir]}`를 함께 조회한다. enabled skill 중 query가 name/description/short description에 매칭되는 항목은 `application/vnd.codex.skill` resource suggestion으로 정규화하고, composer 선택 후 Codex outbound mapper가 `UserInput{type:"skill", name, path}`로 전송한다. 기존 workspace fallback과 file mention 경로는 유지한다.
- RED: `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.test.ts src/lib/features/agent-runtime/view/AgentComposer.test.ts -t "skill resource|skills/list|Codex skill"`가 `skills/list` 호출 부재, composer skill metadata 손실, `resourceKind:"skill"`의 mention 오매핑으로 실패했다(3 failed).
- GREEN: 같은 targeted suite가 통과했다(3 files, 3 tests selected). 추가 확인으로 `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.test.ts src/lib/features/agent-runtime/view/AgentComposer.test.ts` 통과(3 files, 94 tests), `npm run test -- src/lib/features/agent-runtime src/lib/i18n/key-parity.test.ts` 통과(35 files, 405 tests), `npm run check:frontend` 통과(svelte-check 0 errors/0 warnings + Vite build OK, 기존 chunk-size warning만), 변경 파일 `git diff --check` 통과. 실제 Windows 앱 E2E와 앱 launch는 현재 scope에서 명시되지 않아 실행하지 않았다.

## 2026-06-29 보강 — OQ-56 Codex fuzzyFileSearch resource source

- `@` file/resource mention은 workspace file search fallback만 쓰고 있어, 13 OQ-56의 Codex provider-backed `fuzzyFileSearch` source가 계속 후속으로 남아 있었다.
- `AgentRuntimePort`에 optional `searchResources(sessionHandle,{query,workDir,limit})`를 추가하고, controller가 현재 세션/workDir으로 프록시하게 했다. Codex adapter는 `fuzzyFileSearch{query, roots:[workDir], cancellationToken:null}`를 호출해 `FuzzyFileSearchResult`를 file URI resource suggestion으로 정규화한다. `AgentTranscriptSurface`는 provider 결과를 우선 쓰고, 결과가 없거나 실패하면 기존 `searchSessionFiles` workspace fallback을 유지한다.
- RED: `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.test.ts src/lib/features/agent-runtime/controller/agent-runtime-controller.test.ts src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "resource search|provider-backed"`가 `searchResources` 부재로 실패했다(3 failed).
- GREEN: 같은 targeted suite가 통과했다(3 files, 3 tests selected). 추가 확인으로 관련 전체 테스트 `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.test.ts src/lib/features/agent-runtime/controller/agent-runtime-controller.test.ts src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts` 통과(3 files, 88 tests), `npm run test -- src/lib/features/agent-runtime src/lib/i18n/key-parity.test.ts` 통과(35 files, 402 tests), `npm run check:frontend` 통과(svelte-check 0 errors/0 warnings + Vite build OK, 기존 chunk-size warning만), 변경 파일 `git diff --check` 통과. 당시 08/11/12/13/15 문서는 Codex `fuzzyFileSearch`를 구현 범위로 옮겼고, Codex `skills/list`는 같은 날 별도 보강에서 구현 범위로 옮겼다. ACP resource source, provider-backed richer image resource source, `$` trigger는 OQ-56 후속으로 남긴다.

## 2026-06-29 보강 — OQ-56 image paste/drop composer UI

- image attach UI는 file picker만 연결되어 있었고, 08/11/13 문서도 paste/drop을 후속으로 남기고 있었다.
- `AgentComposer`가 `ClipboardEvent`/`DataTransfer`에서 image file만 추출해 기존 data URI attachment 경로를 재사용하도록 보강했다. `capabilities.image=true`이고 입력 가능할 때만 paste/drop을 소비하며, 일반 text paste와 non-image drag/drop은 기본 동작을 유지한다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts`가 pasted/dropped image attachment 부재로 실패했다(2 failed).
- GREEN: 같은 targeted suite가 통과했다(1 file, 23 tests). 추가 확인으로 `npm run test -- src/lib/features/agent-runtime src/lib/i18n/key-parity.test.ts` 통과(35 files, 399 tests), `npm run check:frontend` 통과(svelte-check 0 errors/0 warnings + Vite build OK, 기존 chunk-size warning만), 변경 파일 `git diff --check` 통과. 08/11/13 문서는 file 선택·paste·drop이 구현 범위이고, provider-backed richer image resource source는 후속임을 반영했다.

## 2026-06-29 보강 — Claude permission test-mode mock 추가

- 12 T2.5가 요구한 Claude `session/request_permission` 최소 시나리오가 backend test-mode mock에는 없고 adapter/fixture 단위에만 존재했다. Rust mock의 `session/prompt` 입력이 approval/permission 문구를 포함하면 `tool_call` → `session/request_permission`을 emit하고, permission 응답 후 `tool_call_update` + 원래 `session/prompt` response를 반환하도록 보강했다.
- deterministic handshake/lifecycle fixture 우선 재생과 prompt/approval generator fallback의 경계를 07/11/12 및 fixture format 문서에 맞췄다. “mock은 fixture만 줄 단위 재생”처럼 구현보다 강한 문구는 제거하고, fixture 우선 + dynamic fallback 계약으로 정리했다.
- E2E spec에 Claude `request_permission` allow 경로를 추가했다. 실제 Windows 앱 E2E 실행은 아직 수행하지 않았다.

## 2026-06-29 문서 동기화 — OQ-28 stale 결정 라벨 정리

- 13 OQ-28은 secret env를 launch argv로 넘기지 않는 C1 보안 경계로 이미 해소되어 있었지만, 09 §5.3에 미해결 상태와 해소 상태를 동시에 말하는 모순된 라벨이 남아 있었다.
- 09 §5.3의 해당 주석을 `확정 / 후속 노출 범위`로 낮췄다. v1은 secret env 주입 UI/설정을 노출하지 않고 provider의 WSL 측 자체 인증에 의존하며, gateway 등 후속 범위에서 secret 전달이 필요해질 때도 `Command::env()` + `WSLENV` argv 비경유 경로만 허용한다.
- 문서 동기화만 수행했다. 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 문서 동기화 — OQ-27 WSL cwd 경계 해소

- 06/07 문서와 Rust 구현은 이미 provider 공통 cwd 경계를 `wsl.exe -d <distro> --cd <wslWorkDir>`로 고정하고 있었지만, 13 OQ-27만 해소 상태로 표시되지 않았다.
- 13 OQ-27을 `해소됨, v1 wsl --cd`로 낮추고, 07 §5.1의 잔여 확인 문구도 `--cd` 미지원 예외가 발견될 때만 provider CLI cwd flag fallback을 여는 표현으로 맞췄다. 근거는 `process::build_wsl_command`의 `--cd <workDir>` argv 조립과 `agent_runtime::tests`의 `--cd` 포함/WSL absolute path 정규화 검증이다.
- 문서 동기화만 수행했다. 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 문서 동기화 — 구현 완료 상태 반영

- 08 §7.4의 command output embed를 xterm 선택 미확정 상태에서 현재 `CommandOutputCard` 경량 read-only 렌더 채택 상태로 낮췄다. FE-16의 앱 단축키 비가로채기 전제와 맞춘다.
- 08 §8과 `research/codebase-frontend.md`의 `agentRuntime` i18n namespace 부재 문구를 현재 `en.ts`/`ko.ts` 및 `key-parity.test.ts` 상태로 맞췄다.
- 09 §0의 예시 문구를 현재 OQ-36/OQ-38 allowlist 확정, OQ-51 v1 in-memory audit 확정 상태에 맞게 좁혔다. 영속 audit 로그의 저장소/retention/포맷만 후속 enhancement로 남긴다.
- 12 T2.0은 현재 Phase 2 진입 gate가 아니라 완료된 선행 결정 기록으로 읽히게 정리했다. research frontend의 transport 미확인 항목도 조사 당시 스냅샷임을 명시하고 현재 정본 문서/구현 경계를 가리키게 했다.
- 문서 동기화만 수행했다. 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 문서 동기화 — fallback trigger 기준 현재화

- 14 §8에 남아 있던 fallback trigger 미확정 문구를 현재 `AgentTranscriptSurface`/`RuntimeFallbackController` 구현 기준으로 낮췄다. v1은 자동 fallback을 금지하고, fresh direct start 실패(`startSession` reject) 때만 fallback panel을 표시한다.
- cold restore의 provider resume/load 실패는 먼저 복원 불가 notice + fresh direct start로 낮추며, 그 fresh start까지 실패할 때만 fallback panel을 표시한다. 사용자가 PTY fallback을 선택하면 실패 controller shutdown/registry cleanup을 기다린 뒤 `onFallbackToPty`에 session context를 넘긴다.
- `usageLimitExceeded` 같은 provider runtime error는 recoverable error event 경로이고 fresh start 실패 trigger가 아니므로 PTY fallback panel을 자동 표시하지 않는다고 명시했다. post-start fatal/exit는 현재 failure/exit notice 경로로 남긴다.
- 문서 동기화만 수행했다. 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 문서 동기화 — ACP auth sequence 현재화

- 14 §2의 ACP start sequence에 남아 있던 `authMethods` 기반 `authenticate` 자동 삽입 필요 문구를 현재 OQ-43 결론과 구현 기준으로 낮췄다.
- v1 `DEFAULT_CLIENT_CAPABILITIES`는 terminal/gateway auth를 광고하지 않고, `claude-acp-adapter`는 initialize 응답의 `authMethods`를 파싱한 뒤 자동 `authenticate` 없이 `session/new`를 시도한다.
- 자격 부족으로 `session/new`가 `-32000` 등으로 실패하면 `startSession` 실패(`authentication required`)로 표면화되어 fallback 선택 UI 경로에 들어간다. gateway `authenticate`나 terminal login passthrough는 secret 전달/redaction/audit UX를 설계하는 후속 scope다.
- 문서 동기화만 수행했다. 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 재분류 — post-start fatal recovery / failure-code taxonomy

- 14 §8의 fallback trigger는 fresh direct start 실패(`startSession` reject)와 provider restore 실패 후 fresh start까지 실패한 경우로 한정했다. `usageLimitExceeded`는 recoverable error event이고, post-start `agent-runtime-exit`/`recoverable:false`는 현재 실패/종료 notice 경로다.
- post-start fatal/exit를 PTY fallback panel로 승격할지와 실패 원인을 stable error-code enum으로 계약화할지는 현재 구현 계약이 아니므로 13 OQ-60으로 등록했다.
- 11 §9도 같은 경계로 맞췄다. E2E-6/FE fallback은 start 실패 범위만 검증하고, post-start notice/cleanup은 CX-19/CL-25/RS-5b 경계로 유지한다.
- 문서 동기화만 수행했다. 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 문서 동기화 — HANDOFF 구현 진행 상태 현재화

- `HANDOFF.md`의 첫머리와 마지막 섹션에 남아 있던 초기 설계-only 산출물 문구를 현재 구현 진행 상태에 맞췄다.
- 이어가기 절차는 12 Phase를 반복 구현하라는 지시가 아니라, `impl-log.md`/11 §8·§9/13 레지스트리와 현재 worktree를 먼저 확인한 뒤 남은 OQ·검증 slice를 진행하는 흐름으로 정리했다.
- 열린 OQ 예시 목록에 OQ-60(post-start fatal recovery UX / typed failure-code taxonomy)을 추가했다.
- 문서 동기화만 수행했다. 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 문서 동기화 — S2 serde OQ-37 해소 상태 반영

- 15 §8.2의 S2 주석이 아직 `rename_all_fields` 지원 여부를 구현 전 확인해야 하는 결정 필요 항목처럼 설명하고 있었다.
- 현재 `src-tauri/Cargo.lock`은 serde `1.0.228`이고 13 OQ-37/11 RS-21..RS-25/`agent_runtime::tests`가 `rename_all_fields = "camelCase"` 사용과 camelCase round-trip을 고정한다.
- 15의 S2 문구를 현재 구현 정본에 맞춰 OQ-37 해소 상태로 낮췄다. 문서 동기화만 수행했고 앱 launch/Windows E2E는 수행하지 않았다.

## 2026-06-29 문서 동기화 — Phase 0 scaffold 현재화

- 12 §Phase 0/T0.1이 현재 구현 브랜치에서도 빈 scaffold를 새로 만드는 지시처럼 읽힐 수 있어, 초기 완료 기록과 현재 구현 상태를 분리했다.
- Phase 0은 코드 동작을 만들지 않는 초기 gate였고 app launch 대상이 아니었지만, 현재 브랜치는 이후 Phase 구현이 진행된 상태이므로 기존 `agent-runtime`/`agent_runtime` 파일을 빈 스텁이나 TODO scaffold로 되돌리지 말라고 명시했다.
- 문서 동기화만 수행했다. 기능 동작 변경, 앱 launch, Windows E2E는 수행하지 않았다.

## 2026-06-29 문서 동기화 — T0.6 persistence 결정 현재화

- 12 T0.6이 `runtimeKind`/`agentRuntime` migration을 설계만 하고 실제 코드는 Phase 6에서 나중에 작성하는 초기 계획으로만 남아 있었다.
- 현재 구현은 TS/Rust persistence 타입, frontend snapshot/restore, backend `sanitize_workspace_for_persist`, history 경계에 direct runtime metadata와 secret scrub을 반영한 상태다. OQ-16/OQ-18은 13에서 해소됐고, 앱 재시작 후 direct 대화 복원은 v1 범위 밖이다.
- T0.6을 초기 결정 task + 현재 구현 상태로 분리하고, legacy default/metadata round-trip/scrub 검증 근거를 연결했다. 문서 동기화만 수행했고 앱 launch/Windows E2E는 수행하지 않았다.

## 2026-06-29 문서/테스트 동기화 — fixture replay 목록 현재화

- 실제 fixture corpus에는 `codex/codex-initialize.jsonl`과 `claude-acp/claude-initialize.jsonl` hello-world handshake fixture가 있는데, 11 §1.4 표는 rich 시퀀스 fixture만 나열하고 있었다.
- 11 §1.4에 FR-CX-0/FR-CL-0을 추가하고, `codex-fixture-replay.test.ts`/`claude-acp-fixture-replay.test.ts` describe 제목도 `FR-CX-0..4`/`FR-CL-0..4` 범위로 맞췄다.
- 기능 동작 변경은 없고 fixture 목록·테스트 설명 동기화만 수행했다. 앱 launch/Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — slash command 중복 정규화

- provider가 `/Resume`처럼 선두 slash와 대소문자가 다른 command name을 광고하면 로컬 `/resume` fallback과 팔레트에서 중복될 수 있었다. 표시/전송 casing은 provider 값을 보존하되, fallback 추가 여부와 중복 판단은 case-insensitive key로 처리하도록 `AgentComposer`를 보강했다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts -t "deduplicates provider command names"`가 `/Resume` + 로컬 `/resume` 2개를 관측해 실패했다.
- GREEN: 같은 targeted test 통과. 추가 확인으로 `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts` 통과(19 tests), `npm run test -- src/lib/features/agent-runtime` 통과(34 files, 391 tests), `npm run check:frontend` 통과(svelte-check 0 errors/0 warnings + Vite build OK, 기존 chunk-size warning만), 변경 파일 `git diff --check` 통과. 실제 Windows 앱 E2E와 앱 launch는 수행하지 않았다.

## 2026-06-29 보강 — OQ-58 현재/후속 용어 정리

- 08 §3/§5가 `streamingItemId`를 현재 DOM 가상화 강제 포함 규칙처럼 설명하던 표현을 낮췄다. v1 `MessageList`는 scroll-window DOM 가상화가 아니라 residency eviction으로 bounded된 `visibleItemIds`를 그대로 mount한다.
- `streamingItemId`는 현재 streaming item 추적/auto-follow 보조 표면이고, `streamingItemId`+바닥 N개 always-mount는 DOM 가상화를 도입하는 후속 단계의 불변식으로 명시했다. 코드 주석도 같은 경계로 맞췄다.
- 확인: 문서/주석 정리만 수행했다. 기능 동작 변경과 앱 launch/E2E는 수행하지 않았다.

## 2026-06-29 보강 — OQ-56 image attachment composer UI

- `SessionStartResult.composerCapabilities.image`가 store까지 전달되지만 composer UI가 이를 소비하지 않아 image-capable provider에서도 image prompt를 보낼 방법이 없었다.
- `AgentComposer`에 capability-gated image attach button + hidden file input을 추가했다. `capabilities.image=true`일 때만 control을 렌더하고, 선택한 `image/*` file은 data URI로 읽어 `AgentContent{type:"image", uri, mimeType}`로 전송한다. image-only prompt도 send 가능하게 했다. file size cap은 기존 clipboard image cap을 재사용한다.
- `AgentTranscriptSurface`는 store `capabilities`를 composer prop으로 전달한다. 테스트는 composer 단위에서 image control 노출/미노출과 image-only 전송을, surface 단위에서 start result capability가 composer button까지 이어지는 경로를 고정한다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts`가 image button/input 부재로 실패했다(2 failed). GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts` 통과(2 files, 66 tests).

## 2026-06-29 보강 — OQ-59 public diagnostic 경계 확정

- OQ-59를 v1 internal raw bridge 정책으로 확정했다. `agent-runtime-message`는 provider adapter routing/normalization을 위한 raw `JsonRpcMessage` bridge로 유지하고, 화면·저장·diagnostic 파일에는 redacted projection만 노출한다.
- `createAgentTransportController`는 public diagnostic helper로만 두고 stderr/exit/error/backpressure 4개 channel만 구독하게 했다. raw `message` handler는 `AgentTransportHandlers`에서 제거해 adapter 외부 구독 경계를 닫았다.
- RED: `transport.test.ts`에서 public controller의 raw `agent-runtime-message` 미구독을 요구하자 기존 구현이 5개 listen을 등록해 실패했다(expected 4, received 5).
- GREEN: `transport.ts`에서 raw message 구독을 제거한 뒤 `npm run test -- src/lib/features/agent-runtime/service/transport.test.ts`가 통과했다(1 file, 10 tests). 후속 문서 동기화 후 `runtime-port-factory.test.ts`까지 포함한 targeted suite와 frontend check를 다시 실행한다.

## 2026-06-29 문서 동기화 — state/reducer 파일명 현재화

- 03/14 문서에 남아 있던 초기 `createAgentRuntimeState()` / `agent-runtime-state.svelte.ts` / `service/transcript-reducer.ts` 표기를 현재 구현 파일인 `createAgentRuntimeStore()` / `state/agent-runtime-store.svelte.ts` / `controller/agent-event-reducer.ts`로 맞췄다.
- Codex/Claude adapter 위치도 현재 `src/lib/features/agent-runtime/adapters/{codex,claude-acp}/` 기준으로 정리했다. research snapshot의 초기 배치안은 원 조사 기록으로 두고, 정본 아키텍처/시퀀스 문서만 현재 구현과 맞췄다.
- 09 보안 다이어그램의 store 라벨도 `agent-runtime-store`로 맞추고, 03 모듈맵에서 현재 존재하지 않는 별도 `contracts/composer.ts` 항목을 제거했다. composer 상태는 현재 `agent-runtime-store.svelte.ts`와 `AgentComposer.svelte` props/action 경계에 통합되어 있다.

## 2026-06-29 재분류 — 남은 게이트

- 11 §8의 미체크 항목은 현재 모두 실제 Windows 앱 E2E 실행(E2E-6/7/9/10 및 기존 PTY E2E) 또는 provider wire 실측/운영 튜닝 후속에 묶여 있다. 이 턴에서는 AGENTS.md current scope 제한에 따라 앱 launch/Windows E2E를 수행하지 않았다.
- 13 레지스트리의 주요 잔여 구현 외부 의존 항목은 Codex reasoning 권위 필드 wire 실측(OQ-46), same-turn late notification wire 실측(OQ-53), Codex `thread/read(includeTurns)` response 범위 실측(OQ-54), 대용량 세션 운영 튜닝(OQ-52), ACP resource source·provider-backed richer image source·`$` composer 후속(OQ-56), DOM 가상화 도입 시 튜닝(OQ-58)이다.
- 단위 테스트·문서 검색으로 닫을 수 있는 stale 구현명(`agent-runtime-state`, `createAgentRuntimeState`, `transcript-reducer`, `OQ-51 미결`, 현재 DOM 가상화로 읽히는 주석)은 정리했다.
- 12 T0.3의 `generate-ts` 제공 여부 미확정 문구도 현재 OQ-41 결론에 맞춰 낮췄다. 현재 브랜치는 `codex app-server generate-ts --out` 제공을 확인하고 generated 타입을 vendoring한 상태이며, 수기 `contracts/codex-wire.ts` fallback은 dependency refresh 때의 비상 경로로만 남긴다.
- 05 Codex adapter 문서의 OQ-07/OQ-11 옛 unverified 문구도 H4 결론에 맞췄다. v1은 generated `ClientInfo`/`InitializeCapabilities` 타입 기준으로 최소 `clientInfo` + `capabilities:null`을 보내고, `initialize` 응답 뒤 `initialized` notification을 항상 보낸다.
- 06 Claude ACP 미확인 섹션의 OQ-36 node/entry resolver 항목과 OQ-04 audio 항목도 현재 레지스트리 상태에 맞췄다. resolver/cache/entry 탐색은 `agent_runtime/resolver.rs` 정본으로 해소됐고, 배포 대상 binary 차이는 OQ-10에만 남긴다. audio는 v1 미지원 capability지만 inbound raw JSON 보존으로 해소됐다.

## 2026-06-29 보강 — OQ-56 resource action button

- workspace file `@` mention은 구현되어 있었지만 사용자가 직접 `@query`를 타이핑해야만 resource palette에 진입할 수 있었다. `AgentComposer`에 resource action button을 추가해 `resourceSearch` source가 있을 때만 버튼을 표시하고, 입력 가능 상태에서 클릭하면 draft 끝에 `@` token을 열어 기존 파일/리소스 팔레트 흐름으로 진입하게 했다.
- 버튼은 `agentRuntime.composer.resourceButton` i18n 키와 `agentComposerResourceButton` test id를 사용한다. `resourceSearch` source가 없으면 버튼을 렌더하지 않고, 입력 잠김 상태에서는 비활성화한다. 당시 범위는 workspace file link-only resource 진입 보강이었고, 이후 image file 선택/paste/drop/reference token UI와 Codex `fuzzyFileSearch`/`skills/list` source가 추가됐다. ACP resource source, provider-backed richer image resource source, `$` trigger는 OQ-56 후속으로 남긴다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts -t "resource action button"`가 `agent-composer-resource-button` 부재로 실패했다.
- GREEN: 같은 targeted test 통과. 추가 coverage로 no-source 버튼 미노출과 입력 잠김 상태 버튼 비활성화를 고정했다. 추가 확인으로 `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts` 통과(18 tests). 실제 Windows 앱 E2E와 앱 launch는 수행하지 않았다.

## 2026-06-29 보강 — OQ-52 transcript memory v1 cap 현재화

- OQ-52를 "모든 수치 미확정"으로 두던 표기를 현재 구현과 맞췄다. v1 기본 cap은 `HOT_WINDOW_SEALED_TURNS=50`, `HOT_WINDOW_BYTES=8MiB`, `TOMBSTONE_LRU=200`, `SEAL_QUIESCENCE_GRACE_MS=250`로 고정되어 있고, reducer는 sealed turn count cap과 byte cap을 모두 적용한다.
- 현재 테스트는 turn-count overflow, byte cap overflow, terminal stderr byte 포함, tombstone LRU pruning, reactive surface bounded, sealed-retained late patch/reseal, evicted-tombstone late drop을 검증한다. 남은 OQ-52 범위는 실제 대용량 세션에서 운영값을 조정할지와 heavy item(diff/image/output)별 별도 ring/summary 표현 한도가 필요한지에 대한 성능 튜닝이다.
- 확인: `npm run test -- src/lib/features/agent-runtime/controller/agent-event-reducer.test.ts -t "NM-31|NM-32|NM-33|NM-34|NM-35"` 통과(16 tests), `npm run test -- src/lib/features/agent-runtime/state/agent-runtime-store.svelte.test.ts -t "NM-31b"` 통과(2 tests). 실제 Windows 앱 E2E와 앱 launch는 수행하지 않았다.

## 2026-06-29 보강 — OQ-51 approval audit v1 범위 해소

- OQ-51은 v1 기본 audit 저장 위치·보존기간·포맷 결정을 필요로 하던 항목이었다. 현재 구현의 기본 audit은 `AgentRuntimeStore` 수명 안의 in-memory `ApprovalAuditTrail`이며, store `dispose()`에서 clear되고 디스크/workspace/history에는 영속하지 않는다.
- 레코드 포맷은 `sessionHandle`/`provider`/`requestId`/`optionId`/`optionKind`/`toolCallId`/`outcome`/`decidedAt`/`decidedBy` 메타만 포함한다. `ApprovalAuditInput`/`ApprovalAuditEntry` 타입에는 명령 전문, credential, 파일 내용, raw label 필드가 없고, 영속 redacted audit log는 v1 기본 구현에서 제외해 후속 enhancement로 남긴다.
- 확인: `npm run test -- src/lib/features/agent-runtime/state/agent-runtime-store.svelte.test.ts -t audit` 통과(4 tests). 실제 Windows 앱 E2E와 앱 launch는 수행하지 않았다.

## 2026-06-29 보강 — OQ-16 cross-restart direct restore 범위 해소

- OQ-16은 "direct 대화 cross-restart 복원을 구현할지"가 아니라 v1 범위 결정을 필요로 하던 항목이었다. 현재 구현은 15 §7.3 scrub 경계를 유지해 `providerSessionId`/`providerThreadId`/`providerResumeToken`을 디스크 저장 직전에 제거하고, scrub된 cold-restore metadata는 `resumeSession` 없이 새 direct session으로 낮춘다.
- FE-24b/FE-24c는 scrub metadata와 provider resume/load 실패 모두에서 "이전 대화를 복원할 수 없음" notice + fresh direct start를 검증한다. 실패 resume attempt의 metadata patch/replay transcript도 fresh start에 섞이지 않는다.
- 확인: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "cold-restore|provider resume fails|failed resume attempt|replay transcript events from a failed resume"` 통과(4 tests), `npm run test -- src/lib/features/workspace/session-store-snapshot.test.ts -t "runtimeKind|direct runtime metadata"` 통과(2 tests), `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime_secrets` 통과(2 tests). 실제 Windows 앱 E2E는 수행하지 않았다.

## 2026-06-29 보강 — OQ-15 websocket authToken reject-before-log gate 해소

- backend 구현과 테스트를 재대조했다. `AgentRuntimeStartParams::Websocket`은 future-sketch 타입으로 유지하지만, `allowlist::validate_and_extract`와 test-mode mock provider는 params 전체를 직렬화하지 않고 `only jsonrpc-stdio transport is supported in v1` 정적 에러로 즉시 거부한다.
- `agent_runtime::tests` RS-12c/RS-18은 `authToken:"secret-xyz"`가 에러 문자열에 평문으로 들어가지 않음을 고정한다. RS-12c는 `validate_launch_for_start` 경로의 `agent-runtime-audit.log`도 확인해 `transportKind:"websocket"`/정적 reason만 남고 `authToken`/token 값/url이 남지 않음을 검증한다. 09 §5는 `authToken`을 secret scrub/redaction 집합에 포함하고, 11 §8.5는 token 로그·snapshot·audit 비노출 체크를 닫고 있다.
- 13 OQ-15를 v1 gate 해소 상태로 갱신했다. 실제 websocket wire/framing/auth 저장 정책은 websocket 구현을 시작하는 후속 scope이며, 이 턴에서는 GUI launch/Windows E2E를 수행하지 않았다.

## 2026-06-29 보강 — OQ-21/22 Codex command output 채널 범위 해소

- generated schema를 재확인했다. thread 채널 `CommandExecutionOutputDeltaNotification`은 `{threadId, turnId, itemId, delta}`만 갖고 `stream` 필드가 없다. standalone `CommandExecOutputDeltaNotification`에만 `stream`/`deltaBase64`가 있으므로, v1 thread command output은 `stdout` 고정이 정본이고 standalone 채널은 OQ-21 후속 범위다.
- `codex-wire-mapper.test.ts`에 CX-9를 보강해 standalone `command/exec/outputDelta`가 `command_output_delta`로 오인되지 않고 raw 보존+unknown counter로만 처리됨을 고정했다. 04/05/13 문서도 v1은 thread 채널만 지원하고 standalone 채널은 후속 scope라는 경계로 맞췄다. 확인: `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts` 통과(1 file, 39 tests). GUI launch/Windows E2E는 수행하지 않았다.

## 2026-06-29 보강 — CX-4c Codex empty prompt guard

- Codex `sendPrompt`가 `mapAgentContentToUserInput(input.content)` 결과가 `[]`인 경우에도 `turn/start{input:[]}`를 보낼 수 있었다. image input 미opt-in처럼 모든 content가 provider input에서 제외되는 prompt는 실제 turn이 아니므로, ACP의 빈 `session/prompt` 방어와 같은 전송 경계가 필요했다(05 §5.3d, 08 §6.4, 11 CX-4c).
- `codex-app-server-adapter.test.ts`에 CX-4c를 추가했다. RED 확인: guard 추가 전 targeted 테스트가 `turn/start` 전송 여부 assert에서 실패(expected false, received true). 구현은 `codexInput.length === 0`이면 recoverable `error` event만 emit하고 `turn/start`/running 전이/active turn 생성을 하지 않는다.
- GREEN/재검증: `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.test.ts` 통과(1 file, 28 tests), `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts` 통과(1 file, 38 tests), `npm run test -- src/lib/features/agent-runtime` 통과(34 files, 386 tests), `npm run check:frontend` 통과(svelte-check 0 errors/0 warnings + Vite build OK, 기존 chunk-size warning만). GUI launch/Windows E2E는 수행하지 않았다.

## 2026-06-29 재개 점검 — non-E2E gate 재확인

- 계획 문서 11 §8의 남은 체크박스를 재분류했다. 현재 미체크 항목은 legacy/direct Windows 앱 E2E(E2E-6/7/9/10, 기존 PTY E2E) 또는 provider wire 실측/운영 튜닝 후속 경계이며, 이 턴에서 앱 launch/Windows E2E는 AGENTS.md current scope 제한에 따라 수행하지 않았다.
- 현재 코드 기준으로 frontend agent-runtime 단위 경계와 backend agent_runtime 경계를 재검증했다. 이전 slice에서 `npm run check:frontend` 통과(svelte-check 0 errors/0 warnings + Vite build OK, 기존 chunk-size warning만)와 `cargo check --manifest-path src-tauri/Cargo.toml` 통과를 확인했다. 이어서 2026-06-29 당시 워크트리 기준으로 `npm run test -- src/lib/features/agent-runtime` 통과(34 files, 390 tests), `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime` 통과(63 tests)를 재확인했다. 이후 slash command 중복 정규화 보강으로 frontend agent-runtime 테스트 수는 391개가 됐다(위 섹션).
- OQ-56 content capability gate, OQ-59 raw bridge channel guard, CX-18a/19a session-level runtime ref 보존 경계를 코드/테스트와 대조했다. 추가 구현 결함은 확인되지 않았고, 다음 검증 slice는 명시적 앱 실행 허가 후 Windows E2E 또는 provider wire 실측이다.

## 2026-06-28 보강 — CX-18a/19a Codex session-level runtime ref 보존

- Codex adapter의 session-level runtime event가 시작된 세션의 `threadId`/`sessionId`를 알고도 `error`와 `process_exited`를 `{provider:"codex"}`만으로 emit하고 있었다. 04 §3.6의 notice dedup은 라우팅 키/session 키에 기대고, 15 §1은 provider 원본 id 보존을 요구하므로 알려진 provider ref를 축약하면 안 된다.
- `CodexSessionRuntime`에 `sessionHandle`을 보관하고, runtime `error`/backpressure/exit emit 시 `CodexRouting`의 handle→threadId와 threadId→sessionId를 조회해 event `ref`에 반영했다. thread/start 또는 resume 전에 죽어 아직 ref를 모르는 초기 runtime event는 기존처럼 provider-only fallback을 유지한다.
- 테스트는 `codex-app-server-adapter.test.ts`에 CX-18a/CX-19a를 추가했다. RED 확인: 같은 파일 테스트가 각각 1 fail(`error.ref`/`process_exited.ref`가 `{provider:"codex"}`만 포함)로 실패. GREEN 확인: `npm run test -- src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.test.ts` 통과(1 file, 27 tests). GUI launch/Windows E2E는 수행하지 않았다.

## 2026-06-28 보강 — NM-33e/f duplicate notice no-op

- `error`와 비정상 `process_exited`도 notice dedup 전에 `admitForPatch`를 호출해, 이미 notice가 있는 sealed-retained turn을 중복 이벤트만으로 다시 unseal할 수 있었다. 이는 04 §3.6의 "notice dedup·멱등"과 04 §3.7의 "late patch일 때만 unseal" 경계를 섞는 문제다.
- reducer는 이제 evicted tombstone이면 먼저 drop 카운트를 올리고, 그 외에는 notice id가 이미 있으면 no-op으로 빠진다. 새 notice가 실제로 생길 때만 sealed-retained를 unseal한다. 이로써 tombstone late drop(NM-34c/34d)은 유지하면서 duplicate notice telemetry overcount를 막는다.
- 테스트는 `agent-event-reducer.test.ts`에 NM-33e(error)와 NM-33f(process_exited)를 추가했다. RED 확인: 같은 파일 테스트가 2 fail(NM-33e/NM-33f, sealed-retained→unsealed)로 실패. GREEN 확인: `npm run test -- src/lib/features/agent-runtime/controller/agent-event-reducer.test.ts` 통과(1 file, 39 tests), `npm run test -- src/lib/features/agent-runtime` 통과(34 files, 384 tests). GUI launch/Windows E2E는 수행하지 않았다.

## 2026-06-28 보강 — NM-33d duplicate completed no-op

- `turn_completed` late-event gate를 notice 보강까지 확장한 뒤, 중복 `turn_completed{status:"completed"}`도 불필요하게 sealed turn을 unseal할 수 있는 경계를 확인했다. body/notice/cancel 변경이 없는 중복 종료 event는 patch가 아니므로 reseal telemetry를 올리면 안 된다.
- `applyTurnCompleted`는 이제 새 warning notice를 만들거나 열린 tool call을 cancelled로 닫는 경우에만 sealed-retained turn을 `admitForPatch`로 unseal한다. 중복 completed처럼 body 변화가 없는 종료 event는 no-op으로 둔다. evicted tombstone은 기존 late-event 규칙대로 drop 카운트만 증가한다.
- 테스트는 `agent-event-reducer.test.ts`에 NM-33d를 추가했다. RED 확인: 같은 파일 테스트가 1 fail(NM-33d, sealed-retained→unsealed)로 실패. GREEN 확인: `npm run test -- src/lib/features/agent-runtime/controller/agent-event-reducer.test.ts` 통과(1 file, 37 tests), `npm run test -- src/lib/features/agent-runtime` 통과(34 files, 382 tests). GUI launch/Windows E2E는 수행하지 않았다.

## 2026-06-28 보강 — NM-33c late turn_completed notice reseal

- 04 §3.7의 `sealed-retained` late-event 규칙을 `turn_completed`의 notice 생성 경로까지 통일했다. 기존 reducer는 `turn_completed`에서 evicted tombstone만 수동 drop하고, sealed-retained turn에는 `admitForPatch` 없이 failed/refusal/max_* notice를 붙일 수 있었다.
- `applyTurnCompleted`도 시작 시 residency gate를 통과하게 바꿔, sealed-retained turn의 늦은 failed/stopReason 보강은 unseal 후 notice를 붙이고 `resealCount`를 증가시킨다. evicted tombstone turn은 기존처럼 body/notice 없이 `droppedLateEventCount`만 증가한다.
- 테스트는 `agent-event-reducer.test.ts`에 NM-33c를 추가했다. RED 확인: 같은 파일 테스트가 1 fail(NM-33c, sealed-retained 유지)로 실패. GREEN 확인: `npm run test -- src/lib/features/agent-runtime/controller/agent-event-reducer.test.ts` 통과(1 file, 36 tests), `npm run test -- src/lib/features/agent-runtime` 통과(34 files, 381 tests). GUI launch/Windows E2E는 수행하지 않았다.

## 2026-06-28 보강 — NM-34 tombstone late notice drop

- 04 §3.7/11 §2.9의 `evicted-tombstone` late-event 규칙을 notice 생성 event까지 확장해 고정했다. 기존 reducer는 message/tool/plan/file 변경 경로에서만 `admitForPatch`를 통과했고, `error`와 비정상 `process_exited`는 tombstone turn에도 notice item을 붙일 수 있었다.
- `applyError`/`applyProcessExited`도 notice 생성 전에 residency gate를 통과하게 해, evicted tombstone turn을 가리키는 late event는 body/notice를 만들지 않고 `droppedLateEventCount`만 증가시킨다. `sealed-retained` turn은 기존 late-event 규칙대로 unseal 후 notice patch가 가능하다.
- 테스트는 `agent-event-reducer.test.ts`에 NM-34c(error)와 NM-34d(abnormal process exit)를 추가했다. RED 확인: 같은 파일 테스트가 2 fail(NM-34c/NM-34d)로 실패. GREEN 확인: `npm run test -- src/lib/features/agent-runtime/controller/agent-event-reducer.test.ts` 통과(1 file, 35 tests), `npm run test -- src/lib/features/agent-runtime` 통과(34 files, 380 tests), `npm run check:frontend` 통과(svelte-check 0 errors/0 warnings + Vite build OK). GUI launch/Windows E2E는 수행하지 않았다.

## T0.0 / OQ-41 — preflight (확인 완료)

| 항목 | baseline(문서) | 현재 환경 | 결정 |
|---|---|---|---|
| 작업 루트 | `/home/xenia/work/claudemx` | `/home/xenia/work/claudemx` | 일치 |
| git root | 동일 | `/home/xenia/work/claudemx` | 일치 |
| 브랜치 | `codex/direct-agent-runtime-docs` | `feat/agent-runtime-impl` | 구현용 신규 브랜치 |
| Codex CLI | `rust-v0.142.0` | `codex-cli 0.142.2` | 패치 diff. `generate-ts` 동작·v2 thread/turn 모델 유지 → **수용** |
| `generate-ts` | 제공 가정 | **제공됨** (`--out <DIR>`) | T0.3는 generate-ts 사용(수기 미러 fallback 불필요) |
| claude-agent-acp | `0.51.0` 핀 | npm 최신 `0.52.0` | **0.51.0 고정 유지**(RD-5/OQ-08 해소; package refresh는 OQ-41 schema diff + fixture replay 후 결정) |
| node | `v24.14.0`(조사) | `v24.11.1` | 범위 내 수용 |

## H4 — Codex wire 실측 묶음 (OQ-33 / OQ-07 / OQ-11) — 해소

`codex app-server generate-ts` 산출물(0.142.2)로 확정. 산출 타입을 `generated/codex-app-server/`에 정본 vendoring(T0.3).

- **OQ-33 (해소)**: `v2/UserInput.ts`의 `text` variant는 `text_elements: Array<TextElement>`가 **필수 필드**다. 따라서 outbound `makeTextUserInput(text)` = `{ type: "text", text, text_elements: [] }`(plain text는 빈 배열 = span 없음). `TextElement = { byteRange: ByteRange, placeholder: string | null }`. **stub-until-verified 해제** — 검증된 schema로 실구현 진행(05 §5.3d).
- **OQ-11 (해소)**: `ClientInfo`/`InitializeParams`/`InitializeCapabilities` 생성 타입 존재. 최소 `ClientInfo`(name/version) 전송 + capabilities 보수적(D12 기본값) 유지.
- **OQ-07 (기본값 유지)**: `initialize`→`initialized` 핸드셰이크는 D12 방어적 기본값(항상 수행)으로 진행.
- **wire 사실 확인**: `ServerNotification`에 `thread/started`·`turn/started`·`turn/completed`·`turn/plan/updated`·`item/started`·`item/completed`·`item/agentMessage/delta`·`item/plan/delta`·`item/commandExecution/outputDelta`·`item/fileChange/patchUpdated`·`item/reasoning/textDelta`·`item/reasoning/summaryTextDelta`·`serverRequest/resolved` 모두 존재(ref-codex §6/§7/§8과 정합). `ServerRequest`에 `item/commandExecution/requestApproval`·`item/fileChange/requestApproval`·`item/permissions/requestApproval` 존재.
- `TurnStartParams`: `{ threadId, clientUserMessageId?, input: Array<UserInput>, cwd?, approvalPolicy?, sandboxPolicy?, model?, effort?, ... }`. v1은 `threadId`/`input`만 전송, override 미설정(OQ-20).

## T2.0 — Phase 2 진입 결정 게이트

- **OQ-37 (serde, 해소)**: `src-tauri/Cargo.lock` serde `1.0.228` ≥ 1.0.181 → **`#[serde(rename_all_fields = "camelCase")]` 사용**(variant 필드 camelCase 직렬화).
- **OQ-36 (resolve owner, 결정)**: `resolve_trusted_executable(provider, distro)` / `resolve_trusted_adapter_entry(provider, distro)`의 owner 모듈 = **`agent_runtime/resolver.rs`**(allowlist.rs가 호출). 탐색: WSL distro 안에서 `command -v codex`/`command -v node`로 신뢰 절대경로 resolve, claude adapterEntryPath는 `claude-agent-acp` 패키지의 `dist/index.js`를 node_modules에서 resolve. 캐시 = `(provider, distro)` 키 in-memory(프로세스 수명; TTL 없음, miss 시 재resolve, `clear()`로 명시 무효화). resolve 실패 = `Err(String)`("codex/node not found in WSL distro <distro>"). 동명 바이너리(`/tmp/codex`·`/tmp/node`)는 절대경로 resolve로 차단.
- **OQ-38 (env key allowlist, 결정)**: 값은 non-secret 전용(RD-14). v1 기본은 secret env 미전달.
  - 공통: `RUST_LOG`, `RUST_BACKTRACE`, `NO_COLOR`
  - Codex: + `CODEX_DISABLE_UPDATE_CHECK`
  - Claude: + `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_EXECUTABLE`, `NODE_OPTIONS`
  - key 정규식 `^[A-Za-z_][A-Za-z0-9_]*$` 추가 강제. 집합 외 key는 거부. 확장은 후속.
- **OQ-39 (backpressure, 결정)**: `MAX_MESSAGE_LOG_BYTES = 8 * 1024 * 1024`(8 MiB diagnostic-only bounded replay log), `MAX_LINE_BYTES = 4 * 1024 * 1024`(4 MiB; 초과 라인 → recoverable framing error), `BACKPRESSURE_NOTIFY_INTERVAL = 256`(N drop마다 backpressure event 1회). 정책 = replay log oldest drop(실시간 emit은 throttle/block 안 함, OQ-50 후속).

## 기타 확정 기본값(13 인용)

- **OQ-25 (해소)**: 동시성 = `std::thread` + `Arc<Mutex>`(tokio 미도입).
- **OQ-26 (결정)**: `decode_utf8_stream_chunk` 공용화 = 가시성 상향(`pub(super)`→`pub(crate)`). 필요 시 `features/terminal/tests.rs` import 갱신.
- **OQ-46 (기본값)**: Codex reasoning completed 권위 = 보수적 `[...summary, ...content].join("\n")`.
- **OQ-48 (결정)**: 멀티 윈도우 registry = 단일 윈도우 소유 + `runtimeId`↔window 바인딩 + window-close 시 소유 엔트리만 정리 + cross-window dispatch 금지(§1.11 완화책 채택).
- **OQ-52 (v1 기본 cap 구현 / 실측 튜닝 후속)**: `HOT_WINDOW_SEALED_TURNS = 50`, `HOT_WINDOW_BYTES = 8 * 1024 * 1024`, `TOMBSTONE_LRU = 200`, `SEAL_QUIESCENCE_GRACE_MS = 250`. bounded eviction은 reducer/store 테스트로 고정됐고, 정확 운영값·heavy-item 표현 한도는 대용량 세션 실측 후속이다.
- **OQ-53/54 (wire 실측 후속)**: late same-turn은 seal grace로 흡수(sealed-retained patch)하고, tombstone replay는 격리 scratch replay로 구현했다. 실제 same-turn notification 도착 여부와 Codex `thread/read(includeTurns)` 범위는 provider wire 캡처로 확인한다.
- **RD-2/RD-4**: direct runtime은 실험 flag 뒤. raw protocol log 기본 off. websocket start는 로깅/스냅샷 전 reject.

---

## 구현 완료 요약 (Phase 0–7, 2026-06-26)

브랜치 `feat/agent-runtime-impl`, 커밋 `c36b97c`(P0)→`cd4aec8`(P6). 신규 소스 42 + 테스트 28 + backend Rust 7. 울트라코드 Workflow로 페이즈별 병렬/순차 분배.

| Phase | 내용 | 검증 |
|---|---|---|
| 0 | 스캐폴드, 타입 정본(15), Codex 생성 타입 vendoring, claude dep 핀, 픽스처, 게이트 결정 | svelte-check 0, cargo check |
| 1 | reducer(seal/eviction/3-상태), pending table, audit, store, router/registry, legacy-pty | vitest +55 |
| 2 | Rust wire 타입, resolver/allowlist, process spawn, JSON-RPC framing, command 6종, transport 래퍼 | cargo +112 |
| 3 | Codex app-server 어댑터(wire→AgentEvent, reconcile, approval, 삼중 키) | CX-1..20 |
| 4 | Claude ACP 어댑터(JSON-RPC 2.0, chunk/replace, permission rpcId 보존, turn 합성) | CL-1..27 |
| 5 | 데스크톱식 transcript UI(host 분기, 메시지/카드/approval/composer, 격리 replay) | vitest 732 |
| 6 | persistence(runtime_kind/agent_runtime, scrub), Claude entry resolve, launcher direct 선택, fallback | vitest 754, cargo 115 |

**최종 게이트(11 §8.6)**: `npm run verify` 통과 — vitest 754 / cargo test 115 / svelte-check 0 errors(1169 files) / vite build OK / cargo check OK. `cargo build` 바이너리 링크 성공.

**환경 제약(Phase 7 잔여)**:
- E2E(E2E-1..10)·app launch(T7.2): selenium + Windows Tauri 앱 구동 필요 → 현재 WSL 헤드리스 환경에서 실행 불가. test-mode mock(`is_test_mode`/CLCOMX_TEST_MODE)은 backend 연결됨. 빌드 게이트(check/build)는 충족. 실제 GUI smoke는 Windows 환경에서 수행.

**알려진 후속(13 OQ 인용)**:
- HOT_WINDOW_BYTES 기본 cap은 구현됨. 단 정확한 cap 수치와 heavy-item bounded 표현 한도는 실측 후속(OQ-52).
- approval 영속 audit 로그 — v1 in-memory만(OQ-51).
- cross-key 전역 seq 정렬 — per-키 receive-order만(D-SEQ, OQ-17).
- cold-restore 후 direct 대화 복원 — scrub로 디스크 키 부재, 1차 범위 밖(OQ-16, PTY와 일관).
- recent history는 `runtimeKind` 기반 direct 배지/host 재선택까지 구현됨. provider id/resume key는 보안 경계상 계속 미저장이라 history 재열기는 transcript resume/load가 아닌 새 direct start다(10 §5.5).
- Codex `thread/read includeTurns` 범위·same-turn late notification 실측 — 격리 replay/seal grace는 보수적 기본값(OQ-53/54).

## 2026-06-27 보강 — live direct metadata / same-process resume 배선

- `SessionStartResult`에 optional `canResume`/`canLoad`/version metadata를 추가했다(15 §6). Codex는 `threadId` 기반 resume/load 가능값을 반환하고, Claude ACP는 initialize capability(`loadSession`, `sessionCapabilities.resume`)와 `agentInfo.version`을 반환한다.
- direct host가 start/resume 결과를 `AgentRuntimeMetadata`로 축약해 live session에 반영하고 workspace autosave 의존성에 포함한다. 저장 직전 scrub 정책은 그대로라 provider id는 디스크에 남기지 않는다.
- direct host mount 시 in-memory `agentRuntime`에 provider id가 있으면 `resumeSession` 경로를 사용한다. cold restore 후 provider id 기반 복원은 여전히 scrub 정책 때문에 범위 밖이다.
- 확인: `npm run test -- AgentTranscriptSurface session-shell-adapter session-store-mutations agent-runtime-controller` 통과(22 tests), `npx svelte-check --tsconfig ./tsconfig.json` 0 errors / 0 warnings. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — HOT_WINDOW_BYTES eviction

- `TranscriptResidencyConfig`에 `HOT_WINDOW_BYTES = 8 * 1024 * 1024` 기본값을 추가하고, reducer `evictOverflow`가 sealed turn 개수 cap과 retained body byte cap을 함께 적용하도록 했다.
- byte cap은 `itemsById`에 보관되는 message/tool/plan/file_change/notice body를 UTF-8/JSON 기준으로 근사 계산한다. cap 초과 시 count cap과 동일하게 oldest sealed turn부터 `evicted-tombstone`으로 전이해 body·`itemVersions`·`visibleItemIds`를 pruning한다.
- 확인: `npm run test -- agent-event-reducer` 통과(23 tests), `npm run test -- agent-runtime-store` 통과(14 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — recent history direct runtimeKind 보존

- `TabHistoryEntry`에 optional `runtimeKind`를 추가해 direct 세션이 recent history에서 다시 열릴 때 PTY로 떨어지지 않도록 했다. `runtimeKind="pty"`/미지정/기타 값은 legacy PTY로 정규화하고, `"direct-codex"|"direct-claude"`만 저장한다.
- Rust history 저장 계층은 `resume_token`을 계속 `None`으로 강제하며, provider session/thread/resume id는 저장하지 않는다. dedupe key는 `agent_id`/`distro`/`work_dir`/정규화된 `runtimeKind`라 같은 경로의 PTY/direct 항목이 서로 덮어쓰지 않는다.
- launcher recent list에 direct 배지를 추가했다. 이 배지는 `runtimeKind` 기반 표시이며 provider id 추적/복원을 의미하지 않는다.
- 확인: `npm run test -- session-factory session-runtime session-lifecycle-controller session-launch-controller tab-rename-orchestration-controller SessionLauncher preview/runtime` 통과(52 tests), `cargo test --manifest-path src-tauri/Cargo.toml history` 통과(10 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — replay canLoad gating

- `AgentTranscriptSurface`의 기본 replay loader가 evicted tombstone 존재 여부만으로 `canLoad=true`를 만들던 경로를 수정했다. 이제 replay 시도 가능 여부는 provider/session capability(`SessionStartResult.canLoad` 또는 live `agentRuntime.canLoad`)가 `true`일 때만 열린다.
- 따라서 FE-28 요구처럼 tombstone affordance가 있더라도 provider가 load/replay를 지원하지 않으면 `ReplayPanel`은 "사용 불가" notice만 표시하고 `loadHistory`를 호출하지 않는다.
- 확인: `npm run test -- AgentTranscriptSurface ReplayPanel` 통과(13 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — replay scratch dispose idempotency

- `ReplayPanel` 닫기 버튼이 `loader.dispose()`를 호출한 직후 부모가 패널을 unmount하면 `onDestroy`가 다시 폐기하는 중복 shutdown 경로가 있었다. 당시 구현은 닫을 때 폐기하되 한 번만 수행되도록 idempotent guard를 추가했다(T5.6 DoD: scratch 폐기, running 세션 비간섭). 이후 "replay scratch dispose after load" 보강으로 폐기 시점은 조회 성공/실패 직후로 이동했고 close/unmount는 보조 cleanup이 됐다.
- RED: `ReplayPanel` close 후 unmount 시 `dispose`가 2회 호출됨을 확인했다.
- 확인: `npm run test -- ReplayPanel` 통과(4 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — stderr redaction 최소 패턴 확장

- 09 §5.1의 v1 최소 redaction 패턴 중 `AKIA*`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `Bearer <token>` 값이 Rust `transport::redact`에서 충분히 가려지지 않는 공백을 보강했다.
- RED: `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::transport::redact_tests`에서 `AKIA...`와 bearer token value가 평문으로 남는 실패를 확인했다.
- 확인: 동일 Rust redaction 테스트 통과(3 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — stderr header redaction coverage

- 09 §5.1/§5.2의 TB-2 stderr emit 경계에서 `Authorization: Token ...`, `Cookie: ...`, `X-API-Key= ...`, `Password= ...`처럼 header/key marker와 secret value가 whitespace로 분리되는 로그 라인을 추가 마스킹한다.
- `Authorization`은 `scheme + value` 두 토큰이 분리될 수 있어 후속 2토큰을 마스킹하고, cookie/API key/password 계열 marker는 후속 1토큰을 마스킹한다. `:`와 `=` marker 모두 같은 규칙을 쓴다.
- RED: `transport::redact_tests`에서 `Authorization: Token account-secret Cookie: sid=session-secret`와 `X-API-Key= x-api-secret Password= password-secret` 값이 평문으로 남는 실패를 확인했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::transport::redact_tests` 통과(5 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — tool raw 표시 redaction

- `ToolCallCard`가 `rawOutput` 존재 시 expand affordance를 켜면서 실제 raw detail은 렌더하지 않던 gap을 보강했다. 이제 `rawInput`/`rawOutput`을 펼친 카드 안에 redacted JSON으로 표시하고, 표시 직전 credential-like 값(`Bearer <token>`, `AKIA*`, `sk-*`, `ghp_*`, secret 계열 key/value)을 마스킹한다(09 §5.2 TB-4, §8.1 raw 분리).
- RED: `ToolCallCard`의 raw-only 카드가 `https://api.example.test` 같은 일반 값도 표시하지 못하고, redacted secret 표시도 없음을 확인했다.
- 확인: `npm run test -- ToolCallCard` 통과(6 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — transcript text 표시 redaction

- 09 §5.2 TB-4가 transcript content도 표시 경계 redaction 대상으로 두므로, `MessageBubble`의 text content 렌더도 같은 표시용 redaction 유틸을 통과하게 했다. `ToolCallCard`의 raw/content redaction도 `display-redaction.ts`로 분리해 동일 정책을 쓴다.
- RED: `MessageList`에서 `Bearer account-token-123`/`AKIA...`가 user message bubble에 그대로 노출되는 실패를 확인했다.
- 확인: `npm run test -- MessageList ToolCallCard` 통과(12 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — approval 표시 redaction

- 09 §5.2 TB-4 표시 경계를 approval UI에도 적용했다. `ApprovalInlineCard`와 `ApprovalModal`의 title/body/option label/aria-label이 `display-redaction.ts`를 거쳐 provider 문자열의 credential-like 값을 화면에 내보내지 않는다.
- 원본 `optionId`/`kind`/순서·개수는 그대로 보존하므로 09 §2 표시-선택 일치와 wire 응답 라우팅은 유지된다. 바뀐 것은 화면/접근성 문자열의 redaction뿐이다.
- RED: approval title/body/option label에 `Bearer ...`, `ANTHROPIC_AUTH_TOKEN=...`, `AWS_BEARER_TOKEN_BEDROCK=...`, `AKIA...`, `sk-*`, `ghp_*`가 그대로 표시되는 실패를 확인했다.
- 확인: `npm run test -- ApprovalInlineCard ApprovalModal` 통과(9 tests), `npx --no-install svelte-check --tsconfig ./tsconfig.json` 0 errors / 0 warnings. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — display redaction key/header coverage

- 09 §5.1/§5.2의 token/cookie/credential 비노출 요구에 맞춰 `display-redaction.ts`의 JSON key 기반 마스킹 범위를 넓혔다. `authToken`뿐 아니라 `Authorization`, `Cookie`, `password`, `providerResumeToken`처럼 raw JSON에 들어올 수 있는 민감 키 값도 표시 직전에 `[REDACTED]`로 치환한다.
- 평문 표시 텍스트의 `Authorization: ...`, `Cookie: ...`, `Set-Cookie: ...`, `X-API-Key: ...`, `Password: ...` 헤더형 라인도 같은 표시 경계에서 마스킹한다.
- RED: `stringifyRedactedRaw`가 `Authorization: "Token account-secret"`, `Cookie: "sid=session-secret"`, `password`, `providerResumeToken` 값을 그대로 남기는 실패와, `redactDisplayText`가 header-like auth/cookie/API key 라인을 그대로 남기는 실패를 확인했다.
- 확인: `npm run test -- display-redaction MessageList ToolCallCard ApprovalInlineCard ApprovalModal` 통과(23 tests), `npx --no-install svelte-check --tsconfig ./tsconfig.json` 0 errors / 0 warnings. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — FE-25 settings 섹션 범위 정정

- 08 §2.1/15 §3의 정본 결정처럼 v1은 agent-runtime 전용 신규 Settings 섹션을 신설하지 않고 기존 `TerminalSettings`/`InterfaceSettings` 토큰을 재사용한다.
- 11 §6.7의 FE-25 문구가 `새 agentRuntime 설정 섹션`을 요구하는 것처럼 읽혀 정본과 충돌하던 부분을 정정했다. FE-22..FE-24는 direct session `runtimeKind`/`agentRuntime` 저장→복원→기존 세션 갱신 왕복을 검증하고, FE-25는 "새 settings 섹션 없음" 결정과 향후 settings 섹션 추가 시 3함수 동기화 가드로만 남긴다.
- 코드 확인 결과 `Settings`/`DEFAULT_SETTINGS`/`settings.svelte.ts`에 agent-runtime 전용 settings 섹션은 없으며, 이 상태가 08/15 결정과 일치한다. 따라서 이번 항목은 구현 추가가 아니라 문서-구현 정합화다.

## 2026-06-27 보강 — FE-3 runtime metadata 표시

- `AgentTranscriptSurface`가 start/resume 결과나 live `agentRuntime` prop에서 비밀이 아닌 metadata(provider, protocol/adapter/provider version, resume/load capability)를 compact strip으로 표시한다.
- `providerSessionId`/`providerThreadId`/`providerResumeToken`은 렌더하지 않는다. provider id는 live resume에만 쓰고, UI debug 표면에는 scrub 경계를 유지한다(15 §7.3).
- 11 §8.5의 추적성 체크도 ProviderRef/pending table 같은 메모리 store 경로의 원본 id 보존과 UI/디스크 scrub 경계를 분리하도록 정정했다.
- 확인: RED `agent-runtime-metadata` 미표시 실패 확인 후 구현, `npm run test -- AgentTranscriptSurface` 통과(11 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — FE-13 hardcoded UI text guard

- agent-runtime view의 Svelte markup에 사용자 노출 raw text node와 literal `aria-label`/`title`/`placeholder`가 남지 않도록 정적 테스트 `i18n-hardcoded-text.test.ts`를 추가했다.
- provider가 내려주는 option label/body/title, command/path 같은 동적 값은 markup literal이 아니므로 이 guard의 대상이 아니며, 새 UI 문구는 기존처럼 `agentRuntime.*` locale key를 거쳐야 한다.
- 확인: `npm run test -- i18n-hardcoded-text key-parity` 통과(4 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — FE-14/15 focus·shortcut guard

- composer textarea가 포커스된 동안 `Ctrl+T`/`Ctrl+W` keydown을 bubble시키지 않도록 했다. 기본 텍스트 편집 동작을 막지 않기 위해 `preventDefault`는 호출하지 않고, App 전역 tab shortcut 발화만 차단한다(FE-14).
- `ApprovalModal`에 Tab/Shift+Tab focus trap을 추가해 focus가 modal action 밖으로 새지 않게 했다. `alertdialog` root에는 `tabindex="-1"`을 부여해 a11y 경고도 제거했다(FE-15).
- FE-16 문구는 v1 구현 결정에 맞춰 정정했다. command output은 full xterm input embed가 아니라 read-only 경량 렌더이며, 기존 `CommandOutputCard` 테스트가 `tabindex`/`contenteditable`/input 부재를 검증한다.
- 08 §10.3의 Escape 설명도 현재 구현/테스트와 맞게 정정했다. Escape는 modal을 미해결 상태로 닫지 않고 `cancelled` 응답을 보내며, 임의 `selected` 승인/거부는 보내지 않는다. 08 §4.1의 expand affordance 조건도 `rawInput`을 포함하도록 맞췄다.
- 확인: RED 확인 후 `npm run test -- AgentComposer`(8 tests), `npm run test -- ApprovalModal`(4 tests) 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — NM-20 failed approval wire guard

- 04 §4.2 규칙 4/09 §3 체크리스트/11 NM-20에 맞춰 `ApprovalDecision{outcome:"failed"}`가 public controller 승인 경로에서 provider wire로 내려가지 않도록 guard를 추가했다. `failed`는 process exit/teardown cleanup 내부 전용이며, 사용자 `approve()` 경로는 `selected`/`cancelled`만 port로 넘긴다.
- Codex app-server/Claude ACP adapter 단위 테스트에 pending approval 상태에서 `respondApproval(failed)` 호출 시 outbound 캡처가 비어 있음을 고정했다. adapter의 exit cleanup 내부 `approval_resolved{failed}` emit 경로는 유지한다.
- RED: `agent-runtime-controller`에서 `approve({outcome:"failed"})`가 reject하지 않고 fake port로 전달되는 실패를 확인했다.
- 확인: `npm run test -- agent-runtime-controller codex-app-server-adapter claude-acp-adapter` 통과(45 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — RS-10d/10e resolver cache boundary

- 11 §5.3 RS-10d/10e 요구에 맞춰 `CachingResolver` 테스트를 executable 성공경로와 adapter entry 성공/거부 경로로 분리했다. executable은 절대경로 반환과 `clear()` 후 재탐색을 고정하고, adapter entry는 pinned `node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` 레이아웃만 캐시되도록 검증한다.
- `WslResolver`뿐 아니라 cache boundary에서도 adapter entry suffix를 재검증한다. 대체/mock resolver가 잘못된 절대경로를 돌려줘도 캐시에 신뢰 entry로 저장하지 않는다.
- RED: `resolve_adapter_entry`가 `/opt/acp/dist/index.js` 같은 비핀 레이아웃 절대경로를 통과시키는 실패를 확인했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::tests::rs10` 통과(3 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — NM-33 late patch reseal

- 04 §3.7/11 NM-33의 sealed-retained late-event 규칙을 보강했다. sealed turn은 이미 종료 신호를 받은 상태이므로 late auxiliary patch(plan/usage 보정 등)로 잠시 unseal되어도 `terminated` 플래그를 유지해야 `resealAfterPatch()`가 추가 `turn_completed` 없이 다시 seal할 수 있다.
- 기존 테스트는 late delta 뒤에 `turn_completed`를 한 번 더 보내 reseal을 만들고 있어 이 공백을 가렸다. late `plan_updated`만으로 unseal→patch→reseal이 되는 회귀 테스트를 추가했다.
- RED: late `plan_updated` 후 `resealAfterPatch()`가 `unsealed`에 머무르는 실패를 확인했다.
- 확인: `npm run test -- agent-event-reducer` 통과(24 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — RS-16/17 bounded replay log backpressure

- 07 §7.2/11 §5.5의 RS-16/17을 AppHandle 없이 검증할 수 있도록 bounded replay log trim 로직을 `record_bounded_replay_log` 순수 함수로 분리했다. 실시간 `agent-runtime-message` emit 경로는 유지하고, replay log cap 초과 시 oldest trim과 누적 `droppedMessages` telemetry 카운트만 함수가 계산한다.
- 한 번의 trim에서 여러 notify interval을 지날 수 있으므로 backpressure emit 대상 count 목록을 반환하게 해 기존 interval별 emit semantics를 유지했다.
- RED: `record_bounded_replay_log`가 없어 RS-16/17 테스트가 컴파일 실패하는 것을 확인했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml bounded_replay_log` 통과(2 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — RS-13/14/15c shutdown reap boundary

- 07 §5.2/11 §5.4의 S3 경계를 Rust 단위 테스트로 고정했다. `shutdown` 운영 경로는 기존 `SHUTDOWN_GRACE_MS`/`REAP_GRACE_MS` 값을 그대로 쓰고, 내부 `shutdown_with_policy`만 분리해 테스트에서 짧은 대기값과 mock kill 함수를 주입한다.
- RS-13은 이미 `exited=true`인 graceful 경로가 kill 없이 runtime을 제거함을 검증한다. RS-14는 grace timeout 후 kill이 호출되고, kill 직후 `exited=true`가 반영된 뒤에만 runtime을 제거함을 검증한다. RS-15c는 reap timeout에도 `exited=false`이면 `Err`를 반환하고 runtime을 제거하지 않는 실패 분기를 잠근다.
- RED: `shutdown_with_policy`/`ShutdownPolicy`가 없어 RS-13/14/15c 테스트가 컴파일 실패하는 것을 확인했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml shutdown_` 통과(3 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-29/36/37/38/39 stale blocker 정리

- T2.0에서 확정·구현된 OQ-29(child wait/kill 동시성), OQ-36(resolve owner/cache), OQ-37(serde `rename_all_fields`), OQ-38(env key allowlist), OQ-39(backpressure 수치 정책)가 `13-risks-open-questions.md`와 `11-testing-acceptance.md`의 미확정/Phase 2 blocker 문구에 남아 있던 drift를 정리했다.
- 13 OQ 표는 각 항목을 "해소됨(T2.0)"으로 바꾸고, RS-13/14/15c·RS-10d/10e·RS-12/12b·RS-16/17·RS-21..25 검증 근거를 연결했다. 11 §5.3/§5.5/§5.7/§9도 같은 결정값과 테스트 책임을 인용하도록 동기화했다.

## 2026-06-27 보강 — H4/OQ-33 stale hard gate 정리

- H4에서 해소된 Codex `UserInput.text` outbound 형태가 일부 문서에 여전히 Phase 3 blocker/stub gate로 남아 있던 drift를 정리했다. 정본은 `makeTextUserInput(text) = { type:"text", text, text_elements: [] }`다.
- 13 OQ-33과 H4 묶음 머리말, 12 T3.1/T3.2 선행 조건, 05 §5.3d 의사코드를 현재 구현·테스트와 맞췄다. resource→mention 근사 매핑은 text hard gate와 분리된 보수적 매핑으로 표기했다.

## 2026-06-27 보강 — OQ-46 reasoning segment index 보존

- Codex `item/reasoning/textDelta{contentIndex}` / `summaryTextDelta{summaryIndex}`를 `agent_message_delta{channel:"thought", segment:{kind,index}}`로 매핑해 같은 reasoning item 안의 병렬 text stream을 분리 보존한다.
- reducer는 segment metadata가 있는 text delta를 같은 segment의 text block에만 append하고, 점진 렌더 순서를 `summary[]` 다음 `content[]`, 각 index 오름차순으로 유지한다. completed reasoning item의 `summary` vs `content` 권위 필드 실측(OQ-46)은 아직 미해결이므로 기존 `[...summary, ...content].join("\n")` 보수 기본값은 유지했다.
- RED: mapper가 segment metadata를 내보내지 않고, interleaved `contentIndex=0/1` delta가 하나의 text block으로 섞이는 실패를 확인했다.
- 확인: `npm run test -- codex-wire-mapper agent-event-reducer` 통과(60 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-26/RS-10c stale 문구 정리

- OQ-26 UTF-8 framer 공유 방식은 `decode_utf8_stream_chunk`를 `pub(crate)`로 올리고 `agent_runtime/transport.rs`가 직접 import하는 최소 변경으로 해소된 상태다. 07/12/13의 오래된 미확정 표현과 체크리스트를 현재 구현 상태에 맞춰 정리했다.
- 11 §5.3 RS-10c에는 OQ-36이 이미 T2.0에서 확정됐는데도 오래된 미확정 표현이 남아 있었다. owner `agent_runtime/resolver.rs`와 `TrustedPathResolver` mock 실패 주입 경계로 정정했다.

## 2026-06-27 보강 — 07/OQ-36 resolver stale 문구 정리

- 07 §8.1 allowlist 본문과 의사코드 주석에 남아 있던 OQ-36 미확정 표현을 확정값으로 갱신했다. owner는 `agent_runtime/resolver.rs`, cache key는 `(provider,distro)`, TTL 없는 process-lifetime cache이며 `clear()`로 명시 무효화한다.
- `resolver.rs` rustdoc도 같은 정본으로 맞췄다. 기존 cache 무효화 관련 오래된 표현은 현재 구현/테스트(`CachingResolver.clear()`, RS-10d/10e)와 어긋나므로 제거했다.

## 2026-06-27 보강 — OQ-38 env allowlist stale 문구 정리

- 09 §4.3/§4.4가 provider env key allowlist를 아직 미확정처럼 표현하던 부분을 OQ-38 확정값으로 갱신했다. 공통 key는 `RUST_LOG`/`RUST_BACKTRACE`/`NO_COLOR`, Codex 추가 key는 `CODEX_DISABLE_UPDATE_CHECK`, Claude 추가 key는 `CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_EXECUTABLE`/`NODE_OPTIONS`다.
- 구현은 allowlist 밖 key를 drop하지 않고 `Err(String)`으로 거부하므로, 보안 문서도 RS-12/12b와 같은 거부 기준으로 정정했다. 07 §8.1 의사코드의 빈 allowlist placeholder와 오래된 gate 주석도 현재 구현 상태에 맞췄다.

## 2026-06-27 보강 — OQ-23/OQ-30 cancel 책임 stale 문구 정리

- 07 §6.3에 남아 있던 `agent_runtime_cancel` 의미 범위의 오래된 미확정 표현을 OQ-23/OQ-30 확정값으로 갱신했다. backend command는 15 §8.2 계약대로 유지하지만 `{type:"process"}`만 직접 처리하고, `request`/`turn` cancel wire는 frontend adapter가 `agent_runtime_send`로 직접 전송한다.
- 현재 구현도 `agent_runtime::cancel`에서 process는 `shutdown`, request는 진단 pending id 제거 후 `Ok(())`, turn은 no-op으로 처리해 이 정본과 일치한다.

## 2026-06-27 보강 — 10 persistence checklist 현재화

- 10 §3/§5/§6의 `runtimeKind`/`agentRuntime` persistence와 scrub 체크리스트를 현재 구현 상태에 맞춰 갱신했다. TS는 `types.ts`/`metadata.ts`/`session-store-snapshot.ts`/`live-session-workspace-sync.ts`/`workspace.ts`에 반영되어 있고, Rust는 `workspace/types.rs`/`store.rs`/`service/window_ops.rs`, history는 `features/history/mod.rs`에 반영되어 있다.
- 비밀 3필드(`providerSessionId`/`providerThreadId`/`providerResumeToken`)는 frontend 보조 마스킹과 backend 최종 scrub에서 제거되며, history는 provider id/resume key를 저장하지 않고 `runtimeKind` direct 표식만 보존한다.
- `merge_workspace_snapshot_preserves_direct_runtime_metadata` 회귀 테스트를 추가해 OQ-18의 마지막 Rust merge 경계도 고정했다.
- 확인: `npm run test -- workspace session-factory session-runtime session-launch-controller session-lifecycle-controller tab-rename-orchestration-controller SessionLauncher preview/runtime launcher-session-confirm` 통과(12 files, 72 tests), `cargo test --manifest-path src-tauri/Cargo.toml workspace` 통과(17 tests), `cargo test --manifest-path src-tauri/Cargo.toml history` 통과(10 tests).

## 2026-06-27 보강 — 07 backend checklist 현재화 / RS-5b framing

- 07 §2/§12 backend 등록·모듈·타입·transport·process·allowlist 체크리스트가 구현 상태보다 뒤처져 있어 실제 파일/command 표면 기준으로 현재화했다. 현재 Tauri command surface는 `start/send/cancel/shutdown/get_snapshot/resolve_adapter_entry` 6종이다.
- `agent_runtime_resolve_adapter_entry`는 Claude adapter가 `adapterEntryPath`를 renderer에서 만들지 않고 backend-resolved 신뢰 절대경로를 얻는 보조 command다. 15 §8.2, 12 T2.5, 03/research 위치 표의 "5종" stale 표현도 함께 정리했다.
- RS-5b를 추가해 raw newline/pretty-print로 JSON 메시지가 EOF-like incomplete line으로 쪼개지는 경우를 즉시 fatal framing break로 분류하도록 고정했다. 구현은 `transport::classify_line`이 `serde_json::Error::is_eof()`를 `LineClass::Fatal`로 분리하고, handler가 즉시 `recoverable:false` latch에 들어가도록 했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::tests::rs5b_incomplete_json_line_is_fatal_framing_break` 통과. 후속으로 `agent_runtime` 전체와 TS transport wrapper 테스트를 재검증한다. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — AC-4b/OQ-49 reader-local framing latch 검증

- OQ-49는 v1에서 reader-local `FramingState`로 결정했다. fatal framing break 후 상태를 `AgentRuntimeSnapshot`에 노출하지 않고, frontend는 1회 emit된 `recoverable:false`로만 인지한다.
- stdout reader의 emit 경계를 `RuntimeEventEmitter` trait로 작게 분리해 production은 기존 Tauri `AppHandle.emit`을 쓰고, Rust 단위 테스트는 같은 `flush_complete_lines` 경로의 message/error/backpressure emit을 Vec로 캡처한다.
- AC-4b 테스트는 raw newline으로 incomplete JSON line을 만든 뒤 후속 valid/invalid stdout을 이어 넣어도 `recoverable:false` error가 정확히 1회만 캡처되고, message log/seq가 증가하지 않음을 검증한다.
- RED: `FramingState`/`RuntimeEventEmitter`/공개 `flush_complete_lines`가 없어 `ac4b_fatal_framing_latches_and_suppresses_followup_stdout`가 컴파일 실패했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::tests::ac4b_fatal_framing_latches_and_suppresses_followup_stdout` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — NM-18b/18c/18d shutdown cleanup ordering

- 11 §2.5/§8.1의 S3 adapter-side cleanup 항목을 Codex/Claude 양쪽 테스트로 고정했다. shutdown 시 pending approval은 backend shutdown 전에 cancelled wire + `approval_resolved{cancelled}`로 닫고, pending RPC는 로컬 reject/settle되며, listener 해제·세션 삭제는 backend shutdown await 이후에만 수행한다.
- Codex S3 테스트는 `turn/start` 응답을 일부러 보류해 pending RPC를 만들고, shutdown 중 늦은 exit과 shutdown 후 늦은 exit 모두에서 `approval_resolved`가 1회만 남는지 검증한다. Codex `sendPrompt`는 pending RPC reject를 `error` event로 변환하고 Promise는 resolve하는 기존 계약을 유지한다.
- Claude S3 테스트는 `session/prompt` pending RPC가 shutdown에서 `runtime closed before session/prompt response`로 reject되고, pending approval cancelled가 backend shutdown보다 먼저 전송되며, 늦은 exit이 pending을 재차 닫지 않음을 검증한다.
- 확인: `npm test -- src/lib/features/agent-runtime/adapters/codex/codex-app-server-adapter.test.ts src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts` 통과(2 files, 37 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — CX-16/17, CL-12..16 checklist 현재화

- 11 §8.1의 interleaved turn / ACP chunk-replace 항목은 대부분 기존 테스트가 덮고 있었지만, CX-17(같은 thread에서 t1 완료 후 t2 시작)이 문서 번호 그대로 잠겨 있지 않았다. `codex-wire-mapper.test.ts`에 t1 `turn_completed`와 t2 `running` ref가 섞이지 않고 routing 상태도 t2 active/t1 closed로 남는 회귀 테스트를 추가했다.
- 기존 증거도 명시했다. FR-CX-4 fixture replay와 CX-16 mapper 테스트가 cross-thread/turn triple-key 분리를 검증하고, `claude-acp-session-update.test.ts`의 CL-12..16이 ACP message chunk append, messageId 전환, tool_call_update replace/upsert, plan replace를 검증한다.
- 확인: `npm test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts src/lib/features/agent-runtime/adapters/codex/codex-fixture-replay.test.ts src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-session-update.test.ts` 통과(3 files, 57 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — CX-15b/15c, CL-24b/27 unknown request/notification

- 04 §5/11 §8.1의 미지원 server request/notification 규칙을 현재 구현에 맞춰 잠갔다. id 있는 server→client request는 Codex에서 error reply, Claude에서 JSON-RPC `-32601` error를 보내며 무응답으로 끝나지 않는다.
- 실제 gap은 unknown notification의 raw 보존이었다. 기존 구현은 counter와 no-response만 검증했으므로, Codex mapper의 unknown 진단 상태에 raw payload 보관을 추가하고, Claude `SessionUpdateRuntime`에도 `unknownRaw`를 추가했다. transcript event는 만들지 않고 내부 telemetry/debug 경계에만 남긴다.
- 테스트는 Codex CX-15b/15c에서 raw payload 보존을 assert하고, Claude CL-27에서 `plan_update`/`plan_removed`와 완전 unknown variant가 `unknownRaw`에 남는지 검증한다.
- 확인: `npm test -- src/lib/features/agent-runtime/adapters/codex/codex-wire-mapper.test.ts src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-session-update.test.ts src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts` 통과(3 files, 68 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — NM-31..34 bounded transcript memory checklist 현재화

- 11 §8.1의 long-session transcript memory 항목은 reducer/store 테스트가 이미 핵심 불변식을 덮고 있어 checklist만 현재화했다. `agent-event-reducer.test.ts`는 seal 전이(NM-32/32b), count/byte cap eviction(NM-31/31d), meta index pruning(NM-31c), sealed-retained late patch/reseal(NM-33/33b), evicted-tombstone late drop(NM-34), AgentEvent 불변(NM-35)을 검증한다.
- `agent-runtime-store.svelte.test.ts`는 반응형 표면(`visibleItemIds`/`itemVersions`)과 plain body Map 경계를 검증하고, `flushSealAndEvict`가 긴 세션에서 `itemsById`를 bounded로 유지하는지 확인한다(NM-31b).
- 정확한 운영 수치와 heavy-item cap은 OQ-52 후속 실측 범위로 남지만, v1 보수 기본값(`HOT_WINDOW_SEALED_TURNS=50`, `HOT_WINDOW_BYTES=8MiB`, `TOMBSTONE_LRU=200`, `SEAL_QUIESCENCE_GRACE_MS=250`)과 bounded 불변식은 구현/테스트로 고정됐다.
- 확인: `npm test -- src/lib/features/agent-runtime/controller/agent-event-reducer.test.ts src/lib/features/agent-runtime/state/agent-runtime-store.svelte.test.ts` 통과(2 files, 39 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — RS-6/7 stderr/stdout 분리

- 11 §5.2 RS-6/7이 문서에는 있었지만 Rust 단위 테스트로 잠겨 있지 않았다. `extract_stderr_lines`를 분리해 stderr line 경계를 stdout JSON-RPC framer와 별도로 검증할 수 있게 했다.
- `spawn_stderr_reader`는 `BufRead::read_line(String)` 대신 stdout과 같은 `decode_utf8_stream_chunk` 기반 byte-stream loop를 사용한다. 비 UTF-8 stderr는 `U+FFFD`로 복구해 line emit하고, 미완성 tail은 EOF에서 flush한다. stderr는 JSON parse를 하지 않으므로 stdout framing/latch 상태를 오염하지 않는다.
- 확인: `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::tests`(34 tests), `git diff --check` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — RS-18/19 test-mode mock + 8.2 backend checklist 현재화

- `mock_provider`/`mock_jsonrpc_script`를 `pub(crate)`로 열어 test-mode mock 경계를 pure unit test로 고정했다. RS-18은 stdio mock provider는 허용하고 websocket mock start는 token을 오류 문자열에 남기지 않은 채 거부하는지 검증한다.
- RS-19는 Codex/Claude mock JSON-RPC script가 provider별 lifecycle seed를 담고 있고 모든 line이 valid JSON인지 검증한다. Codex script는 `thread/started`, Claude script는 `protocolVersion`/`sessionId`를 포함한다.
- 11 §8.2 backend checklist도 현재 구현 증거에 맞춰 닫았다. `agent_runtime::tests`가 RS-8..12c, RS-10d/e, RS-18..25를 덮고, transport/error 계층은 RS-1..7/AC-4b/RS-13..17에서 별도 검증한다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::tests`(36 tests), `cargo check --manifest-path src-tauri/Cargo.toml`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `git diff --check` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — 8.4/8.5 UI·security checklist 현재화

- FE-12/13은 `i18n-hardcoded-text.test.ts`와 `key-parity.test.ts`로 닫았다. agent-runtime Svelte markup의 사용자 노출 literal guard와 en/ko key tree parity를 동시에 확인한다.
- FE-27/28의 격리 replay-reload 경계를 `AgentTranscriptSurface.test.ts`에 보강했다. canLoad=true일 때 tombstone affordance가 scratch loader의 read-only panel을 열고 close 시 loader를 폐기하며, canLoad=false 경로는 기존 unavailable notice test가 덮는다. 실제 Codex `thread/read(includeTurns)` 조회 범위는 OQ-54로 남아 있어 fake loader 주입 경계만 고정한다.
- 8.5 보안/추적성 중 ProviderRef/request id 보존, approval wire id 원타입 보존, in-memory approval audit 1:1 기록, websocket authToken reject-before-log, provider id/resume scrub, direct runtime persistence 왕복은 기존 테스트 증거에 맞춰 체크리스트를 닫았다. raw protocol log 파일 생성/기본 off E2E는 아직 닫지 않았다.
- 확인: `npm test -- i18n-hardcoded-text key-parity AgentTranscriptSurface ReplayPanel runtime-replay display-redaction pending-approval-table claude-acp-permission workspace session-store-snapshot agent-runtime-store` 통과(13 files, 75 tests), `npm test -- AgentTranscriptSurface` 통과(12 tests), `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::tests`(36 tests), `cargo test --manifest-path src-tauri/Cargo.toml workspace`(17 tests), `cargo test --manifest-path src-tauri/Cargo.toml history`(10 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — 8.1 mapping/normalized broad coverage 현재화

- NM-17 gap을 닫았다. `turn_completed{status:"cancelled"}` 수신 시 같은 turn의 `pending`/`in_progress` tool call을 client 합성 `cancelled`로 닫고 `openItemCount`를 낮춘다. RED에서 tool call이 `in_progress`로 남는 실패를 확인했다.
- NM-21/22/29a는 reducer 테스트명으로 명시했다. `ProviderRef.raw`가 transcript item ref에 보존되고, `ToolCallUpdate.rawInput/rawOutput`이 partial update 뒤에도 유지되며, v1 정렬 권위인 per-key receive-order가 보존된다.
- CX-6 gap을 닫았다. `item/plan/delta`는 suppress하되 `item/completed{type:"plan"}`은 completed item을 권위로 삼아 `plan_updated` 전체 교체로 매핑한다. CX-9는 13 OQ-21에 따라 v1 미지원/후속 범위로 11 문구를 정리했다.
- CL-10/11 gap을 닫았다. ACP `session/prompt` result의 `stopReason:"refusal"|"max_tokens"`를 `turn_completed.ref.raw.stopReason`에 보존해 reducer/UI notice 경계가 stopReason을 잃지 않게 했다.
- 확인: RED 후 `npm test -- agent-event-reducer` 통과(29 tests), RED 후 `npm test -- codex-wire-mapper` 통과(37 tests), RED 후 `npm test -- claude-acp-adapter` 통과(20 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — fixture replay / redaction gate

- Claude ACP fixture replay가 문서에는 정의되어 있었지만 테스트 연결이 없던 gap을 닫았다. `claude-acp-fixture-replay.test.ts`는 `direction:"out"` request id/method를 기억해 `direction:"in"` response를 `session_started`/`session_loaded`/`turn_completed`로 복원하고, `session/update`와 `session/request_permission`은 기존 mapper를 재사용한다.
- ACP `stopReason` 매핑을 `claude-acp-stop-reason.ts`로 분리해 adapter 본체와 fixture replay가 같은 normalized 변환을 쓰도록 했다. 이에 맞춰 `claude-prompt-update-stream.expected.json`도 `ref.raw.stopReason:"end_turn"` 보존을 기대한다.
- fixture corpus hygiene 테스트를 추가해 commit된 `__fixtures__` JSONL/JSON이 parse 가능하고, `AKIA*`, `ghp_*`, `Bearer ...`, `Authorization`, `Cookie`, password/apiKey/authToken/resumeToken/provider token 계열 secret-shaped 값이 들어오지 않는지 검사한다. synthetic `sess-1`/`th_1` 같은 fixture-local id는 허용한다.
- 확인: `npm test -- claude-acp-fixture-replay claude-acp-adapter` 통과(2 files, 27 tests), `npm test -- codex-fixture-replay claude-acp-fixture-replay` 통과(2 files, 14 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — FE-21 tab switch mount contract

- `SessionViewport`의 탭 전환 무재mount 계약을 단위 테스트로 고정했다. `SessionShellProbe`에 mount/destroy lifecycle log를 추가하고, `activeSessionId`만 바꾸는 rerender에서 기존 keyed session shell이 destroy/remount되지 않고 `visible` prop만 바뀌는지 검증한다.
- 이 테스트는 Svelte host 조립 계약(FE-21)을 잠그지만, 실제 direct runtime host와 legacy terminal host를 섞어 브라우저/앱에서 확인하는 E2E-9는 아직 별도 잔여로 남긴다.
- 확인: `npm test -- SessionViewport` 통과(1 file, 3 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — raw protocol debug log backend boundary

- 07 §11/11 §8.5의 raw protocol log 정책 중 backend 경계를 구현했다. `CLCOMX_AGENT_DEBUG_LOG`가 truthy일 때만 `app_env::state_path("agent-runtime-debug.log")`에 JSONL을 append하고, 기본값/off 상태에서는 파일을 만들지 않는다.
- inbound(provider→client)은 stdout JSON-RPC valid line emit 직전, outbound(client→provider)은 `write_message`가 compact JSON을 stdin에 성공적으로 쓴 직후 `direction:"in"|"out"`으로 기록한다. 각 log entry는 `runtimeId`, `direction`, redacted `line`을 담는다.
- `redact`는 기존 plain-text stderr 토큰 마스킹에 더해 JSON object 내부의 `Authorization`/`Cookie`/`password`/`apiKey`/`authToken`/resume/provider token 계열 key와 secret-shaped string value를 재귀적으로 마스킹한다. 기존 header marker 보존 동작은 유지했다.
- RED: opt-in raw log 테스트가 `agent-runtime-debug.log`를 찾지 못해 실패했고, outbound 테스트는 `write_message`가 runtime id를 받지 않아 컴파일 실패했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml e2e10_` 통과(3 tests), `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::transport::redact_tests` 통과(5 tests), `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::tests` 통과(39 tests), `cargo fmt --manifest-path src-tauri/Cargo.toml` 적용. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — verify gate 재통과

- `npm run verify` 전체 게이트를 재실행해 현재 direct runtime 구현/문서 보강 상태가 frontend unit, Rust unit, frontend check/build, Rust check를 통과하는지 확인했다.
- 결과: vitest 125 files / 818 tests 통과, cargo test 137 tests 통과, `svelte-check` 0 errors/0 warnings, Vite build OK(기존 large chunk warning만), `cargo check` OK.
- 11 §8.6의 verify 체크를 닫았다. GUI launch/E2E는 여전히 실행하지 않았으므로 legacy PTY E2E, fallback E2E, FE-17/E2E-9/E2E-10 앱 실행 검증은 잔여로 남긴다.

## 2026-06-27 보강 — FE-17 consumed shortcut guard

- App 전역 `Ctrl+T`/`Ctrl+W` handler가 assistant dock/aux surface 등 하위 레이어에서 이미 소비한 keydown(`defaultPrevented`)을 다시 처리하지 않도록 했다. 기존 terminal aux shortcut은 capture listener에서 `preventDefault`/`stopPropagation`을 쓰지만, 전역 handler도 `defaultPrevented`를 존중해야 향후 assistant/aux surface와 안전하게 공존한다.
- RED: `App.test.ts`에서 일반 `Ctrl+T`는 session launcher를 열고, 같은 launcher를 닫은 뒤 `preventDefault()`된 `Ctrl+T`를 dispatch하면 launcher가 다시 열리는 실패를 확인했다.
- 확인: `npm test -- App -t "FE-17"` 통과(1 test), `npm test -- App` 통과(21 files, 171 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — direct runtime E2E spec + test-mode request/response mock

- backend `CLCOMX_TEST_MODE` direct mock을 startup seed 방식에서 요청-응답형 mock으로 바꿨다. Codex는 `initialize`/`thread/start|resume|read`/`turn/start`에 응답하고 delayed notification으로 agent message와 turn completion을 보낸다. Claude는 `initialize`/`session/new|resume|load`/`session/prompt`에 응답하고 `session/update` agent chunk를 보낸다.
- Codex prompt mock은 `item/started` + `item/agentMessage/delta` + `item/completed`를 emit해 E2E-1의 streaming 경로를 탄다. prompt에 `approval`이 포함되면 `item/commandExecution/requestApproval`을 emit하고, user decision response(`accept`/`decline`/`cancel`)에 따라 command item completed/declined와 turn completion을 emit한다.
- E2E fallback을 강제로 검증할 수 있도록 test-mode 전용 `CLCOMX_AGENT_RUNTIME_MOCK_FAIL=1`을 추가했다. 이 값은 direct runtime mock start만 실패시키며 legacy PTY test-mode 경로는 그대로 둔다.
- `e2e/helpers/launcher.ts`에 direct runtime 토글 옵션, `e2e/helpers/agent-runtime.ts`에 composer/transcript helper, `vitest.e2e.config.ts`와 `package.json`에 `agent-runtime` project/script를 추가했다.
- `e2e/agent-runtime/agent-runtime.test.ts`는 direct Codex mock prompt 왕복, direct Claude prompt 왕복, Codex approval allow/reject, recent history direct host 재오픈, raw protocol log default-off/opt-in redaction, direct 실패 후 legacy PTY fallback, direct+PTY 탭 전환 시 direct host DOM 유지 spec을 담는다.
- 확인: RED 후 `cargo test --manifest-path src-tauri/Cargo.toml rs19_mock_jsonrpc_responses_are_valid_and_provider_specific` 통과, `cargo test --manifest-path src-tauri/Cargo.toml` 통과(137 tests), `npx vitest run --config ./vitest.e2e.config.ts --project agent-runtime --reporter=dot`는 현재 Linux/WSL 환경에서 1 file / 8 tests skip으로 transform/import 확인. Windows 앱 launch/E2E 실행은 수행하지 않았다.

## 2026-06-27 보강 — E2E-5 pending approval cancel path

- 08 §6/§10.3의 send↔stop 전환 규칙과 달리 `AgentComposer`가 `requires_action`에서 stop을 숨기던 gap을 단위 테스트로 먼저 고정했다. 입력은 계속 비활성화하되, pending approval 중에도 stop 버튼은 유지해 `controller.cancel()` → adapter cancel cleanup 경로에 도달할 수 있게 했다.
- Codex test-mode mock은 prompt에 `approval inline`이 포함된 경우 `proposedExecpolicyAmendment` 없는 normal inline approval을 emit한다. 기존 `approval allow/reject` prompt는 escalation modal 경로를 유지한다.
- adapter가 approval cancel 응답 뒤 보내는 `turn/interrupt` 요청에 mock 응답을 추가해 cancel promise가 매달리지 않게 했다.
- `e2e/agent-runtime/agent-runtime.test.ts`에 E2E-5 spec을 추가했다. Codex inline approval pending → composer stop 클릭 → inline approval hidden → command item failed까지 검증한다.
- 확인: RED 후 `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts` 통과(9 tests), RED 후 `npm run test:rust -- rs19_mock_jsonrpc_responses_are_valid_and_provider_specific` 통과, `npx vitest run --config ./vitest.e2e.config.ts --project agent-runtime --reporter=dot`는 Linux/WSL에서 1 file / 9 tests skip으로 transform/import 확인. Windows 앱 launch/E2E 실행은 수행하지 않았다.

## 2026-06-27 보강 — E2E-7 legacy PTY spec 명시

- E2E-7의 원래 restore 경로는 기존 `e2e/workspace-restore/workspace-restore.test.ts`가 이미 runtimeKind 없는 `workspace.json` → mock PTY reattach를 검증한다. direct-runtime acceptance 문서가 이 증거를 인용하지 않아 남은 gap처럼 보이던 부분을 현재화했다.
- `e2e/agent-runtime/agent-runtime.test.ts`에도 보조 spec을 추가했다. direct runtime toggle을 선택하지 않은 새 세션이 `agentRuntimeShell`이 아니라 `terminalShell` PTY host로 열리고 `data-pty-id`가 유효한지 확인한다.
- 확인: `npx vitest run --config ./vitest.e2e.config.ts --project agent-runtime --reporter=dot`는 Linux/WSL에서 1 file / 10 tests skip으로 transform/import 확인. 실제 Windows 앱 launch/E2E 실행은 수행하지 않았다.

## 2026-06-27 보강 — OQ-04 ACP audio content raw 보존 확정

- 현재 구현은 ACP `audio` content를 전용 모델로 승격하지 않고 `AgentContent{type:"json"}` raw 블록으로 보존한다. composer audio capability는 v1에서 계속 false이며, inbound audio는 drop하지 않고 transcript/tool content의 raw JSON 표시 경계로 남긴다.
- `claude-acp-content.ts`/테스트명에서 `TODO(13)` 표현을 제거하고, 06/11/13/15 문서의 “드롭 vs raw 보존/결정 필요” 문구를 OQ-04 해소 상태로 갱신했다.
- 확인: `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-content.test.ts src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-session-update.test.ts` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-14/OQ-19 Codex approval 문서 drift 정리

- Codex generated decision enum(`CommandExecutionApprovalDecision`/`FileChangeApprovalDecision`)에 영구 거부 값이 없고, 구현은 공용 approval 경계의 `reject_always`를 `decline`으로 방어 매핑한다. v1 Codex command/fileChange UI는 `reject_always`를 노출하지 않으므로 11 §3.4/§9와 13 OQ-14를 해소 상태로 현재화했다.
- Codex `item/permissions/requestApproval`은 v1에서 사용자 승인 UI로 올리지 않고 `{permissions:{}, scope:"turn"}` 자동 decline으로 응답한다. 구현/테스트가 이미 있는 상태라 05 checklist와 13 OQ-19를 "v1 해소, 정식 permission grant UI는 후속"으로 정리했다.
- 11 §9의 OQ-52 항목도 구현 상태에 맞춰 표현을 좁혔다. 보수 기본값과 bounded eviction은 구현/테스트로 고정됐고, 남은 것은 대용량 세션 실측에 따른 운영 튜닝·TTL·heavy item cap이다.
- 확인: `npm test -- codex-wire-mapper codex-app-server-adapter` 통과(2 files, 56 tests), `rg "OQ-14|OQ-19|reject_always|permissions/requestApproval" docs/plans/agent-direct-runtime`로 잔여 문구 점검, `git diff --check` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-48 window registry 문서 drift 정리

- `agent-event-router.ts`와 `agent-event-router.test.ts`가 이미 OQ-48 결정을 구현/검증하고 있었다. registry는 sessionHandle별 소유 window label과 optional runtimeId 바인딩을 유지하고, window-close 시 해당 window의 엔트리만 dispose하며, 미등록/타 window sessionHandle dispatch는 거부한다.
- `pending-approval-table.test.ts`와 router의 same JSON-RPC id 테스트가 `(sessionHandle, requestId)` 복합 키 불변식을 고정하므로, 두 runtime이 같은 provider request id를 받아도 서로의 approval을 오응답하지 않는다.
- 13 OQ-48과 12 T1.4, 11 §8.1 checklist를 해소 상태/증거에 맞춰 갱신했다. cross-window dispatch telemetry counter는 현재 필수 구현이 아니라 운영 관측 필요 시 후속으로 남겼다.
- 확인: `npm test -- agent-event-router pending-approval-table` 통과(2 files, 16 tests), `rg "OQ-48|window-close|cross-window|sessionHandle, requestId" docs/plans/agent-direct-runtime`로 잔여 문구 점검, `git diff --check` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-55 mono font token 검증

- `UI_CSS_VARS.fontMonoStack = "--ui-font-mono-stack"`와 `getUiPreferenceTokenStyle`의 terminal font 재사용 경계는 이미 구현돼 있었지만 단위 테스트 증거가 없었다. `theme-bridge.test.ts`를 추가해 mono 토큰이 `settings.terminal.fontFamily`/`fontFamilyFallback`에서 산출되고 interface font와 섞이지 않음을 고정했다.
- 13 OQ-55와 08/11/15 문서를 해소 상태로 갱신했다. agent-runtime 전용 Settings 섹션은 v1에서 계속 만들지 않는다.
- 확인: `npm test -- theme-bridge` 통과(1 file, 1 test), `rg "OQ-55|fontMonoStack|--ui-font-mono-stack" docs/plans/agent-direct-runtime src/lib/ui src/lib/features/agent-runtime`로 잔여 문구 점검, `git diff --check` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-56 composer command/completion 범위 정리

- `/` 명령 팔레트는 구현 상태를 기준으로 고정했다. ACP `available_commands_update`는 이미 `available_commands_updated`로 변환되고, store는 `availableCommands`를 최신 목록으로 전체 교체하며, composer는 provider command와 로컬 `/resume`을 합성해 prefix filter/Enter·Tab 선택으로 draft를 채운다.
- 문서가 로컬 `/resume` 선택을 `AgentRuntimePort.resumeSession` 직접 호출처럼 설명하던 부분을 실제 구현에 맞게 정리했다. 현재 `resumeSession`은 host mount 시 `agentRuntime` metadata로 결정되는 lifecycle 경로이고, composer `/resume`은 v1에서 평문 prompt command다.
- `@` mention은 outbound adapter의 `AgentContent{type:"resource"}` 변환은 있으나 composer 검색 소스와 `embeddedContext` capability 전달이 없어 아직 미구현이다. `$`도 v1 보류 상태로 유지한다.
- 확인: `npm test -- claude-acp-adapter AgentComposer agent-runtime-store` 통과(3 files, 46 tests)로 ACP command event 변환, `/` 팔레트, `@`/`$` 비활성, store command replacement를 검증했다. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-57 ACP optimistic user echo 검증

- Claude ACP `sendPrompt`의 로컬 optimistic `user_message` echo는 현재 구현대로 v1에서 확정했다. active turn id `<sessionId>:t<n>`에 `:u`를 붙인 messageId를 쓰고, `session_status_changed:running` 전에 emit하며, content는 ACP prompt wire 변환본이 아니라 원본 `AgentContent[]`를 그대로 싣는다.
- 비텍스트 정확도 gap을 닫기 위해 `claude-acp-adapter.test.ts`에 image+resource content를 보낸 뒤 echo content가 원본과 같고, 다음 turn의 합성 messageId가 `<sessionId>:t<n+1>:u`로 유일한지 검증하는 테스트를 추가했다.
- 13 OQ-57은 v1 해소 상태로 갱신했다. 향후 ACP가 라이브 `user_message_chunk`를 도입하면 중복 렌더/dedupe 문제는 protocol drift 항목으로 다시 다룬다.
- 확인: `npm test -- claude-acp-adapter` 통과(1 file, 21 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-58 auto-follow/가상화 범위 정리

- `AgentTranscriptSurface`의 auto-follow는 이미 `.transcript-region` DOM 부수효과로 구현되어 있었다. 새 content 도착 시 `tick()`으로 바닥 추종을 합치고, 사용자가 위로 스크롤하면 `store.autoFollow=false`로 멈추며, 바닥 복귀 후 다시 추종한다.
- `MessageList`는 실제 scroll-window DOM 가상화가 아니라 residency eviction으로 bounded된 `visibleItemIds` 전체를 렌더한다. 08/13 문서의 "virtualized" 표현을 현재 구현에 맞춰 낮추고, `streamingItemId`+바닥 N개 always-mount는 DOM 가상화 도입 시 필요한 후속 불변식으로 분리했다.
- pending inline approval은 auto-follow 상태와 무관하게 `[data-approval-anchor]`를 `scrollIntoView({block:"nearest"})`로 끌어오는 경로를 테스트로 고정했다.
- 확인: `npm test -- AgentTranscriptSurface` 통과(1 file, 13 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-51 audit 영속 로그 경계 정리

- 현재 구현은 `ApprovalAuditTrail` in-memory entry만 제공한다. 결정 1건당 `requestId`/`optionId`/`optionKind`/`outcome`/`decidedAt`/`decidedBy` 등 메타만 저장하고, 명령 전문/credential/파일 내용/raw label은 타입 경계에 넣지 않는다.
- 09/12/13 문서에서 `opt-in redacted` 영속 로그가 v1 기본처럼 읽히던 표현을 낮췄다. v1 기본은 in-memory audit이며, 영속 로그는 후속 enhancement에서 저장 위치·보존기간·포맷을 확정한 뒤 별도 task/test로 추가한다.

## 2026-06-27 보강 — OQ-47 approval escalation 신호 보강

- Codex `codexApprovalSeverity`에 raw/future compatibility용 full-access mode 신호 감지를 추가했다. 현재 generated command/fileChange approval params에는 `sandbox` 필드가 없지만, `sandbox`/`sandboxRequested`/`sandboxMode`가 `danger-full-access`이거나 `permissionMode`/`approvalMode`가 `Agent (Full Access)`이면 inline이 아니라 escalation으로 분류한다.
- 기존 구현 신호(`item/permissions/requestApproval`, command exec/network policy amendment, fileChange `grantRoot`)와 Claude `bypassPermissions` 신호는 그대로 유지한다. OQ-47은 v1 핵심 신호 구현 상태로 낮추고, protected path/`commandActions`/experimental permission detail 위험도 확대만 후속으로 남겼다.

## 2026-06-27 보강 — OQ-46 reasoning completed 보수 매핑 고정

- generated `ThreadItem`은 Codex reasoning completed item에 `summary:string[]`와 `content:string[]`를 모두 가진다. 현재 mapper는 completed reasoning을 `channel:"thought"` 권위 이벤트로 emit하고, 보수 기본값으로 `summary[]` 뒤 `content[]`를 이어붙인다.
- 이 보수 매핑을 CX-5c로 문서화하고 테스트를 보강했다. 실제 wire 캡처에서 단일/우선 권위 필드가 확인되기 전까지 OQ-46은 해소가 아니라 "부분 구현 / 권위 필드 미확정"으로 둔다.

## 2026-06-27 보강 — OQ-53 late same-turn 상태 정리

- `agent-event-reducer`의 sealed-retained late-event 흡수 경로는 이미 구현돼 있다. NM-33은 늦은 delta가 unseal→patch→reseal로 반영되는지 보고, NM-33b는 late auxiliary `plan_updated` 뒤 추가 `turn_completed` 없이 reseal되는지 검증한다.
- OQ-53의 남은 미확정 범위를 실제 provider wire 발생 여부와 종류·타이밍으로 좁혔다. reducer/store event fixture로 분기 규칙은 고정됐고, adapter fixture/실측 보강은 실제 `turn_completed`/`stopReason` 후 보조 notification 캡처가 생길 때 진행한다.

## 2026-06-27 보강 — OQ-54 replay 범위 상태 정리

- Codex adapter의 `resumeSession({replay:true})`가 `thread/read{threadId, includeTurns:true}`를 보내는지 CX-2 테스트로 명시 고정했다. 응답의 `thread.turns[].items[]`는 completed item replay로 `session_loaded` 뒤 transcript event를 만든다.
- `runtime-replay`의 default loader는 OQ-54가 닫히기 전 실제 wire query를 하지 않는 안전한 no-op이고, 주입 loader로 read-only scratch transcript/live 미병합 경계만 검증한다. OQ-54는 구현 전체 미비가 아니라 Codex `thread/read(includeTurns)`의 실제 response 범위와 tombstone 조회 비용 미검증으로 좁혔다.

## 2026-06-27 보강 — OQ-42/OQ-43/OQ-44 Claude ACP 경계 확정

- OQ-42는 v1 부분 wire mirror로 해소했다. frontend/direct adapter 코드는 `@agentclientprotocol/sdk`를 직접 import하지 않고, `contracts/claude-acp.ts`가 필요한 ACP subset만 보유한다. sdk는 `@agentclientprotocol/claude-agent-acp` adapter process 의존성으로만 남긴다.
- OQ-43은 `DEFAULT_CLIENT_CAPABILITIES`를 보수값으로 명시했다. `fs.*`, `terminal`, `auth.terminal`, `auth._meta.gateway`, `_meta.terminal_output`, `_meta["terminal-auth"]`는 false이고, `elicitation.form/url`은 null로 미광고한다.
- OQ-44는 process-per-session v1로 해소했다. `shutdown`은 pending approval/RPC를 정리한 뒤 `shutdownRuntime(runtimeId)`만 호출하며, `session/close` wire는 보내지 않는다. multiplex 구조를 도입할 때만 close/delete/fork/list capability 처리를 다시 설계한다.
- 확인: RED 후 `npm test -- claude-acp-initialize claude-acp-adapter` 통과(2 files, 29 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-45 Claude ACP dist tool/settings 확인

- `@agentclientprotocol/claude-agent-acp@0.51.0` npm tarball에는 `src/`가 포함되지 않고 `dist/` artifact만 배포된다. 따라서 OQ-45는 `dist/tools.js`와 `dist/settings.js`를 기준으로 확인했다.
- `dist/tools.js`에서 `Write`/`Edit`와 `toolUpdateFromDiffToolResponse(structuredPatch)`는 ACP `ToolCallContent{type:"diff", path, oldText, newText}`를 낸다. `oldText`가 비면 `null`이며, structuredPatch 여러 entry는 여러 diff content로 표현된다. CLCOMX의 `mapToolCallContent`는 각 diff content를 `AgentContent{type:"diff", path, patch}`로 변환하므로 OQ-03도 함께 해소했다.
- `Bash`는 `clientCapabilities._meta["terminal_output"]===true`일 때 terminal content와 `_meta.terminal_info`/`terminal_output`/`terminal_exit`를 내고, v1처럼 false이면 console code block text content로 fallback한다. v1은 terminal output capability를 미광고하므로 `_meta` terminal stream 매핑은 후속 capability 활성화 때 설계한다.
- `dist/settings.js`의 `SettingsManager.loadAllSettings()`는 `resolveSettings({cwd})` 결과에 `filterEscalatingDefaultMode(resolved)`를 적용한다. repo-committed escalating default mode 필터는 provider adapter 쪽 trust policy에 맡기고, CLCOMX는 current mode/permission event를 표시·분류한다.
- 확인: `npm test -- claude-acp-content claude-acp-session-update` 통과(2 files, 28 tests), `git diff --check` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-17 direct surface unmount 회피 검증

- v1 late-attach 공백은 message seq/snapshot 재구성 없이 **surface를 process 생존 중 unmount하지 않는 방식**으로 회피한다. 기존 `SessionViewport.test.ts` FE-21은 active tab 전환이 keyed session shell destroy/remount를 만들지 않고 `visible` prop만 바꾸는지 검증한다.
- direct host 자체도 `visible=false`에서 `.hidden` CSS만 토글하고 runtime shutdown을 호출하지 않는지 `AgentTranscriptSurface.test.ts` OQ-17 테스트로 보강했다. 따라서 `AgentTranscriptSurface` 내부 store/subscription은 비활성 탭에서도 유지된다.
- OQ-17은 v1 surface-unmount 회피 관점에서 해소했다. message `seq` + snapshot/delta-since 기반 late-attach 재구성은 여전히 후속 기능이고, 실제 Windows 앱 E2E-9 실행은 전체 앱 검증 게이트로 남긴다.
- 확인: `npm test -- AgentTranscriptSurface -t OQ-17` 통과(1 file, 1 test; 13 skipped). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-20 Codex turn/start stable params 고정

- Codex `sendPrompt`의 `turn/start`는 v1에서 `{threadId, input}`만 보낸다. `approvalPolicy`/`sandboxPolicy`/`model`/`effort` override와 experimental `environments`/`permissions`/`collaborationMode`는 보내지 않고 provider/server default에 맡긴다.
- `codex-app-server-adapter.test.ts`의 OQ-20 테스트를 exact params assert로 강화해 override 필드가 섞여 들어오지 않도록 고정했다. settings/UI에서 model·effort·sandbox·approval override를 노출하는 것은 후속 기능으로 분리했다.
- 05 §2.4, 11 CX-4b, 13 OQ-20을 구현 상태와 같은 정본으로 갱신했다.

## 2026-06-27 보강 — OQ-41 preflight 레지스트리 상태 정리

- 13 OQ-41이 아직 "Phase 0 hard gate"처럼 남아 있었지만, 구현 로그의 T0.0/OQ-41 preflight는 이미 완료 상태다. 작업 루트/git root, Codex `0.142.2` generate-ts 수용, Claude adapter `0.51.0` 고정, ACP `@agentclientprotocol/sdk@0.29.0` package schema/dist + 부분 wire mirror 기준을 레지스트리에 반영했다.
- RD-7과 protocol drift 완화 문구도 `schema-v1.16.0`을 구현 핀이 아닌 baseline 후보로 낮추고, dependency refresh 시 OQ-41 절차를 반복하는 경계로 정리했다.

## 2026-06-27 보강 — OQ-31 distro/workDir 검증 경계 고정

- Rust start 경로는 `validate_and_extract`에서 빈 `distro`만 거부하고, `list_wsl_distros` 결과 집합으로 allowlist 대조하지 않는다. `workDir`는 `canonicalize_wsl_path`에서 Windows path/relative/`~`를 거부하고 문자열 레벨 POSIX 정규화만 수행한다.
- 이 v1 경계를 OQ-31 해소 상태로 정리했다. 실제 디렉터리 존재 확인(`WslShell::exec test -d`)은 UX 후속이며, v1 start 보안 경계는 문자열 검증 + backend-resolved executable/adapter entry allowlist다.

## 2026-06-27 보강 — OQ-05 composer Enter/Shift+Enter 확정

- `AgentComposer` 구현은 `Enter`를 전송, `Shift+Enter`를 개행/비전송으로 처리한다. slash command palette가 열려 있으면 `Enter`/`Tab`은 command 선택으로 소비되어 전송하지 않는다.
- 13 OQ-05와 08 composer 설명을 현재 구현·테스트와 맞춰 해소 상태로 갱신했다.

## 2026-06-27 보강 — OQ-06 탭 status badge 잔여 범위 명시

- v1 구현은 기존 탭 모델을 유지하고 `runtimeKind`로 PTY/direct host를 분기한다. 그러나 `SessionTabViewModel`은 아직 `AgentSessionStatus`를 받지 않고, `TabBar.svelte`의 badge는 PIN/LOCK뿐이다.
- 13 OQ-06을 "부분 구현 / turn status badge 후속"으로 낮췄고, 08의 `session_status_changed` 렌더 표에서 탭 badge를 구현 완료처럼 읽히던 표현을 composer/surface indicator로 정정했다.

## 2026-06-27 보강 — OQ-06 탭 status badge 구현

- `AgentTranscriptSurface`가 store status를 `onAgentRuntimeStatusChange`로 publish하고, `SessionShell`/`SessionViewport`/`App`을 통해 live session의 `agentRuntimeStatus`에 반영하도록 연결했다. 이 값은 탭 UI용 live 상태이며 workspace snapshot에는 저장하지 않는다.
- `SessionTabViewModel`에 `agentRuntimeStatus?: AgentSessionStatus`를 포함하고, `TabBar.svelte`가 i18n label/tooltip이 있는 작은 runtime status indicator를 표시하도록 구현했다. Zed식 sidebar/switcher는 도입하지 않고 기존 탭 모델을 유지한다.
- 확인: RED 후 `npm test -- TabBar session-store-mutations session-shell-adapter SessionViewport AgentTranscriptSurface` 통과(5 files, 40 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-47 Codex additionalPermissions escalation

- Codex command approval의 raw/future `additionalPermissions`를 generated `AdditionalPermissionProfile` shape 기준으로 방어 파싱한다. `network.enabled === true` 또는 filesystem `write[]`/`entries[].access === "write"`가 있으면 `severity:"escalation"`으로 올리고, read-only filesystem overlay는 `normal`로 둔다.
- `commandActions`는 현재 generated type이 `read`/`listFiles`/`search`/`unknown`이라 그 자체만으로는 escalation 근거가 부족해 후속으로 남겼고, `availableDecisions`는 현재 generated command approval params에 없어 wire 의미 확인 전까지 후속으로 유지한다.
- 확인: RED 후 `npm test -- codex-wire-mapper -t escalation` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — OQ-13 ACP status 합성 해소

- ACP는 `requires_action`을 별도 session status로 보내지 않으므로 CLCOMX client가 합성한다. 현재 구현은 `session/prompt` 전송 시 `running`, `session/request_permission` 수신 시 `requires_action`, permission resolve 후 pending이 없으면 `running`, `stopReason` 수신 시 `idle`로 전이한다.
- 이 경계는 이미 `claude-acp-adapter.test.ts` CL-7/CL-8/CL-19와 `agent-runtime-store.svelte.test.ts` NM-24/NM-25/NM-26 및 NM-12/13으로 고정돼 있었다. 13 OQ-13을 해소 상태로 갱신해 코드/수용 테스트와 레지스트리 상태를 맞췄다.

## 2026-06-27 보강 — OQ-12 ACP image data URI 해소

- ACP inbound `image{data,mimeType}`는 v1에서 파일 저장소로 쓰지 않고 `AgentContent.image.uri`의 data URI로 보존한다. provider가 `uri`를 함께 주면 해당 URI를 우선하고, composer outbound는 data URI에서 base64를 추출해 ACP `image{data,mimeType}`로 되돌린다.
- 대용량 이미지의 heap/표현 한도는 저장 정책 미확정이 아니라 OQ-52의 heavy-item/image cap 실측 범위로 남겼다. 06/13/15 문서를 현재 `claude-acp-content.ts`와 `claude-acp-content.test.ts` 증거에 맞춰 갱신했다.

## 2026-06-27 보강 — OQ-24 startup executable version preflight

- `agent_runtime::start`가 allowlist 검증과 `workDir` canonicalize를 통과한 뒤, spawn 전에 resolved executable의 `--version` preflight를 실행하도록 보강했다. 이 probe는 OQ-36 path cache와 별개로 startup마다 실행되며, 실패·빈 출력·상대경로 executable은 spawn 전 `Err(String)`으로 거부한다.
- settings UI의 `codexBin` override는 여전히 제품 결정 후속 범위다. strict ref pin 비교는 runtime start 자동 거부가 아니라 OQ-41 dependency refresh/schema diff 절차로 남겼다.
- 확인: RED 후 `cargo test --manifest-path src-tauri/Cargo.toml rs10` 통과(5 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — approval optionId wire guard

- 09 §2의 표시-선택 일치 원칙에 맞춰 provider wire 전송 직전 `optionId` 검증을 보강했다. Codex adapter는 `OPTION_KIND_TO_DECISION` 허용 집합 밖의 `optionId`를 reject하고, Claude ACP adapter는 pending `request.options[].id`에 없는 `optionId`를 reject한다.
- 알 수 없는 `optionId`는 silent decline/임의 ACP selected 응답으로 변환하지 않고 throw하여 wire 전송을 막는다. 검증은 pending을 선점하기 전에 수행되므로 pending은 재시도 가능 상태로 남는다.
- 확인: RED 후 `npm test -- codex-app-server-adapter claude-acp-adapter` 통과(2 files, 43 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — approval requestId controller guard

- 09 §2의 "실제 pending requestId만 응답" 요구를 사용자 action 경계에 구현했다. `AgentRuntimeController.approve`는 `pendingApprovals`와 `escalationApproval`에 없는 `requestId`를 port 호출 전에 거부한다.
- adapter 내부의 `!pending` no-op은 04 §4.2/§5의 늦은·중복 응답 멱등 규칙으로 유지한다. 즉 stale UI/user action은 controller에서 reject하고, cancel/shutdown/server-resolved race 후 늦게 도착한 내부 응답은 adapter가 계속 no-op 처리한다.
- 확인: RED 후 `npm test -- agent-runtime-controller` 통과(1 file, 9 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — Claude ACP process exit 멱등성

- 11 NM-18e를 추가해 같은 runtime의 exit 이벤트가 두 번 도착해도 `process_exited`/`approval_resolved`가 중복 emit되지 않는 요구를 명시했다. Codex adapter는 이미 해당 회귀 테스트가 있었고, Claude ACP adapter 테스트에 같은 중복 exit 검증을 추가했다.
- Claude ACP `shutdown()`은 shutdown 시작 시 `closed`를 세우지 않고 `tearingDown`만 세운 뒤 backend shutdown await 이후에 닫는다. 이 분리로 shutdown 진행 중 늦은 exit은 한 번 emit하고, exit 자체가 이미 처리된 뒤 들어온 중복 exit은 `closed` guard로 no-op 처리한다.
- 확인: RED 후 `npm test -- claude-acp-adapter` 통과(1 file, 23 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — 09 approval 보안 체크리스트 현재화

- 09 §3/§3.5의 approval wire shape, pending key 충돌, cleanup 멱등 항목을 현재 unit evidence에 맞춰 닫았다. Codex response는 `jsonrpc`를 싣지 않고, ACP response는 `jsonrpc:"2.0"`과 원본 id 타입을 보존한다.
- approval option label XSS 항목은 source inspection에만 기대지 않도록 `ApprovalInlineCard.test.ts`와 `ApprovalModal.test.ts`에 provider label HTML 비해석 회귀 테스트를 추가했다. Svelte interpolation text node 렌더링을 고정해 label을 코드/HTML로 실행하지 않는다.
- 확인: `npm test -- ApprovalInlineCard ApprovalModal` 통과(2 files, 11 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — 09 allowlist/redaction/persistence 체크리스트 현재화

- 09 §4의 backend-resolved executable, Codex/Claude exact args, env key allowlist, shell 비경유 spawn, 권한 상승 env 차단, secret env argv 비경유 항목을 현재 Rust evidence에 맞춰 닫았다. 증거는 `agent_runtime::tests` RS-8/8b/9/9b/10c/10d/10e/10f/10g/11/12/12b/AC-10b와 `allowlist.rs`/`process.rs` 경계다.
- 09 §5는 직접 증명된 항목만 닫았다. `rawInput`/`rawOutput`와 transcript 표시 redaction은 frontend 표시 직전 redaction 테스트로, secret env argv 비경유와 websocket `authToken` reject-before-log는 Rust tests로 닫았다. 반면 “검증 실패 사유를 stderr/audit에 남김”, auth passthrough, MCP env masking, adapter env secret 금지는 아직 별도 증거가 부족해 열린 상태로 유지했다.
- 09 §7 persistence scrub은 `workspace`/`history`/`AgentRuntimeSnapshot` 타입과 테스트 증거에 맞춰 닫았다. `providerSessionId`/`providerThreadId`/`providerResumeToken`은 저장 직전 scrub되고, `workspace.json` 직접 grep 테스트에서도 평문 부재를 검증한다.

## 2026-06-27 보강 — launch env secret guard

- Codex/Claude launch helper가 `AgentRuntimeStartParams.env`를 만들기 전에 secret-shaped env key/value를 거부하도록 공통 guard를 추가했다. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `Bearer ...`, `sk-...` 같은 값은 frontend adapter 경계에서 start params로 내려가지 않는다.
- 거부 오류는 provider와 env key만 포함하고 value 원문은 포함하지 않는다. backend의 provider별 env key allowlist와 secret env argv 비경유 검증은 계속 2차 방어선으로 유지한다.
- 확인: RED 후 `npm test -- codex-launch claude-acp-launch` 통과(2 files, 4 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — command output stderr 분리와 redaction

- `command_output_delta.stream`을 reducer가 실제로 반영해 execute tool call의 terminal content를 stdout(`output`)과 stderr(`stderr`) 버퍼로 분리 누적하도록 보강했다. 15 `AgentContent{type:"terminal"}` 계약에도 선택적 `stderr` 필드를 추가했다.
- `CommandOutputCard`는 stdout/stderr 모두 표시 직전에 `redactDisplayText`를 거치며, stderr는 계속 기본 collapsed로 유지한다. `ToolCallCard`는 terminal content의 `stderr`를 누락하지 않고 embed로 전달한다.
- long-session residency byte cap 계산도 terminal `stderr`를 포함하도록 맞췄다. stderr가 큰 execute output을 stdout-only로 과소평가하지 않는다.
- 확인: RED 후 `npm test -- agent-event-reducer CommandOutputCard ToolCallCard` 통과(3 files, 41 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — raw JSON-RPC envelope 표시 차단

- `ProviderRef.raw`/tool raw는 라우팅·진단용으로 계속 보존하되, transcript raw detail 표시 문자열 생성 시 JSON-RPC envelope shape를 `[REDACTED_JSONRPC_ENVELOPE]` placeholder로 치환한다. 즉 `jsonrpc`/`method`/`params`/`result`/`error` envelope 자체를 transcript에 노출하지 않는다.
- credential redaction은 envelope 치환 후 그대로 적용된다. 원본 normalize/store raw 보존 규칙(NM-21/22)은 바꾸지 않았다.
- 확인: RED 후 `npm test -- display-redaction -t "JSON-RPC envelopes"` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — 09 §8 tool raw/env 체크리스트 현재화

- 09 §8의 tool `content`/`rawOutput` 분리 항목을 현재 구현 증거에 맞춰 닫았다. `ToolCallCard.svelte`는 일반 표시 content와 `rawInput`/`rawOutput` raw block을 분리하고, raw detail은 `stringifyRedactedRaw` 표시 경계를 거친다.
- `IS_SANDBOX` 등 bypass 게이트 우회 env 차단 항목도 §4 allowlist 구현 증거와 연결해 닫았다. provider별 env allowlist에 없는 key는 `Err(String)`으로 거부되며, `IS_SANDBOX`는 허용 목록에 없다.
- 남은 09 §8 범위는 client tool side effect approval, Codex/Claude session badge, bypass/full-access 경고, legacy PTY 구조화 권한 경고다. 이번 보강은 이미 구현된 증거의 문서 현재화만 포함한다.

## 2026-06-27 보강 — legacy PTY 구조화 권한 경고

- `SessionShell.svelte`의 PTY host 분기에 legacy permission boundary notice를 추가했다. 이 notice는 direct runtime과 같은 구조화 approval/sandbox 보장을 제공하지 않는다는 09 §8.4 경계를 사용자에게 표시한다.
- notice 문자열은 `agentRuntime.fallback.legacyPermissionTitle`/`legacyPermissionDescription` i18n key로 관리하고, direct runtime host(`runtimeKind="direct-*"`)에는 렌더하지 않는다.
- 확인: RED 후 `npm test -- SessionShell` 통과(1 file, 2 tests). GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — Codex sandbox/approval session badge

- Codex `thread/start`와 `thread/resume` 응답의 `sandbox`/`approvalPolicy`/`approvalsReviewer`를 `SessionStartResult`와 `AgentRuntimeMetadata`로 승격했다. `SandboxPolicy` object shape는 badge용 kebab-case(`read-only`, `workspace-write`, `danger-full-access`, `external-sandbox`)로 축약하고, granular approval policy는 `granular`로 표시한다.
- `AgentTranscriptSurface.svelte` metadata strip에 Sandbox/Approval/Reviewer 항목을 추가했다. 이 값은 provider sandbox를 우회하거나 client-side override를 만들지 않고, 09 §8.2의 "표시만" 원칙에 따라 session badge로만 노출된다.
- 표시용 policy metadata는 secret/resume handle이 아니므로 Rust `AgentRuntimeMetadataRecord`에도 추가해 workspace persistence scrub 후 보존한다. 기존 scrub 대상(`providerSessionId`/`providerThreadId`/`providerResumeToken`)은 계속 제거된다.
- 확인: RED 후 `npm test -- codex-app-server-adapter -t metadata`, `npm test -- AgentTranscriptSurface -t "Codex sandbox"`, `cargo test --manifest-path src-tauri/Cargo.toml sanitize_workspace_for_persist_strips_agent_runtime_secrets` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — Claude permission/session mode badge

- Claude ACP `session/new`/`session/load`/`session/resume` result의 `modes.currentModeId`와 `configOptions[id="mode"].currentValue`를 `SessionStartResult`/`AgentRuntimeMetadata`의 `sessionMode`/`permissionMode`로 승격했다. `configOptions` mode 값은 Claude SDK `permissionMode`와 같은 id라는 ref-claude-agent-acp §3 사실에 맞춰 badge 표시값으로만 사용한다.
- `current_mode_update`와 `config_option_update` notification은 `runtime_metadata_changed` event를 emit한다. controller는 이 event를 transcript store에는 그대로 전달하되, 별도 metadata patch callback으로 `AgentTranscriptSurface`에 넘겨 persistence metadata와 Permission Mode/Session Mode badge를 갱신한다.
- 표시용 mode metadata는 secret/resume handle이 아니므로 Rust `AgentRuntimeMetadataRecord`에도 추가해 workspace persistence scrub 후 보존한다. 기존 scrub 대상(`providerSessionId`/`providerThreadId`/`providerResumeToken`)은 계속 제거된다.
- 확인: RED 후 `npm test -- claude-acp-adapter AgentTranscriptSurface`, `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime_secrets` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — bypass/full-access metadata warning

- `AgentTranscriptSurface` metadata strip에서 `danger-full-access`, `bypassPermissions`, `Agent (Full Access)` 계열 값을 고위험 badge로 표시하도록 보강했다. provider sandbox/mode를 바꾸거나 client-side override를 만들지 않고, 09 §8.3의 고위험 상태를 계속 visible하게 만드는 표시 전용 경계다.
- 고위험 metadata item에는 `data-risk="high"`와 `agentRuntime.metadata.highRisk` 라벨이 붙는다. approval request 단계의 modal escalation과 session metadata warning을 분리해, 이미 고위험 모드에 들어간 세션도 metadata strip에서 계속 드러나게 했다.
- 확인: RED 후 `npm test -- AgentTranscriptSurface -t "bypass/full-access"` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — Claude `--hide-claude-auth` 기본 정책

- Claude ACP launch argv를 `[adapterEntryPath]`에서 `[adapterEntryPath, "--hide-claude-auth"]`로 고정했다. v1은 terminal/gateway interactive auth capability를 광고하지 않고, adapter process에도 구독 로그인 method 노출 축소 플래그를 기본으로 붙인다.
- Rust allowlist도 같은 정확 argv만 허용한다. 따라서 renderer가 hide flag를 빼거나 임의 플래그(`--x`)를 추가하는 경우, 또는 임의 `.js` entry를 넣는 경우는 spawn 전에 거부된다.
- 06/07/09/11/12/13/14/15 문서의 Claude args 계약을 새 정책과 동기화했고, 09 §9의 기본 인증 경로 및 `--hide-claude-auth` 체크 항목을 닫았다.
- 확인: RED 후 `npm test -- claude-acp-launch`, `cargo test --manifest-path src-tauri/Cargo.toml rs9 -- --nocapture`, `cargo test --manifest-path src-tauri/Cargo.toml rs12b -- --nocapture` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — pagehide/webview reload direct runtime cleanup

- `AgentTranscriptSurface`의 teardown 경계를 `onDestroy`뿐 아니라 `pagehide`/`beforeunload`에도 연결했다. 세 경로 모두 idempotent `disposeSurfaceRuntime()`을 공유하므로 탭 닫힘, component unmount, webview reload가 동일하게 controller shutdown을 시작하고 중복 shutdown은 막는다.
- controller dispose는 기존 Finding 3 계약대로 unsubscribe 전에 `port.shutdown()`을 await한다. 따라서 adapter가 shutdown 중 pending approval/RPC cleanup event를 emit해도 listener가 살아 있어 store/audit 경계까지 도달한다.
- 09 §3.5의 "UI/탭 close 또는 webview reload 시 backend pending이 끊긴 채 남지 않는가" 항목을 현재 증거로 닫았다. 실제 Windows 앱 reload E2E는 수행하지 않았고, 이 slice는 component/page lifecycle 단위 경계 보강이다.
- 확인: RED 후 `npm test -- AgentTranscriptSurface -t "pagehide"`, `npm test -- AgentTranscriptSurface agent-runtime-controller` 통과. GUI launch/E2E는 수행하지 않았다.

## 2026-06-27 보강 — approval 표시 i18n 및 client tool 부수효과 경계

- Codex approval mapper가 `ApprovalRequest.title`/`ApprovalOption.label`에 넣는 `agentRuntime.approval.*` key가 UI에서 그대로 보이던 결함을 보강했다. `approval-display.ts`를 추가해 CLCOMX 내부 key는 현재 locale 문자열로 변환한 뒤 기존 redaction을 적용하고, provider raw 문자열은 raw text로 유지한다.
- RED: `ApprovalInlineCard.test.ts`/`ApprovalModal.test.ts`의 approval title/option key 번역 테스트가 기존 구현에서 key 문자열 그대로 렌더링되어 실패했다.
- GREEN: `ApprovalInlineCard`/`ApprovalModal` 전체 테스트와 `key-parity.test.ts`가 통과했다. `agentRuntime.approval.command/fileChange/allowOnce/allowAlways/rejectOnce/rejectAlways` en/ko key를 추가하고 필수 key guard도 보강했다.
- `09 §8.1` client tool 부수효과 경계는 v1 보수 정책으로 닫았다. Claude ACP는 fs write/terminal/auth terminal/terminal_output capability를 광고하지 않고, Codex는 app-server initialize `capabilities:null`이며, `item/tool/call`·`applyPatchApproval`·`execCommandApproval`은 `-32601 method not found`로 거부되어 approval UI/event나 부수효과를 만들지 않는다.
- 증거: `claude-acp-initialize.test.ts` OQ-43, `codex-app-server-adapter.test.ts` SEC-CLIENT-TOOLS/CX-12..15, `codex-wire-mapper.test.ts` CX-11/CX-15b. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-27 보강 — launch reject audit redaction

- 09 §4의 "allowlist 검증 실패 시 `Err` 거부 + redacted audit 기록" 공백을 Rust handler 경계에서 보강했다. `validate_launch_for_start` wrapper가 `allowlist::validate_and_extract` 실패를 원래 `Err`로 반환하면서 `agent-runtime-audit.log`에 `launchRejected` JSONL entry를 남긴다.
- audit entry는 `event`/`atMs`/`transportKind`/redacted `provider`/redacted `reason`만 저장하고, renderer가 보낸 `args`/`env`/`workDir`/`authToken` 등 start params 전체는 직렬화하지 않는다. `start()`의 `workDir` canonicalize, executable version preflight, spawn 실패도 같은 audit helper를 거친다.
- RED: `agent_runtime::tests::rs12d_allowlist_failure_writes_redacted_launch_audit`가 `validate_launch_for_start` 미구현 상태에서 compile 실패했고, 초기 구현은 secret-shaped 값을 audit redaction 증거로 고정하지 못해 실패했다.
- GREEN: allowlist 오류 문자열이 임의 provider/args/adapterEntryPath/arg 값을 그대로 echo하지 않도록 정리하고, secret-shaped provider 거부가 `[REDACTED]`로 기록되며 원문 `sk-super-secret`이 audit에 남지 않음을 RS-12d로 고정했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml rs12d_allowlist_failure_writes_redacted_launch_audit -- --nocapture`, `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime -- --nocapture` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-27 보강 — runtime env value redaction context

- 09 §5의 env value 평문 노출 경계를 backend transport에서 한 단계 보강했다. `AgentRuntime`이 launch env value 목록을 보관하고, stderr diagnostic event와 opt-in raw protocol debug log를 만들 때 기존 secret-pattern redaction에 이 literal value 목록을 추가 적용한다.
- raw protocol message event 자체는 adapter routing/normalization을 위해 기존 M-4 무손실 통과 계약을 유지한다. 따라서 09 §5의 "모든 로그/이벤트/디스크" 체크박스는 아직 열린 상태이며, 이번 slice는 backend stderr/debug-log 쓰기 직전 경계만 닫는다.
- RED: `transport::redact_tests::masks_runtime_env_values_even_when_not_secret_shaped`가 `redact_with_values` 미구현으로 실패했고, `agent_runtime::tests::e2e10_raw_protocol_debug_log_redacts_runtime_env_values`가 `ReaderShared.redaction_values` 부재로 실패했다.
- GREEN: `redact_with_values`와 `ReaderShared.redaction_values`를 추가하고, `start`/`send`/test-mode mock inbound 경로가 runtime별 redaction context를 넘기도록 연결했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml masks_runtime_env_values_even_when_not_secret_shaped -- --nocapture`, `cargo test --manifest-path src-tauri/Cargo.toml e2e10_raw_protocol_debug_log_redacts_runtime_env_values -- --nocapture` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-27 보강 — direct runtime provider 라벨/로고 asset 회귀 방지

- 09 §9의 제품 오인 방지 경계 중 direct runtime launcher/provider 표시를 보강했다. direct history metadata, history 삭제 확인, direct runtime 토글 활성 상태의 agent trigger는 기존 PTY agent label(`Claude Code`) 대신 `launcher.directRuntime.providerLabel` i18n key(`제공자: Claude`/`Provider: Claude`)를 사용한다.
- built-in `AgentIcon` 메타데이터는 Claude/Codex 공식 로고 asset을 도입하지 않았음을 명확히 했다. 현재 렌더링은 `light`/`dark`/`monochrome` 이미지 없이 중립 fallback text만 사용한다.
- RED: `SessionLauncher.test.ts` direct history provider wording 테스트가 기존 `Claude Code · Ubuntu` 표시로 실패했고, `registry.test.ts` icon metadata 테스트가 "official asset" 안내 문구로 실패했다.
- GREEN: direct runtime 표시 helper와 `providerLabel` i18n key를 추가하고, built-in icon license note를 "logo asset 미번들" 설명으로 정리했다. direct toggle 선택 표시 테스트도 추가해 launcher 현재 선택 라벨 회귀를 막았다.
- 확인: `npm run test -- --run src/lib/features/launcher/view/SessionLauncher.test.ts src/lib/agents/registry.test.ts` 통과(2 files, 12 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-27 보강 — MCP env 표시/로그 redaction

- 09 §5의 MCP server `env` 마스킹 경계를 frontend 표시와 backend opt-in raw debug log 양쪽에서 보강했다. raw detail 표시는 `env` object의 key를 보존하되 value를 `[REDACTED]`로 치환하고, backend JSON redaction도 동일하게 `env` object value를 기록 직전 숨긴다.
- 원본 raw event/store 계약은 바꾸지 않았다. frontend는 `stringifyRedactedRaw`의 표시 전 scrub 단계에서만 처리하고, backend는 debug log/stderr redaction 경계에서만 처리한다.
- RED: `display-redaction.test.ts` MCP env 표시 테스트가 `workspace-alpha`/`enabled` 원문 노출로 실패했고, Rust `masks_env_object_values_in_json` 및 `e2e10_raw_protocol_debug_log_redacts_mcp_env_values`도 `[REDACTED]` 부재로 실패했다.
- GREEN: frontend `scrubEnvValuesForDisplay`와 Rust `redact_env_object_values`를 추가해 `env` map 값만 마스킹했다.
- 확인: `npm run test -- --run src/lib/features/agent-runtime/view/display-redaction.test.ts`, `cargo test --manifest-path src-tauri/Cargo.toml masks_env_object_values_in_json -- --nocapture`, `cargo test --manifest-path src-tauri/Cargo.toml e2e10_raw_protocol_debug_log_redacts_mcp_env_values -- --nocapture` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-27 문서 현재화 — auth passthrough 미노출 경계

- 09 §5의 auth passthrough 점검 항목을 v1 보수 정책 증거와 연결했다. Claude ACP initialize는 `auth.terminal=false`, `_meta["terminal-auth"]=false`, `auth._meta.gateway=false`를 광고하고, Claude launch args는 `--hide-claude-auth`를 강제하므로 `--cli auth login` UI/terminal passthrough 경로를 열지 않는다.
- provider가 auth 관련 diagnostic을 stderr로 출력하는 경우에는 backend `agent-runtime-stderr` emit 직전 `redact_with_values`를 거치며, frontend stderr/command output 표시는 기본 collapsed + 표시 직전 redaction 경계에 남는다.
- 새 코드 변경은 없고 기존 증거(`claude-acp-initialize.test.ts` OQ-43, `claude-acp-launch.test.ts`, `agent_runtime::tests` RS-9/9b 및 stderr redaction tests, `CommandOutputCard.test.ts`)를 09 §5 체크리스트에 연결했다.

## 2026-06-28 문서 현재화 — Codex CLI/generated type 재확인

- 01 §4.1과 05 §11의 Codex 구현 전 체크리스트를 현재 로컬 CLI 증거로 동기화했다. `codex --version`은 `codex-cli 0.142.2`였고, `codex app-server --help`는 `generate-ts`, `generate-json-schema`, `--listen`을 표시했다. `generate-ts --help`는 `--out <DIR>`와 optional `--experimental` 생성 옵션을 표시했다.
- `/tmp/codex-gen.nHNf7l`에 `codex app-server generate-ts --out /tmp/codex-gen.nHNf7l`로 fresh 생성한 뒤 `diff -qr`로 저장소의 `src/lib/features/agent-runtime/generated/codex-app-server/`와 비교했다. 차이는 저장소 전용 `README.md`뿐이었다.
- `ClientInfo`/`InitializeCapabilities`/`InitializeParams` 필드는 generated type으로 확인했고, v1 adapter는 experimental surface를 열지 않는 `capabilities:null`을 유지한다. `initialize`→`initialized`는 H4/OQ-07 기본값대로 항상 수행한다.
- standalone `command/exec`는 13 OQ-21 결정대로 v1 미지원 후속 범위이며, websocket/auth token redaction 정책은 09 §5/07 RD-2/RS-12c·RS-18 증거와 연결했다.

## 2026-06-28 문서 현재화 — Claude adapter 로컬 핀/CI 체크

- 01 §4.3/§4.4의 Claude adapter 로컬 체크를 현재 manifest/CI 증거와 동기화했다. `package.json`은 `@agentclientprotocol/claude-agent-acp`를 exact `0.51.0`으로 갖고 있었지만, `package-lock.json` 루트 dependency가 stale `^0.51.0`으로 남아 있어 exact `0.51.0`으로 보정했다.
- `npm ls @agentclientprotocol/claude-agent-acp @agentclientprotocol/sdk --depth=1` 결과는 `@agentclientprotocol/claude-agent-acp@0.51.0` → `@agentclientprotocol/sdk@0.29.0`이다. `node --version`은 `v24.11.1`로 adapter engine `>=22` 조건을 만족한다.
- deprecated `@zed-industries/claude-code-acp`는 package manifest/lock dependency에 없다. `.github/workflows/test.yml`은 `npm run test`를 실행하므로 `claude-acp-initialize/session-update/adapter` 회귀 테스트가 CI에 포함된다.

## 2026-06-28 문서 현재화 — ACP discriminator/diff 체크 정리

- 01 §4.2의 `agent_thought_chunk`/`user_message_chunk` discriminator 확인과 ACP diff 변환 규칙 항목을 기존 구현 증거와 연결해 닫았다.
- `contracts/claude-acp.ts`는 sdk 0.29.0 기준 `session/update` 13종 discriminant를 부분 mirror하고, `claude-acp-session-update.test.ts`는 `user_message_chunk`와 `agent_thought_chunk → channel:"thought"` 매핑을 검증한다.
- `ToolCallContent{type:"diff", path, oldText, newText}`는 `claude-acp-content.ts`에서 unified patch로 변환하고, `claude-acp-content.test.ts`가 일반 diff와 `oldText=null` 신규 파일(`/dev/null`)을 고정한다.
- ACP public release/tag 최신 대조와 Anthropic 약관/브랜딩 guideline 확인은 외부 최신 공식 소스 확인이 필요해 계속 열린 상태로 남겼다.

## 2026-06-28 문서 현재화 — direct runtime auto-approve 설정 미노출 확인

- 09 §2의 auto-approve 설정 토글 체크를 현재 구현 증거와 연결해 닫았다. v1 direct runtime에는 client측 auto-approve 설정/UI가 없고, settings registry도 `interface`/`workspace`/`terminal`/`editor`/`storage`/`history`만 노출한다.
- 혼동 가능한 `terminal.claudeCliFlags.enableAutoMode`는 legacy PTY Claude CLI 시작 시 `--enable-auto-mode`를 붙이는 터미널 플래그다. `src/lib/pty.ts`의 legacy `getAgentCommandOptions()` 경로에서만 소비되며 direct runtime approval 자동 허용과 무관하다.
- 향후 자동 결정 경로가 생겨도 현재 store audit 경계는 `decidedBy:"auto"`를 포함해 user/auto/cleanup 결정 1건당 audit entry 1건과 비밀 비포함을 검증한다(`agent-runtime-store.svelte.test.ts` NM-20b/20c). 새 코드 변경은 없고 문서 증거만 현재화했다.

## 2026-06-28 문서 현재화 — direct runtime 공식 로고/카피 복제 경계 확인

- 09 §9의 공식 로고·ASCII art·공식 카피 복제 금지 항목을 현재 UI 증거와 연결해 닫았다. built-in `AgentIcon` 메타데이터는 Claude/Codex 공식 로고 asset(`light`/`dark`/`monochrome`)을 번들하지 않고, `AgentIcon.svelte`는 asset이 없으면 중립 fallback text(`Cl`/`Cx`)만 렌더한다.
- `Claude Code` 명칭은 legacy PTY agent label과 Terminal settings의 Claude CLI 옵션 설명처럼 실제 CLI/legacy terminal 경로를 가리키는 기술적 참조에만 남아 있다. direct runtime launcher/history는 `launcher.directRuntime.providerLabel`(`제공자: Claude`/`Provider: Claude`)을 사용해 공식 앱명처럼 표시하지 않는다.
- 증거는 `agents/icons.ts`, `AgentIcon.svelte`, `registry.test.ts`, `SessionLauncher.test.ts`, UI copy `rg` 점검이다. 외부 최신 Anthropic 약관/브랜딩 guideline 재확인은 01 §4.4/09 §9 결정 필요 항목으로 계속 별도 유지했다.

## 2026-06-28 문서 현재화 — ACP public schema / Anthropic 공식 guideline 재확인

- 01 §4.2의 ACP public release/schema 대조 항목을 현재 공식 근거로 닫았다. `agent-client-protocol` 공식 tag 목록의 latest는 `v1.1.0`이고, `schema/v1/{meta.json,schema.json}` artifact가 존재한다. `meta.version=1`, `agent-client-protocol-schema/src/version.rs`의 `LATEST=V1`로 stable wire `protocolVersion=1`은 유지된다.
- schema 표면은 현재 public `v1.1.0`과 pinned SDK 0.29.0이 다르다. public `v1.1.0`의 `SessionUpdate`는 11종이고, 로컬 `@agentclientprotocol/sdk@0.29.0` package schema는 `plan_update`/`plan_removed`를 포함한 13종이다. 따라서 현 구현 기준은 13 OQ-41/RD-7처럼 `@agentclientprotocol/claude-agent-acp@0.51.0` → `@agentclientprotocol/sdk@0.29.0` package schema/dist + CLCOMX 부분 wire mirror로 유지한다. npm latest `@agentclientprotocol/claude-agent-acp@0.52.0`/`@agentclientprotocol/sdk@1.0.0`은 임의 상향하지 않는다.
- 01 §4.4/09 §9/13 OQ-09의 Anthropic Agent SDK auth/branding 항목도 공식 overview 근거로 닫았다. third-party product는 Claude app credentials/rate limits를 제공할 수 없고 API key 사용을 권장하며, branding guidelines는 Anthropic이 만든/후원/보증한 제품처럼 암시하지 말라고 요구한다. v1의 중립 provider label, terminal/gateway auth 미광고, `--hide-claude-auth` 정책은 이 경계와 정합한다.

## 2026-06-28 보강 — bounded replay log env redaction

- 09 §5의 env value 평문 노출 경계를 diagnostic-only bounded replay log까지 확장했다. `record_and_emit_message`는 `agent-runtime-message` realtime event의 raw value 무손실 통과(M-4)는 유지하되, `message_log`에 저장하는 line은 runtime env value redaction context를 통과한 뒤 보관한다.
- RED: `agent_runtime::tests::d_replaylog_redacts_runtime_env_values_without_redacting_realtime_event`가 기존 구현에서 `message_log`에 `SAFE_VALUE_123` 원문이 남아 실패했다.
- GREEN: replay log 저장분에 `redact_with_values`를 적용하고, 동일 테스트에서 저장 로그는 `[REDACTED]`, realtime captured message는 원문 유지임을 고정했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml d_replaylog_redacts_runtime_env_values_without_redacting_realtime_event -- --nocapture` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — short env literal redaction overreach 방지

- runtime launch env value literal redaction이 `CODEX_DISABLE_UPDATE_CHECK=1` 같은 짧은 non-secret 값까지 전역 치환하면서 JSON-RPC `id:1`/`count:10` 같은 정상 payload를 훼손할 수 있는 경계를 보강했다.
- RED: `transport::redact_tests::short_runtime_env_values_do_not_corrupt_unrelated_json_fields`가 기존 구현에서 `"id":1`이 `"id":"[REDACTED]"` 계열로 깨져 실패했다.
- GREEN: literal env value redaction은 충분히 긴 식별값에만 적용하고, 기존 `SAFE_VALUE_123` runtime env redaction 테스트는 계속 통과하도록 유지했다. 이 변경은 raw realtime event 계약에는 영향을 주지 않고 diagnostic/debug 문자열 redaction 범위만 조정한다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml runtime_env_values -- --nocapture` 통과(4 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — test-mode initialize fixture reuse

- 12 T2.5의 "backend test-mode mock도 adapter fixture `.jsonl`을 단일 출처로 재사용" 요구 중 deterministic initialize handshake부터 fixture 우선 경로로 전환했다. Rust mock은 `codex-initialize.jsonl`/`claude-initialize.jsonl`의 `{direction,message}` envelope를 읽어 현재 outbound `initialize` request에 대응하는 inbound response block을 compact JSON line으로 emit한다.
- request id는 fixture id를 그대로 쓰지 않고 실제 outbound id로 재매핑하므로 adapter의 JSON-RPC routing 계약은 유지된다. prompt stream/approval처럼 입력값에 따라 동적으로 달라지는 test-mode mock은 아직 기존 generator fallback이 담당한다.
- RED: `agent_runtime::tests::rs19_mock_jsonrpc_responses_are_valid_and_provider_specific`가 기존 hardcoded `codex-test-mode`/`claude-test-mode` initialize 응답 때문에 실패했다.
- GREEN: initialize는 fixture 응답을 사용하고 나머지 mock 시나리오는 기존 JSON 유효성 검증을 계속 통과한다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml rs19_mock_jsonrpc_responses_are_valid_and_provider_specific -- --nocapture` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — Claude lifecycle fixture reuse 확대

- test-mode mock의 fixture 재사용 범위를 Claude `session/new`/`session/load`까지 넓혔다. Rust mock은 `claude-initialize-session-new.jsonl`과 `claude-session-load-replay.jsonl`도 후보로 탐색해, 현재 outbound method와 일치하는 `{direction:"out"}` 뒤의 inbound block을 emit한다.
- fixture response id는 실제 outbound id로 재매핑한다. `session/prompt`는 E2E prompt echo와 approval/cancel 시나리오가 입력값에 따라 달라지므로 기존 dynamic generator fallback을 유지한다.
- RED: `agent_runtime::tests::rs19_mock_jsonrpc_responses_are_valid_and_provider_specific`에서 `session/new`가 fixture의 `sess-1` 대신 hardcoded `s-mock`을 반환해 실패했다.
- GREEN: Claude lifecycle fixture 후보 탐색을 추가하고, `session/new`는 `sess-1`, `session/load`는 replay update block + 실제 id 재매핑을 반환하도록 고정했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml rs19_mock_jsonrpc_responses_are_valid_and_provider_specific -- --nocapture` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — fixture matcher params 경계

- backend test-mode fixture matcher가 `{direction:"out"}`의 `method`만 비교하면, 향후 `session/prompt` fixture를 후보에 넣었을 때 임의 prompt가 고정 fixture stream으로 오인될 수 있는 경계를 보강했다.
- direct fixture replay helper는 기본적으로 fixture outbound `params`와 실제 outbound `params`가 일치할 때만 inbound block을 반환한다. 단 provider lifecycle mock(`initialize`/`session/new`/`session/load`)은 cwd처럼 환경별로 달라질 수 있는 params가 있어 기존처럼 명시적으로 params mismatch를 허용하는 경로를 사용한다.
- RED: `agent_runtime::tests::rs19b_fixture_replay_does_not_match_different_prompt_params`가 `session/prompt` method만 보고 fixture를 잘못 매칭해 실패했다.
- GREEN: matcher에 params 일치 요구 옵션을 추가하고, lifecycle mock 후보 호출과 direct fixture replay 검증의 경계를 분리했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml rs19 -- --nocapture` 통과(2 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — fixture replay routing literal 재작성

- Claude `session/load` lifecycle fixture는 params mismatch를 허용해야 실제 workDir/sessionId가 다른 test-mode E2E에서도 재사용 가능하다. 대신 fixture-local routing literal(`sessionId`/`threadId`/`turnId`)이 inbound replay notification에 그대로 새지 않도록, fixture outbound params와 실제 outbound params의 값을 비교해 response block 안의 동일 literal을 실제 값으로 재작성한다.
- JSON-RPC response `id` 재매핑과 같은 mock fixture 경계에서 처리하며, 일반 문자열 부분 치환이 아니라 값 전체가 fixture-local literal과 같을 때만 바꾼다.
- RED: `agent_runtime::tests::rs19c_fixture_replay_remaps_claude_session_load_session_id`가 `session/load` replay notification에 `sess-1`이 남아 실패했다.
- GREEN: fixture response block 직렬화 전에 routing literal 재작성 helper를 적용해 `sess-custom` 같은 실제 요청 session id로 replay가 emit되도록 고정했다.
- 확인: `cargo test --manifest-path src-tauri/Cargo.toml rs19c_fixture_replay_remaps_claude_session_load_session_id -- --nocapture` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — resume replay 복원 중 UI 잠금

- 08 §9.3의 `session/load` replay 중 "복원 중" 상태 + composer 잠금 요구를 `AgentTranscriptSurface`/`AgentComposer`에 연결했다. host는 `resumeSession(... replay:true)`가 pending인 동안 `resumeReplayPending`을 켜고, surface status는 `agentRuntime.status.restoring`, composer placeholder는 `agentRuntime.composer.restoring`을 표시한다.
- 입력 활성/stop 버튼 게이트도 `restoring` 플래그를 함께 보게 해, store status가 일시적으로 `ready`/`running`으로 변해도 replay 복원이 끝나기 전에는 새 prompt를 보내지 못하게 한다.
- RED: `AgentTranscriptSurface.test.ts`의 `shows restoring state and locks the composer while resume replay is pending`가 기존 구현에서 `Starting…`/`Input unavailable`만 보여 실패했다.
- GREEN: `resumeReplayPending` 연결 후 같은 테스트에서 `Restoring…`, `Restoring session…`, composer disabled, `session_loaded` 후 입력 재활성화를 고정했다.
- 확인: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts` 통과(31 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — direct fallback retry stale controller 정리

- 10 §4.6의 direct runtime 실패 후 "재시도" 경로에서, 실패한 controller dispose가 늦게 완료되면 같은 `sessionHandle`로 이미 재등록된 새 controller/store를 registry에서 지울 수 있는 경계를 보강했다.
- `unregisterSession(sessionHandle, expectedStore)`는 현재 registry entry가 caller의 store와 같을 때만 정리한다. 따라서 오래된 controller의 dispose가 새 direct runtime registry entry를 제거하지 않는다.
- `AgentTranscriptSurface`의 retry action은 실패한 controller의 shutdown/registry 정리를 await한 뒤 `fallback.chooseRetry()`를 호출한다. 이로써 같은 direct runtime 재기동이 old shutdown과 겹치지 않는다.
- RED: `agent-runtime-controller.test.ts`의 stale controller dispose 테스트가 기존 구현에서 `getSessionStore("S4R")`가 `undefined`가 되어 실패했고, `AgentTranscriptSurface.test.ts`의 retry 순서 테스트가 shutdown 완료 전 second start가 호출되어 실패했다.
- GREEN: store identity 조건부 unregister와 retry await 순서 적용 후 `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts src/lib/features/agent-runtime/controller/agent-runtime-controller.test.ts src/lib/features/agent-runtime/controller/agent-event-router.test.ts` 통과(37 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — fallback 실패 사유 표시 redaction

- 10 §4.6 fallback 패널의 실패 사유는 사용자에게 표시되는 진단 문자열이므로 09 §5.2 표시 경계 redaction을 적용해야 한다. 기존 `RuntimeFallbackController`는 `Error.message`/문자열을 그대로 `state.message`에 넣어 `Authorization`/`ANTHROPIC_AUTH_TOKEN`류 credential-like 값이 패널에 노출될 수 있었다.
- 표시 redaction 유틸을 `view/` 전용에서 `service/display-redaction.ts`로 올려 transcript/tool/approval view와 fallback controller가 같은 규칙을 공유하게 했다. 원본 provider event/raw 보존 정책은 유지하고, 화면/진단 상태로 나가는 문자열만 마스킹한다.
- RED: `runtime-fallback-controller.test.ts`의 `redacts credential-like values from fallback failure messages`가 기존 구현에서 `Bearer account-secret`/`anthropic-secret`이 그대로 남아 실패했다.
- GREEN: fallback error normalization에 `redactDisplayText`를 적용하고, 기존 view redaction import를 새 service 경로로 갱신했다.
- 확인: `npm run test -- src/lib/features/agent-runtime/view/display-redaction.test.ts src/lib/features/agent-runtime/controller/runtime-fallback-controller.test.ts src/lib/features/agent-runtime/view/MessageList.test.ts src/lib/features/agent-runtime/view/tool-cards/ToolCallCard.test.ts src/lib/features/agent-runtime/view/tool-cards/CommandOutputCard.test.ts src/lib/features/agent-runtime/view/ApprovalInlineCard.test.ts src/lib/features/agent-runtime/view/ApprovalModal.test.ts` 통과(42 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — legacy PTY fallback resumeToken 전달

- 10 §4.6의 fallback 선택지 중 "legacy PTY resume" 경로가 UI 계약에는 남아 있었지만, direct fallback context와 App의 `createSession` 호출은 `resumeToken`을 버려 항상 새 PTY 세션처럼 열 수 있었다.
- `RuntimeFallbackContext`/`SessionFallbackToPtyRequest`에 optional `resumeToken`을 추가하고, `AgentTranscriptSurface`가 `SessionHostProps.resumeToken`을 fallback context로 넘기도록 연결했다. App fallback handler는 실패한 direct 세션을 닫은 뒤 `createSession(..., undefined, resumeToken ?? null)`로 legacy PTY resume 토큰을 보존한다.
- RED: `AgentTranscriptSurface.test.ts`의 PTY fallback context 검증이 `resumeToken` 누락으로 실패했고, `App.test.ts`의 fallback-to-PTY 스텁 검증은 `createSession`에 legacy token이 전달되지 않아 실패했다.
- GREEN: context/request/call 경로를 연결한 뒤 `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts src/App.test.ts` 통과(34 tests).
- 확인: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts src/App.test.ts src/lib/features/agent-runtime/controller/runtime-fallback-controller.test.ts src/lib/features/session/service/session-shell-adapter.test.ts src/lib/features/session/view/SessionShell.test.ts src/lib/features/session/view/SessionViewport.test.ts` 통과(48 tests), `npx --no-install svelte-check --tsconfig ./tsconfig.json` 0 errors / 0 warnings, `git diff --check` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — legacy PTY fallback shutdown ordering

- 10 §4.6의 legacy PTY fallback 선택은 실패한 direct 세션을 닫은 뒤 같은 agent를 PTY 경로로 새로 여는 전환이다. retry 경로는 실패 controller `dispose()`를 await했지만, legacy PTY 선택 경로는 바로 `onFallbackToPty`를 호출해 부분 기동된 direct runtime/listener가 남을 수 있었다.
- `AgentTranscriptSurface`의 `onFallbackPty`도 retry와 동일하게 현재 실패 controller의 `dispose()`를 await하고, 여전히 같은 controller면 참조를 비운 뒤 `fallback.chooseLegacyPty()`를 호출하도록 맞췄다. 이로써 PTY 세션 생성 콜백은 direct shutdown/registry cleanup 이후에만 실행된다.
- RED: `AgentTranscriptSurface.test.ts`의 legacy PTY fallback shutdown ordering 테스트가 기존 구현에서 `shutdown("S1")`을 호출하지 않아 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "waits for the failed direct runtime shutdown before opening legacy PTY fallback"` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — slash command name 정규화

- 15 `AgentCommand.name` 정본은 선두 `/` 없는 이름이지만, ACP provider나 테스트 fixture가 `/review`처럼 slash 포함 이름을 주면 composer가 `//review`로 표시하거나 선택 draft를 잘못 만들 수 있는 방어 경계가 비어 있었다.
- Claude ACP `available_commands_update` 매핑과 `AgentComposer` provider command 합성 경계에서 command name을 trim하고 선두 slash를 제거한다. 로컬 `/resume` 보강과 provider command de-dup key도 정규화된 이름을 기준으로 잡는다.
- 05/06 문서에 남아 있던 로컬 `/resume` → `port.resumeSession` 직접 호출 문구도 현재 구현대로 정리했다. composer `/resume`은 v1에서 `/resume ` draft를 채우는 평문 prompt command이고, `resumeSession`은 host mount lifecycle 경로다.
- RED: `claude-acp-adapter.test.ts`의 `/review` provider command가 `review`로 정규화되지 않아 실패했고, `AgentComposer.test.ts`의 slash 포함 provider command가 `/review` 팔레트/선택 draft로 정규화되지 않아 실패했다.
- GREEN: 정규화 helper 적용 후 `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts src/lib/features/agent-runtime/view/AgentComposer.test.ts` 통과(38 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — ACP session_info_update title 배선

- 06 §5.1은 `session_info_update.title`을 세션 title 갱신으로 정의했지만, 구현은 해당 notification을 no-op으로 버려 provider title이 탭/session title에 반영되지 않았다.
- `session_info_update`를 `session_title_changed{title}` AgentEvent로 정규화하고, controller → `AgentTranscriptSurface` → `SessionShell`/`SessionViewport` → `App` callback 경로로 live session title과 workspace snapshot에 반영한다. `updatedAt`은 `ProviderRef.raw.updatedAt`에 보존하고, `title:null`/공백은 기존 workDir 기반 fallback title로 정규화한다.
- RED: `claude-acp-adapter.test.ts`에서 `session_info_update`가 `session_title_changed`를 emit하지 않았고, `agent-runtime-controller.test.ts`에서 host callback이 호출되지 않았으며, `App.test.ts`에서 live session title이 `"Provider title"`로 갱신되지 않았다.
- GREEN: provider title과 `title:null` fallback을 App 경계에 고정하고, `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts src/lib/features/agent-runtime/controller/agent-runtime-controller.test.ts src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts src/lib/features/session/service/session-shell-adapter.test.ts src/lib/features/session/view/SessionViewport.test.ts src/lib/features/session/view/SessionShell.test.ts src/App.test.ts` 통과(80 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — ToolCall locations expanded 표시

- 08 §4는 read/search 계열 tool card expanded detail에 `ToolCallUpdate.locations[]`가 표시된다고 정의했지만, 기존 `ToolCallCard`는 locations 존재만 expand affordance에 반영하고 실제 body에는 아무것도 렌더하지 않았다.
- `ToolCallCard` expanded body에 `path[:line[:column]]` 목록을 표시하고, provider 문자열은 표시 redaction 경계를 통과하게 했다. editor jump 클릭 연동은 08 §4.3의 기존 결정 필요 항목으로 유지한다.
- RED: `ToolCallCard.test.ts`의 locations 표시 테스트가 기존 구현에서 `"src/lib/example.ts:12:4"`를 찾지 못해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/tool-cards/ToolCallCard.test.ts` 통과(8 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — ACP stopReason closed enum 위반 처리

- ref-acp §3.6은 `PromptResponse.stopReason`을 5개 const string의 closed enum으로 정의하지만, 기존 Claude ACP mapper는 알 수 없는 stopReason을 `default` branch에서 정상 완료로 처리했다.
- `mapClaudeStopReason`이 closed enum을 먼저 확인하고 unknown/missing 값은 `turn_completed{status:"failed"}`와 `error{recoverable:false}`로 방출하도록 고정했다. 알 수 없는 string stopReason은 `ProviderRef.raw.stopReason`에 보존해 error notice/진단에서 원인을 추적할 수 있게 했다.
- RED: `claude-acp-adapter.test.ts`의 unknown stopReason 테스트가 기존 구현에서 `status:"completed"`를 받아 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts` 통과(28 tests). `agent-event-reducer.test.ts`에는 `max_tokens`/`max_turn_requests` warning notice 계약 테스트를 추가했고 같은 파일 단독 실행이 통과했다(33 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — MessageBubble raw JSON content 표시

- 13 OQ-04/15 §4는 ACP audio 같은 미지원 content를 drop하지 않고 `AgentContent{type:"json"}` raw 블록으로 보존해 transcript/tool content에 표시한다고 확정했다. 기존 `MessageBubble`은 text content만 이어붙여 표시해, audio→json 보존 이벤트가 store에는 남아도 화면에서는 빈 메시지처럼 보였다.
- `MessageBubble` 표시 경계에서 text/resource/json을 각각 redacted text, resource text/URI, redacted pretty JSON으로 렌더한다. image/diff/terminal처럼 메시지 bubble 본문에서 직접 다루지 않는 content는 기존 i18n fallback placeholder로 명시 표시한다.
- RED: `MessageList.test.ts`의 raw json message content 테스트가 기존 구현에서 `"Agent "`만 렌더해 `"type": "audio"`를 찾지 못해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/MessageList.test.ts` 통과(7 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — ApprovalModal always option hint

- 08 §4.4는 `allow_always`/`reject_always` option이 "기억되는 승인"임을 시각적으로 알리도록 요구한다. `ApprovalInlineCard`는 해당 hint를 표시했지만, escalation path인 `ApprovalModal`은 같은 kind를 받더라도 label만 표시했다.
- `ApprovalModal`에도 `optionAllowAlwaysHint`/`optionRejectAlwaysHint` 표시를 추가해 inline/modal 양쪽이 같은 option kind 의미를 드러내도록 맞췄다. option id/kind와 provider 제공 순서·개수는 그대로 유지한다.
- RED: `ApprovalModal.test.ts`의 always option hint 테스트가 기존 구현에서 `Remembered for this session` 0건으로 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/ApprovalModal.test.ts` 통과(8 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — composer runtime mode indicator

- 08 §6.5는 provider/model/permission-mode indicator를 composer 근처에 표시한다고 정의하지만, 기존 `AgentComposer` footer는 provider label만 보여 `permissionMode`/`sessionMode` 변화가 metadata strip에만 갇혀 있었다.
- `AgentTranscriptSurface`가 현재 `AgentRuntimeMetadata`에서 `permissionMode → sessionMode → sandbox` 순으로 표시용 mode label을 고르고, `AgentComposer` footer가 provider 옆에 해당 값을 표시하도록 배선했다. high-risk warning badge는 기존 metadata strip 경계에 유지한다.
- RED: `AgentTranscriptSurface.test.ts`의 current runtime mode 테스트가 기존 구현에서 composer text가 `"claude Send"`뿐이라 `default`를 찾지 못해 실패했다.
- GREEN: `npm run test -- AgentTranscriptSurface -t "current runtime mode"` 통과(1 test). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — composer capability 전달 배선

- 08 §6.4는 composer 입력 기능을 provider capability로 gate한다고 정의하지만, 기존 구현은 ACP `promptCapabilities.image`/`embeddedContext`를 initialize에서 파싱만 하고 `SessionStartResult`/store까지 전달하지 않았다.
- `SessionStartResult.composerCapabilities`를 추가하고, Claude ACP adapter가 initialize 결과를 `{ image, embeddedContext, audio:false }`로 승격한다. `AgentRuntimeController.start()`는 start/resume 결과의 capability를 store `capabilities`에 반영한다. 이 시점에는 composer의 image/resource UI와 검색 소스를 OQ-56 후속으로 유지했다. 이후 workspace file mention/resource button, image file 선택/paste/drop/reference token UI, Codex `fuzzyFileSearch`/`skills/list` source는 별도 보강으로 구현됐고, ACP resource source, provider-backed richer image source, `$` trigger만 후속으로 남았다.
- RED: `claude-acp-adapter.test.ts`의 prompt capability 반환 테스트는 `composerCapabilities === undefined`로 실패했고, `agent-runtime-controller.test.ts`의 store capability 반영 테스트는 기본 false 값으로 실패했다.
- GREEN: `npm run test -- claude-acp-adapter -t "prompt composer capabilities"`와 `npm run test -- agent-runtime-controller -t "composer capabilities"` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — direct runtime ptyId 없는 tab close 정책

- 08 §9.2/11 FE-20은 direct runtime 세션이 `ptyId`를 갖지 않아도 죽은 세션으로 오인되지 않아야 한다고 정의한다. 기존 tab close 정책은 실행 중 세션 판단을 `ptyId >= 0`에만 의존해 direct runtime 탭을 확인 없이 즉시 닫는 흐름으로 분류했다.
- `session-tab-behavior`에 `hasLiveSessionRuntime` 판단을 추가해 PTY host는 `ptyId >= 0`, direct host는 `runtimeKind.startsWith("direct-")`로 close-confirm 대상이 되게 했다. dirty warning 이후 진행 경로도 같은 판단을 사용해 direct 세션을 즉시 닫지 않는다.
- RED: `session-tab-behavior.test.ts`의 direct runtime close policy와 `tab-close-orchestration-controller.test.ts`의 direct runtime close-confirm 흐름이 기존 구현에서 `close-now`를 받아 실패했다.
- GREEN: `npm run test -- src/lib/features/session/service/session-tab-behavior.test.ts src/lib/features/session/controller/tab-close-orchestration-controller.test.ts` 통과(17 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — direct runtime snapshot stale PTY 제거

- 10 §3.2/11 FE-23..24는 direct runtime metadata가 저장→복원→기존 세션 갱신 3경로에서 전파되어야 하며, direct runtime은 PTY lifecycle 상태를 소유하지 않는다. 기존 `applyWorkspaceWindowSnapshot`는 `preservePtyIds=true`일 때 direct snapshot(`ptyId:null`)으로 기존 PTY session 객체를 갱신해도 기존 `ptyId`/`auxPtyId`를 보존했다.
- `live-session-workspace-sync`가 direct runtime snapshot을 복원하거나 기존 session에 적용할 때 `ptyId`/`auxPtyId=-1`, `auxVisible=false`, `auxHeightPercent=null`로 정규화하도록 했다. 이렇게 갱신된 direct session은 app-close resume capture 같은 PTY 전제 경로를 타지 않는다.
- RED: `session-store-snapshot.test.ts`의 existing PTY → direct snapshot 갱신 테스트가 기존 구현에서 `ptyId:42`, `auxPtyId:9`를 유지해 실패했다.
- GREEN: `npm run test -- src/lib/features/workspace/session-store-snapshot.test.ts` 통과(6 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — direct history stale resumeToken 표시 방어

- 10 §5.5/RD-9는 direct provider session/thread id와 resume token을 history에 저장하지 않는다고 정의한다. 저장 경계는 이미 `resumeToken:null`을 강제하지만, 오래된/외부 history entry가 `runtimeKind:"direct-*"`와 `resumeToken`을 함께 들고 오면 `SessionLauncher`가 token 요약 row를 표시했다.
- `SessionLauncher`에 direct history 판정 helper를 두고 direct entry는 `resumeToken`이 있어도 `.recent-token`을 렌더하지 않게 했다. `recordTabHistoryEntry`에는 Tauri payload가 항상 `resumeToken:null`이고 direct `runtimeKind`만 보존한다는 단위 테스트를 추가했다.
- RED: `SessionLauncher.test.ts`의 stale direct history token 표시 방어 테스트가 기존 구현에서 `.recent-token`을 발견해 실패했다.
- GREEN: `npm run test -- src/lib/features/launcher/view/SessionLauncher.test.ts` 통과(5 tests). `npm run test -- src/lib/tab-history.test.ts`도 history payload scrub 경계를 통과했다(2 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — scrubbed direct cold restore notice

- 10 §4.4/§4.5는 앱 재시작 후 provider id/resume key가 scrub된 direct metadata를 만나면 이전 대화 복원은 불가하되 탭 컨텍스트를 유지하고 "이전 대화를 복원할 수 없음" notice를 표시한다고 정의한다. 기존 `AgentTranscriptSurface`는 `resumeSession`을 건너뛰고 새 `startSession`으로 가는 동작은 했지만 notice를 표시하지 않았다.
- `AgentTranscriptSurface`가 현재 provider용 metadata가 있으나 provider id가 없거나 resume/load capability가 불가한 경우 `restoreUnavailable` 상태를 켜고 transcript 상단에 i18n notice를 렌더한다. metadata가 아예 없는 새 direct 세션에는 표시하지 않는다.
- RED: `AgentTranscriptSurface.test.ts`의 scrubbed metadata cold restore 테스트가 기존 구현에서 `"Previous conversation could not be restored."`를 찾지 못해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts` 통과(23 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — direct tab close unmount shutdown evidence

- 10 §4.3/OQ-17은 비활성 탭 전환에서는 direct transcript surface를 unmount하지 않아야 하지만, 실제 탭 close/component unmount에서는 direct runtime을 정리해야 한다. 기존 구현은 이미 `onDestroy`/`pagehide`/`beforeunload`가 같은 idempotent `disposeSurfaceRuntime()` 경계를 사용하고 있었다.
- `AgentTranscriptSurface.test.ts`에 순수 component unmount가 `shutdown("S1")`을 정확히 한 번 호출하는 회귀 테스트를 추가해, `visible=false` 무shutdown 경계와 실제 unmount shutdown 경계를 분리해 고정했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts` 통과(24 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — SessionShell option B 문서 drift 정리

- 08 §9.1과 02 §9가 아직 `SessionShell` direct host 분기를 target/권장 형태로 설명하고 있었지만, 현재 구현은 이미 `runtimeKind.startsWith("direct-")`로 `AgentTranscriptSurface`와 legacy `Terminal`을 분기한다.
- 08 §9.2의 `ptyId` 부재 autosave/close 검증 필요 문구도 현재 구현 증거에 맞춰 좁혔다. direct `ptyId=-1` 세션은 `hasLiveSessionRuntime` close policy와 snapshot/history scrub 테스트로 죽은 세션·legacy resume token 경로를 피한다.
- 문서만 현재화했다. 관련 코드 증거는 `SessionShell.test.ts`, `SessionViewport.test.ts`, `session-tab-behavior.test.ts`, `tab-close-orchestration-controller.test.ts`, `session-store-snapshot.test.ts`, `tab-history.test.ts`다.

## 2026-06-28 보강 — agent-runtime view/module map 문서 drift 정리

- 08 §2/§3/§4와 12 §0.1/T5.3에 남아 있던 초기 컴포넌트 스케치를 현재 파일 구조에 맞췄다. 별도 `AgentRuntimeShell.svelte`, `ResourceContentCard.svelte`, `ErrorNotice.svelte`는 v1 구현 파일이 아니다.
- 현재 direct host는 `AgentTranscriptSurface.svelte`이고, read/search/fetch의 text/resource/json 산출물은 `ToolCallCard`의 general content block이 렌더한다. stop-reason/error/process-exit notice는 reducer가 `TranscriptItem{type:"notice"}`를 만들고 `MessageList` inline notice row가 렌더한다.
- `CommandOutputCard`/`FileDiffCard`/`ToolCallCard` 경로는 실제 `view/tool-cards/` 하위로 정리했고, `transport.ts`는 host 직접 import가 아니라 `runtime-port-factory.ts`/adapter deps 경유라는 현재 조립 경계를 반영했다.

## 2026-06-28 보강 — NM-30 legacy PTY transcript isolation evidence

- legacy PTY output은 `terminal_output_delta`로만 감싸고 transcript 모델에는 올리지 않는다는 04 §3.5/NM-30 경계를 실제 테스트 증거와 연결했다.
- `legacy-pty-adapter.test.ts`는 PTY chunk → `terminal_output_delta` wrapper와 reducer 미반영을 함께 검증하고, `agent-event-reducer.test.ts`도 `terminal_output_delta`가 동일 model 참조를 반환해 `visibleItemIds`를 비워 두는지 검증한다.
- 문서 evidence만 보강했다. 실제 Windows legacy PTY E2E는 기존 §8 체크박스처럼 별도 실행 범위다.

## 2026-06-28 보강 — cold restore resume 실패 시 fresh direct start

- 10 §4.4는 scrub/미지원뿐 아니라 provider replay/resume 호출 실패도 탭을 유지한 빈 새 direct 세션 + 복원 불가 notice로 처리한다고 정의한다. 기존 `AgentTranscriptSurface`는 `resumeSession` 예외를 direct spawn 실패와 동일하게 fallback modal로 보냈다.
- `AgentTranscriptSurface`가 resume config가 있는 시작에서 예외를 받으면 실패 controller를 `dispose()`로 정리한 뒤 새 `startSession`을 한 번 수행한다. 이 경로에서는 `restoreUnavailable` notice를 표시하고 fallback modal은 띄우지 않으며, fresh direct start 자체가 실패할 때만 기존 §4.6 fallback 선택지를 표시한다.
- RED: `AgentTranscriptSurface.test.ts`의 provider resume 실패 cold restore 테스트가 기존 구현에서 `startSession` 0회 및 fallback modal 노출로 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts` 통과(25 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — target architecture current module map drift 정리

- 03 §1.1/§2/§3과 04 §3.2.3, 08 §7.3/§9.3/§10.1에 남아 있던 초기 파일명 스케치를 현재 구현명에 맞췄다.
- 현재 direct host는 별도 `AgentRuntimeShell.svelte`가 아니라 `AgentTranscriptSurface.svelte`이고, host props/type는 `contracts/metadata.ts`의 `AgentRuntimeHostProps`다. transcript state는 `agent-runtime-store.svelte.ts`, reducer는 `controller/agent-event-reducer.ts`, pending approval 권위 테이블은 `pending-approval-table.ts`가 담당한다.
- 비-execute tool content 증분은 별도 `ResourceContentCard`가 아니라 `ToolCallCard`의 general content block에 누적된다는 08 §3 현재 UI 경계도 04에 반영했다. 문서 drift 정리이며 런타임 코드 변경은 없다.

## 2026-06-28 보강 — default scrollback replay provider port 연결

- FE-27/T5.6은 `canLoad=true`인 tombstone scrollback에서 read-only scratch replay를 열어야 한다. 기존 `runtime-replay` default loader는 빈 결과만 반환했고, 실제 provider replay는 테스트 주입 loader로만 검증됐다.
- `createPortReplayLoader`를 추가해 기본 UI 경로가 별도 scratch session handle(`S1:replay`)로 provider port `resumeSession({replay:true})`를 호출하고, emitted `AgentEvent[]`를 scratch transcript로만 reduce하게 했다. live store/controller에는 병합하지 않는다. 초기에는 `ReplayPanel` close/unmount 때 scratch `shutdown`/unsubscribe를 수행했고, 후속 보강에서 조회 성공/실패 직후 폐기로 이동했다.
- RED: `runtime-replay.test.ts`의 provider port-backed scratch replay 테스트가 `createPortReplayLoader is not a function`으로 실패했고, `AgentTranscriptSurface.test.ts`의 기본 replay loader 테스트가 provider replay 메시지를 렌더하지 못해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/service/runtime-replay.test.ts src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts` 통과(30 tests). 실제 Windows 앱 E2E는 별도 실행 범위다. OQ-54의 남은 범위는 Codex `thread/read(includeTurns)`가 gap-only인지 전체 snapshot인지와 그 비용/필터링 정책이다.

## 2026-06-28 보강 — replay load failure unavailable fallback

- `canLoad=true`여도 provider replay(`session/load`·`thread/read`)가 실패할 수 있다. 기존 `ReplayPanel`은 `loadReplayTranscript(loader)` rejection을 잡지 않아 loading 상태에 머물고 unhandled rejection을 남겼다.
- `ReplayPanel`이 replay 조회 실패를 "사용 불가" 상태로 낮추도록 했다. read-only/live 미병합 경계는 유지하고, 사용자는 닫기 버튼으로 패널을 닫을 수 있다.
- RED: `ReplayPanel.test.ts`의 provider replay loading failure 테스트가 `Loading earlier history…`에 머물고 unhandled rejection을 발생시켜 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/ReplayPanel.test.ts` 통과(5 tests), `npm run test -- src/lib/features/agent-runtime/service/runtime-replay.test.ts src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts src/lib/features/agent-runtime/view/ReplayPanel.test.ts` 통과(35 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — replay scratch dispose after load

- FE-27은 scratch replay 세션을 live store에 병합하지 않고 조회 후 폐기하는 계약이다. 이전 구현은 성공/실패 상태가 확정된 뒤에도 패널 close/unmount 전까지 scratch loader를 유지했다.
- `ReplayPanel`이 replay 조회 성공 또는 실패 후 즉시 `loader.dispose()`를 한 번 호출하도록 바꿨다. close/unmount 경로는 남은 scratch를 위한 idempotent cleanup으로 유지한다.
- RED: `ReplayPanel.test.ts`에 조회 성공 뒤 dispose, replay 실패 뒤 dispose 기대를 추가했을 때 두 기대가 모두 0회 호출로 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/ReplayPanel.test.ts` 통과(6 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — ACP promptCapabilities content gate

- 08 §6.4와 `toAcpPromptContent` 주석은 ACP `promptCapabilities.image`/`embeddedContext`를 호출부에서 확인한다고 정의하지만, 기존 `claude-acp-adapter.sendPrompt`는 `rt.caps`를 보지 않고 `image`/`resource` content를 그대로 `session/prompt`에 보냈다.
- `sendPrompt`가 `promptCapabilities.image !== true`이면 `image`를, `promptCapabilities.embeddedContext !== true`이면 text 포함 `resource`를 전송 content에서 제외하도록 했다. optimistic `user_message` echo도 실제 전송 가능한 `AgentContent[]`와 맞춘다. capability가 true인 세션에서는 기존 OQ-57처럼 image/resource 원본 content를 보존한다.
- RED: `claude-acp-adapter.test.ts`의 ACP promptCapabilities gate 테스트가 기존 구현에서 `session/prompt`에 text/image/resource 3개를 모두 보내 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts` 통과(30 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — ACP promptCapabilities empty prompt guard

- capability gate로 모든 content가 제거되면 기존 구현은 `session/prompt`에 빈 `prompt: []`를 보내고 optimistic `user_message`/running 상태까지 emit했다. provider가 이 빈 prompt를 어떻게 처리할지 불명확해 불필요한 turn을 만들 수 있다.
- `sendPrompt`가 전송 가능한 content가 하나도 없으면 `session/prompt`를 보내지 않고 recoverable `error` event만 emit한 뒤 반환하도록 했다. user echo와 running status도 만들지 않는다.
- RED: `claude-acp-adapter.test.ts`의 empty prompt guard 테스트가 기존 구현에서 `session/prompt` 송신을 관측해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts` 통과(31 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — ACP resource_link baseline gate

- ref-acp §3.6 baseline prompt content는 `text`와 `resource_link`다. 기존 `sendPrompt` gate는 `AgentContent{type:"resource"}`를 전부 `embeddedContext=false`에서 제거해 text 없는 link-only resource까지 드롭했다.
- `sendPrompt`가 text 포함 resource만 embedded context로 보고 `promptCapabilities.embeddedContext`를 요구하도록 좁혔다. text 없는 resource는 `toAcpPromptContent`에서 baseline `resource_link`로 변환되며 optimistic `user_message` echo에도 남는다.
- RED: `claude-acp-adapter.test.ts`의 link-only resource 보존 테스트가 기존 구현에서 `session/prompt` 자체가 없어 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/adapters/claude-acp/claude-acp-adapter.test.ts` 통과(32 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — start preflight boundary test

- OQ-24/RS-10f는 resolver cache와 별개로 startup마다 executable `--version` preflight를 실행한다고 정의한다. 기존 테스트는 `CachingResolver`의 preflight 호출/절대경로 거부만 직접 고정했고, `start` 직전 launch 경계에서 preflight 실패·빈 출력이 spawn으로 진행되지 않는지에 대한 mock 주입 테스트가 약했다.
- `preflight_launch_for_start(params, launch, preflight)` helper를 추가해 start 경계의 preflight 호출, 실패 audit, 빈 version 거부를 분리했다. 운영 `start`는 기존 전역 resolver preflight를 이 helper를 통해 호출한다.
- `TrustedPathResolver` 기본 fallback 메시지도 `not implemented` 대신 `preflight unavailable`로 바꿔, mock resolver가 preflight를 제공하지 않는 상태와 운영 `WslResolver` 구현 부재를 혼동하지 않게 했다.
- RED: `cargo test rs10h_start_preflight_rejects_failure_with_resolved_executable --lib`가 `preflight_launch_for_start` 함수 부재로 컴파일 실패했다.
- RED: `cargo test rs10j_default_resolver_preflight_reports_unavailable --lib`가 기존 `not implemented` 메시지 때문에 실패했다.
- GREEN: `cargo test rs10 --lib` 통과(8 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — failed-start metadata patch isolation

- `runtime_metadata_changed` notification은 start result보다 먼저 올 수 있어 `AgentTranscriptSurface`가 `pendingRuntimeMetadataPatch`에 보류했다가 성공 metadata와 병합한다. 그러나 start/resume 자체가 실패한 뒤 retry하면 실패 시도에서 보류된 mode/sandbox patch가 새 성공 세션 metadata에 섞일 수 있었다.
- 새 start/retry 시도 시작 전과 start/resume 실패 catch 경계에서 `pendingRuntimeMetadataPatch`를 비워, 성공한 동일 시도의 metadata patch만 `SessionStartResult`에 병합되도록 했다. 복원 실패 후 fresh direct start로 낮추는 경계도 같은 방식으로 stale patch를 폐기한다.
- RED: `AgentTranscriptSurface.test.ts`의 failed-start metadata isolation 테스트가 retry 성공 metadata에 `permissionMode:"bypassPermissions"`가 섞여 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "does not merge metadata patches from a failed start attempt into retry metadata"` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — failed-resume metadata patch isolation

- cold restore처럼 `props.agentRuntime`에서 기존 metadata가 먼저 채워진 상태에서는 start/resume 완료 전 `runtime_metadata_changed`가 pending buffer가 아니라 즉시 persisted metadata에 병합될 수 있었다. 이 경우 provider resume이 실패하고 fresh direct start로 낮춰도 실패 시도의 `permissionMode`/`sessionMode`/sandbox patch가 callback에 이미 노출된다.
- `AgentTranscriptSurface`가 start/resume attempt를 시작할 때 `runtimeStartPending`을 켜고, 완료 전 metadata patch는 기존 metadata 유무와 무관하게 attempt-local `pendingRuntimeMetadataPatch`에 보류한다. `SessionStartResult`가 성공한 경우에만 병합하고, resume 실패·fresh start 실패·fallback 실패 경계에서는 buffer와 pending flag를 함께 폐기한다.
- RED: `AgentTranscriptSurface.test.ts`의 failed-resume metadata isolation 테스트가 복원 실패 시도 중 `permissionMode:"bypassPermissions"`를 `onAgentRuntimeMetadataChange`에 persist해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "does not persist metadata patches from a failed resume attempt into fresh start metadata"` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — failed-start late metadata patch isolation

- start 실패가 catch되어 fallback 패널이 뜬 뒤에도 실패한 controller listener는 retry/전환 전까지 남아 있을 수 있다. 이때 provider가 늦은 `runtime_metadata_changed`를 emit하면 기존 persisted metadata가 있는 세션에서는 실패한 시도의 mode/sandbox patch가 즉시 persistence callback에 섞일 수 있었다.
- metadata callback을 start/resume attempt id에 묶고, 실패로 닫힌 attempt는 `runtimeMetadataPatchBlocked`로 표시한다. 현재 attempt가 아니거나 실패로 닫힌 attempt에서 온 늦은 metadata patch는 무시하며, 성공한 attempt의 후속 metadata event만 기존처럼 runtime metadata에 병합한다.
- RED: `AgentTranscriptSurface.test.ts`의 late failed-start metadata isolation 테스트가 fallback 표시 후 `permissionMode:"bypassPermissions"`를 `onAgentRuntimeMetadataChange`에 persist해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "ignores late metadata patches from a failed start while fallback is visible"` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — failed-start late title isolation

- `session_title_changed`도 metadata와 같은 host persistence callback 경로를 타므로, start 실패 후 fallback 표시 중 실패 controller에서 늦게 도착하면 탭/session title과 workspace snapshot title을 stale provider title로 바꿀 수 있었다.
- `AgentTranscriptSurface`가 title callback도 start/resume attempt id에 묶어 현재 성공 attempt에서 온 title만 전달하도록 했다. 실패로 닫힌 attempt 또는 과거 attempt에서 온 `session_title_changed`는 무시한다.
- RED: `AgentTranscriptSurface.test.ts`의 late failed-start title isolation 테스트가 fallback 표시 후 `"Stale failed session"`을 `onSessionTitleChange`에 전달해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "ignores late title updates from a failed start while fallback is visible"` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — failed-start late status/store dispatch isolation

- `session_status_changed`는 controller가 store에 dispatch한 뒤 `AgentTranscriptSurface`의 status effect를 통해 tab badge callback으로 publish된다. start 실패 후 fallback 표시 중 실패 controller에서 늦은 status event가 오면 stale `"running"`/`"ready"` status가 composer/surface/tab 상태에 섞일 수 있었다.
- controller에 넘기는 store를 attempt-scoped proxy로 감싸, 현재 성공 attempt가 아니거나 실패로 닫힌 attempt에서 온 event는 `dispatch` 자체를 무시하도록 했다. metadata/title callback gate와 같은 attempt id를 쓰므로 실패 attempt의 늦은 transcript/status event가 live store를 오염하지 않는다.
- RED: `AgentTranscriptSurface.test.ts`의 late failed-start status isolation 테스트가 fallback 표시 후 `"running"`을 `onAgentRuntimeStatusChange`에 전달해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "ignores late status updates from a failed start while fallback is visible"` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — failed-start pre-result title/status isolation

- `session_title_changed`와 `session_status_changed`는 start/resume result보다 먼저 도착할 수 있다. 기존 attempt gate는 실패 후 늦은 event는 막았지만, result가 아직 pending인 동안 도착한 title/status는 현재 attempt로 간주해 즉시 live callback/store에 반영했다. 그 직후 start가 실패하면 stale provider title이나 `"running"` status가 fallback 표시 세션에 남을 수 있었다.
- title은 metadata patch와 같은 attempt-local buffer로 보류하고, 성공한 `SessionStartResult`가 publish된 뒤 최신 title만 host callback으로 flush한다. status는 `session_status_changed` event만 live store dispatch 전에 보류하고, 성공한 attempt에서 최신 status event를 store에 dispatch한다. 실패/무효화된 attempt는 두 buffer를 모두 폐기하며, 성공 후 도착하는 title/status는 기존 live 경로를 유지한다.
- pending title flush도 기존 live title callback과 동일하게 저장 실패를 runtime lifecycle 실패로 승격하지 않는다. title 저장 callback이 reject해도 direct runtime start는 fallback으로 낮아지지 않는다.
- RED: `AgentTranscriptSurface.test.ts`의 pre-result title/status 실패 테스트가 각각 `"Pre-start failed session"` title callback과 `"running"` status callback을 관측해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "pre-result title"` 및 `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "pre-result status"` 통과. `title persistence` 보강 테스트도 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — failed-resume replay transcript isolation coverage

- 10 §4.4/FE-24c는 provider `resumeSession`/load 실패 시 탭을 유지하되 빈 새 direct 세션으로 낮춘다고 정의한다. 기존 테스트는 fresh `startSession` 호출과 복원 불가 notice만 검증해, 실패한 resume attempt에서 온 replay transcript event가 fresh start live store에 섞이지 않는지 명시하지 않았다.
- `AgentTranscriptSurface.test.ts`에 실패한 resume attempt가 `agent_message` replay event를 emit한 뒤 reject해도 `"Stale replay response"`가 fresh start transcript에 렌더되지 않는 회귀 테스트를 추가했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "failed resume attempt into the fresh start"` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — failed-start pre-result lifecycle status isolation

- `session_started`/`session_loaded`도 `session_status_changed`처럼 store status를 바꾸는 lifecycle event다. 이전 보강은 `session_status_changed`만 start/result 전 보류했으므로, adapter가 `session_started`를 먼저 emit한 뒤 start가 실패하면 `"ready"` tab status가 fallback 세션에 새는 경계가 남아 있었다.
- attempt-scoped store proxy가 start/resume result 전 `session_started`/`session_loaded`/`session_status_changed`를 모두 status-affecting event로 보류하고, 성공한 attempt에서만 최신 event를 live store에 dispatch하도록 넓혔다. 실패/무효화된 attempt는 보류 event를 폐기한다.
- RED: `AgentTranscriptSurface.test.ts`의 pre-result `session_started` 실패 테스트가 `"ready"` status callback을 관측해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "pre-result session_started"` 통과(실패/성공 2 tests). 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — failed-start pre-result store event isolation

- `session_started`/status만 보류해도, start result 전에 들어온 일반 transcript/tool/approval event는 즉시 live store에 들어갈 수 있었다. fresh start가 그 직후 실패해 fallback 패널로 내려가면 실패 attempt의 agent message가 transcript에 남는 문제가 있었다.
- attempt-scoped store proxy가 fresh start 및 replay 없는 resume의 `runtimeStartPending` 동안 모든 `AgentEvent` dispatch를 attempt-local queue에 순서대로 보류하고, 성공한 `SessionStartResult`가 publish될 때만 live store에 flush하도록 바꿨다. 실패/무효화 attempt는 queue를 폐기한다. metadata/title persistence callback은 기존 별도 buffer/gate를 유지한다. `resume.replay===true` 예외는 아래 "resume replay pre-result live transcript" 항목에서 별도 정리한다.
- RED: `AgentTranscriptSurface.test.ts`의 pre-result transcript 실패 테스트가 fallback 표시 후 `"Stale failed start response"`를 렌더해 실패했다.
- GREEN: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "pre-result transcript"` 및 `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "pre-result"` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 보강 — resume replay pre-result live transcript

- 10 §4.2는 ACP `session/load`가 응답 전 `session/update` 스트림으로 transcript를 재구성할 수 있다고 정의하고, `AgentRuntimeController`도 start/resume 전에 subscribe해 replay event가 store로 흐르도록 설계되어 있다. 이전 pre-result store event 격리는 fresh start 실패 오염은 막았지만, `resume.replay===true` 경로까지 모든 event를 큐에 묶어 `Restoring…` 중 replay transcript가 보이지 않는 충돌을 만들었다.
- `AgentTranscriptSurface`의 attempt-scoped store dispatch에 `queue`/`live` 모드를 추가했다. fresh start와 replay 없는 resume은 기존처럼 pre-result event를 큐잉/실패 시 폐기하고, `resume.replay===true`는 replay transcript event를 live dispatch한다. metadata/title/status publish는 start result 전까지 계속 gate하고, `resumeReplayPending`이 true인 동안 surface는 store status 변화와 무관하게 `Restoring…` 배너와 composer 잠금을 유지한다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "restoring state"`가 `"Restored replay message before result"`를 찾지 못해 실패했다.
- GREEN: 같은 targeted test 통과, `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "pre-result"` 통과(9 tests), `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts` 통과(42 tests). 추가 확인으로 `npm run test -- src/lib/features/agent-runtime/view` 통과(101 tests), `npm run test -- src/lib/features/agent-runtime` 통과(370 tests), `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime` 통과(63 tests), `npx --no-install svelte-check --tsconfig ./tsconfig.json` 0 errors/0 warnings, 변경 파일 `git diff --check` 통과. 실제 Windows 앱 E2E는 별도 실행 범위다.

## 2026-06-28 문서 동기화 — OQ-08 exact 0.51.0 pin 해소

- OQ-08은 0.50.0 조사값과 0.51.0 구현 기준의 capability diff를 CHANGELOG로 확인하라는 잔여 gate로 남아 있었다. 하지만 현재 구현 기준은 이미 0.50.0을 버리고 exact `@agentclientprotocol/claude-agent-acp@0.51.0` + transitive `@agentclientprotocol/sdk@0.29.0` package schema/dist로 확정돼 있어, 0.50.0 CHANGELOG 비교를 v1 gate로 유지하면 OQ-41/RD-7과 충돌한다.
- `package.json`/`package-lock.json`의 exact 0.51.0 pin, `node_modules/@agentclientprotocol/claude-agent-acp/package.json`의 sdk 0.29.0·node `>=22`·bin `dist/index.js`, `dist/acp-agent.js`의 initialize capability(`loadSession`, `sessionCapabilities.resume`, `promptCapabilities.image/embeddedContext`), SDK schema의 13종 `SessionUpdate`를 확인했다.
- 13 OQ-08, 위험 1.10, 06 §12, ref-claude §6을 같은 결론으로 맞췄다. 향후 package refresh 때는 OQ-41 절차로 schema diff + fixture replay를 반복한다.

## 2026-06-28 문서 동기화 — SDK 0.29.0 types.gen 원문 확인

- `@agentclientprotocol/sdk@0.29.0` 패키지의 schema artifact 경계를 다시 확인했다. JSON Schema는 패키지 루트 `schema/schema.json`에 있고, 생성 TS 타입은 `dist/schema/types.gen.d.ts`에 있으며, `dist/acp.d.ts`가 `./schema/types.gen.js`를 export한다.
- `types.gen.d.ts`에서 `RequestPermissionRequest`, `SessionUpdate` 13종(`plan_update`/`plan_removed` 포함), `ClientCapabilities`, `LoadSessionRequest`, `CurrentModeUpdate`, `ConfigOptionUpdate`, `ToolKind`, `ToolCallStatus`를 직접 대조했다. `contracts/claude-acp.ts`의 부분 wire mirror는 이 생성 타입 기준과 일치한다.
- `ref-claude-agent-acp.md`의 오래된 SDK schema 경로와 "TS 타입 원문 미열람" 항목을 정리했고, `ref-acp-protocol.md`의 `schema-v1.16.0` 구현 전 gate 문구를 현재 OQ-41 해소 상태로 낮췄다. 남은 미확정은 protocolVersion >1 협상 분기, 배포 대상 node/claude/native binary, 출시 전 auth/branding 재확인이다.

## 2026-06-28 문서 동기화 — stale OQ 라벨과 realtime raw 경계 정리

- `14-sequence-and-state.md`, `ref-codex-app-server-protocol.md`, `HANDOFF.md`, `research/ux-reference.md`에 남아 있던 Codex `initialize`/`initialized` strict 필수 여부(OQ-07)와 `ClientInfo`/`InitializeCapabilities` 필드(OQ-11)의 옛 미확정 라벨을 H4 결론과 현재 adapter/test 증거에 맞게 정리했다. v1 adapter는 `initialize` 응답 뒤 params 없는 `initialized` notification을 항상 보내고, generated type 기준 최소 `clientInfo` + `capabilities:null`을 유지한다.
- `ref-acp-protocol.md`의 `audio`와 ACP 합성 status open wording을 현재 13 레지스트리 상태에 맞췄다. `audio`는 OQ-04처럼 raw JSON 보존으로 해소됐고, `running`/`requires_action`/`idle`은 OQ-13 합성 규칙으로 고정됐다.
- 09의 "env value가 어떤 로그/이벤트/디스크에도 평문으로 흐르지 않는가" 체크는 표시/저장/디버그 로그 경계 증거가 충분하지만, realtime `agent-runtime-message` raw event가 adapter routing을 위해 무손실이어야 하는 M-4 경계 때문에 닫지 않았다. 이 잔여 정책 결정을 13 OQ-59로 등록하고, 07 §7.2/§11도 OQ-59를 참조하도록 갱신했다.
- 확인: `git diff --check -- docs/plans/agent-direct-runtime`, `npm run test -- src/lib/features/agent-runtime`(33 files, 370 tests), `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime`(63 tests) 통과. 실제 Windows 앱 E2E와 앱 launch는 현재 scope에서 명시되지 않아 실행하지 않았다.

## 2026-06-28 구현 보강 — OQ-59 raw event 정본 tuple

- `agent-runtime-message` realtime event는 adapter routing/normalization에 필요한 raw bridge라서 v1에서 redaction을 적용하면 protocol id·raw payload 보존 계약(M-4)을 깨뜨린다. 대신 `transport.ts`에 ordered `AGENT_RUNTIME_EVENT_NAMES` tuple을 추가하고 Codex adapter와 Claude factory 구독 루프가 이 tuple을 사용하게 해 event 문자열 중복 정의와 drift를 줄였다.
- `AgentRuntimeEvent.message`/`AGENT_RUNTIME_EVENTS` 주석에 raw `message` 채널이 adapter 전용 bridge이고 화면·저장·diagnostic에는 redacted projection만 써야 한다는 경계를 명시했다. 당시에는 `AgentTransportHandlers.onMessage` 주석도 같은 경계로 맞췄고, 이후 OQ-59 확정에서 public controller의 `onMessage` 자체를 제거했다. 문서도 15 §8.3, 11 §1.3/E2E-10, 13 OQ-59에 같은 상태로 맞췄다.
- RED: `npm run test -- src/lib/features/agent-runtime/service/transport.test.ts -t "exports the ordered runtime event name list"`가 `AGENT_RUNTIME_EVENT_NAMES` 미export로 실패했다.
- GREEN: 같은 targeted test 통과. 더 넓은 검증은 이어서 `transport`/Codex adapter targeted suite와 frontend type/check 범위에서 확인한다.

## 2026-06-28 문서 동기화 — research stale open 문구 정리

- `research/codebase-backend.md` §11은 원 조사 snapshot이라 원 사실은 유지하되, 현재 구현으로 해소된 OQ-26(`decode_utf8_stream_chunk` `pub(crate)` 공유)과 OQ-18(`WorkspaceTabSnapshot.runtime_kind`/`agent_runtime` frontend+Rust merge 동기화)을 "해소됨"으로 낮췄다. websocket transport는 v1 `jsonrpc-stdio` 유지 + reject-before-log 결정으로 정리했다.
- `research/ux-reference.md`의 OQ-02(`usage_update` → `contextUsed`/`contextSize`)와 OQ-05(`Enter` 전송, `Shift+Enter` 개행, slash palette 선택 예외) 초기 미해결 문구를 현재 13 레지스트리와 구현 상태에 맞췄다.

## 2026-06-28 구현 보강 — OQ-56 workspace file @mention 1차

- OQ-56에서 미구현으로 남아 있던 composer `@` file/resource mention의 첫 slice를 구현했다. `AgentComposer`는 optional `resourceSearch(query)` 결과를 팔레트로 표시하고, 선택 시 `@relative/path ` token을 draft에 삽입하며, 전송 시 token이 draft에 남아 있는 selected resource를 `AgentContent{type:"resource", uri:"file://..."}`로 함께 보낸다.
- `AgentTranscriptSurface`는 기존 editor 파일 검색 경계인 `searchSessionFiles(sessionId, workDir, query, 8)`을 composer resource search source로 연결한다. 당시 범위는 workspace file link-only resource였고, 이후 Codex `fuzzyFileSearch`/`skills/list` provider source와 image file 선택/paste/drop/reference token UI는 별도 OQ-56 보강에서 구현했다. ACP resource source, provider-backed richer image source, `$` trigger는 후속으로 남긴다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts -t "selects an @ file mention"`가 resource palette 부재로 실패했다.
- GREEN: 같은 targeted test 통과. Surface 연결 테스트는 fake port가 `ready` status event를 내도록 보정한 뒤 `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "@ file mention"` 통과했다.
- 추가 확인: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts src/lib/i18n/key-parity.test.ts` 통과(3 files, 59 tests), `npx --no-install svelte-check --tsconfig ./tsconfig.json` 0 errors/0 warnings. 실제 Windows 앱 E2E와 앱 launch는 현재 scope에서 명시되지 않아 실행하지 않았다.

## 2026-06-28 구현 보강 — OQ-56 inline @mention token 보존

- workspace file `@` mention 1차 구현이 draft 전체가 `@query`일 때만 열려, `please inspect @app`처럼 본문 뒤에 파일 mention을 붙이는 실제 composer 사용 흐름을 놓쳤다.
- `AgentComposer`가 draft 끝의 `@query` token을 감지하고, 선택 시 해당 token만 `@relative/path `로 교체하도록 바꿨다. 앞 prompt text는 그대로 보존되며, 전송 payload는 text content + link-only resource content 경계를 유지한다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts -t "inline @ file mention"`가 resource palette 부재로 실패했다.
- GREEN: 같은 targeted test 통과. 실제 Windows 앱 E2E와 앱 launch는 현재 scope에서 명시되지 않아 실행하지 않았다.

## 2026-06-28 구현 보강 — OQ-56 file URI segment encoding

- workspace file mention이 WSL path를 `file://` 문자열 결합으로만 만들고 있어, 공백·`#`·`?`가 포함된 경로가 provider resource URI 경계에서 fragment/query처럼 해석될 수 있었다.
- `AgentTranscriptSurface`의 file URI 생성이 slash 구분자는 유지하되 path segment를 `encodeURIComponent`로 인코딩하도록 바꿨다. 예: `/w/My Dir/app#main?.svelte` → `file:///w/My%20Dir/app%23main%3F.svelte`.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentTranscriptSurface.test.ts -t "resource URI encodes"`가 raw URI(`file:///w/My Dir/app#main?.svelte`)를 관측해 실패했다.
- GREEN: 같은 targeted test 통과. 실제 Windows 앱 E2E와 앱 launch는 현재 scope에서 명시되지 않아 실행하지 않았다.

## 2026-06-28 구현 보강 — OQ-56 selected resource token boundary

- workspace file `@` mention 선택 후 사용자가 token 뒤에 문자를 붙여 `@src/App.sveltex`처럼 다른 단어로 바꿔도 기존 구현은 단순 `draft.includes("@src/App.svelte")` 때문에 stale `resource{uri:"file://..."}` content를 계속 전송했다.
- `AgentComposer`가 선택된 resource token을 공백 경계 안에 그대로 남은 경우에만 전송 대상에 포함하도록 바꿨다. token이 다른 단어의 prefix가 되거나 사용자가 삭제/변형하면 text content만 전송한다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/AgentComposer.test.ts -t "does not attach a resource"`가 변형된 token에도 resource content가 붙는 것을 관측해 실패했다.
- GREEN: 같은 targeted test 통과. 실제 Windows 앱 E2E와 앱 launch는 현재 scope에서 명시되지 않아 실행하지 않았다.

## 2026-06-28 구현 보강 — OQ-59 runtime event channel/type guard

- `runtime-port-factory.ts`의 production Codex/Claude deps가 Tauri event channel과 payload `type`을 대조하지 않아, 잘못된 채널에 실린 같은 `runtimeId`의 raw `message` payload가 adapter로 전달될 수 있었다. backend는 정상 channel로 emit해야 하지만, frontend adapter 경계도 15 §8.3 event table과 같은 discriminant를 한 번 더 확인해야 한다.
- `eventMatchesChannel` guard를 추가해 `agent-runtime-message`↔`type:"message"` 등 channel/type 조합이 맞는 payload만 Codex `listenRuntime`/Claude `subscribeRuntime` 핸들러로 넘기도록 했다. raw `message`를 redaction하지 않는 M-4 경계는 유지하고, 잘못된 channel에서의 라우팅만 차단한다.
- RED: `npm run test -- src/lib/features/agent-runtime/service/runtime-port-factory.test.ts`가 Claude/Codex 모두 wrong-channel `message` payload를 수신해 실패했다.
- GREEN: 같은 targeted test 통과. 실제 Windows 앱 E2E와 앱 launch는 현재 scope에서 명시되지 않아 실행하지 않았다.

## 2026-06-29 E2E 보강 — Windows runner mirror/tool 안정화와 full-suite 확인

- Windows full E2E가 전체 project를 한 Vitest 프로세스에서 병렬 실행하면서 고정 WebDriver port `4444` 충돌(`can not listen to address: 127.0.0.1:4444`)을 냈다. 또한 WSL mirror sync가 `.tools/`를 삭제해 최신 `msedgedriver.exe` 대신 stale root/PATH driver가 선택되고, Edge 149 환경에서 driver 146 mismatch가 발생했다.
- `scripts/sync-e2e-mirror.sh`가 mirror-local `.tools/`를 보존하도록 exclude를 추가했고, `scripts/e2e-smoke-windows.ps1`는 `.tools\windows\e2e\msedgedriver.exe` → project root → PATH 순서로 driver를 찾도록 바꿨다. full E2E는 `smoke`, `settings`, `windows-tabs`, `workspace-restore`, `image-paste`, `agent-runtime`, `terminal-input`, `terminal-links`, `terminal-aux` project를 순차 실행한다. `docs/testing/e2e.md`도 같은 실행/driver 순서로 갱신했다.
- `smoke`의 Codex legacy PTY 출력 검증은 test hook 등록/PTY 출력보다 먼저 단발 snapshot을 읽을 수 있어 `waitForTerminalOutputSnapshot` helper로 폴링하게 했다. seeded persisted `tab_history.json`의 `resumeToken` 검증은 현재 history scrub 정책과 충돌했으므로, E2E는 Codex/title/path metadata가 보이고 token prefix가 노출되지 않는 것을 확인하도록 갱신했다.
- RED: `npm run test:e2e:wsl -- --skip-build`가 port 충돌/driver mismatch로 실패했고, runner 수정 후에는 `smoke`에서 Codex 출력 snapshot `undefined`, 이어서 stale resume summary 기대값으로 실패했다.
- GREEN: `npm run test:e2e -- --project smoke --reporter=dot` 통과(WSL import-only, 1 file / 3 skipped), `npm run test -- scripts/e2e-runner-scripts.test.ts` 통과(3 tests), `npm run test:e2e:wsl -- --skip-build --project smoke` 통과(1 file / 3 tests), `npm run test:e2e:wsl -- --skip-build` 통과(9 projects / 25 tests). 전체 실행은 mirror-local Edge WebDriver를 사용하고 project들을 순차 실행했다.

## 2026-06-29 검증 보강 — E2E runner script test 위치 조정

- E2E runner script contract test를 `src/test/e2e-runner-scripts.test.ts`에 두면 app tsconfig 범위에 포함되어 `svelte-check`가 Node builtin import(`node:fs`, `node:path`)와 `process` type을 frontend source error로 취급한다. 이 test는 frontend source가 아니라 runner script contract 검증이므로 `scripts/e2e-runner-scripts.test.ts`로 옮겼다.
- `vite.config.ts`의 Vitest include에 `scripts/**/*.{test,spec}.{ts,js}`를 추가해 `npm run test` 범위에는 유지하되, `svelte-check --tsconfig ./tsconfig.json` 대상에서는 제외되도록 했다.
- RED: `npm run verify`가 Vitest(132 files / 989 tests)와 Rust test(162 tests)는 통과한 뒤 `svelte-check`에서 Node type 오류로 실패했다.
- GREEN: `npm run test -- scripts/e2e-runner-scripts.test.ts` 통과(3 tests), `npx --no-install svelte-check --tsconfig ./tsconfig.json` 0 errors/0 warnings, 최종 `npm run verify` 통과(Vitest 132 files / 989 tests, Rust 162 tests, svelte-check 0 errors/0 warnings, Vite build OK, cargo check OK). Vite large chunk warning은 기존 경고다.

## 2026-06-29 E2E 보강 — terminal-aux loading overlay race 안정화

- full Windows E2E 재실행 중 `terminal-aux`가 aux shell output snapshot 확인 직후 shell을 클릭하면서 compact loading overlay(`terminal-connect-card--compact`)에 클릭이 가로막혔다. aux loading lifecycle은 renderable output 이후 quiet window 동안 overlay를 유지할 수 있으므로, output snapshot 준비와 click 가능 상태를 동일하게 보는 테스트 가정이 틀렸다.
- `e2e/terminal-aux/terminal-aux.test.ts`가 aux output의 `Agent: Shell`/`Mock session ready.`를 확인한 뒤 `.terminal-connect-overlay--aux-panel`이 화면에서 사라질 때까지 기다리도록 바꿨다. product 코드 변경 없이 기존 loading lifecycle과 같은 사용자 click 가능 상태를 기준으로 E2E를 안정화했다.
- RED: sandboxed `npm run test:e2e:wsl -- --skip-build`는 `/mnt/c/temp/clcomx` mirror sync permission 작업에서 `rsync` code 23으로 중단됐고, 권한 상승 재실행은 `terminal-aux`에서 `ElementClickInterceptedError`로 실패했다. 최초 attr 기반 보강은 `--skip-build`의 stale Windows binary와 맞지 않아 targeted run에서 timeout으로 실패했다.
- GREEN: `npm run test:e2e:wsl -- --skip-build --project terminal-aux` 통과(1 file / 1 test), 최종 `npm run test:e2e:wsl -- --skip-build` 통과(9 projects / 25 tests). 전체 실행은 mirror-local Edge WebDriver를 사용하고 project들을 순차 실행했다.

## 2026-06-29 E2E 보강 — OQ-61 fake external editor real-launch 검증

- OQ-61의 external editor 경로는 기존에 `CLCOMX_TEST_MODE`에서 `open_in_editor` payload JSONL만 확인했다. 이는 direct location click이 editor command boundary까지 도달하는지는 보여주지만, `spawn_editor_process`가 실제 process argv로 `--goto <path>:line:column`을 넘기는지는 E2E 경계에서 확인하지 못했다.
- `CLCOMX_TEST_MODE_EDITOR_REAL_LAUNCH=1`을 추가해 test-mode에서도 기본 payload 기록은 유지하되, 명시적으로 켠 경우 `CLCOMX_WIN_EDITOR_*_PATH` override를 실제 editor process로 spawn하도록 했다. 일반 E2E mock은 기존처럼 `C:\Mock\<editor>.exe` 감지 + payload 기록 후 반환한다.
- `e2e/agent-runtime/agent-runtime.test.ts`는 fake `cursor.cmd`를 stateDir에 만들고, direct Codex tool location click 후 실제 spawned process가 `--goto \\wsl.localhost\clcomx-test\home\tester\workspace\src\lib\example.ts:12:4` argv를 받았는지 로그로 확인한다. 실제 설치 editor의 focus/line reveal은 여전히 fake process 검증 범위를 넘는 잔여 실측 slice다.
- RED: `cargo test --manifest-path src-tauri/Cargo.toml test_mode_real_editor_launch_spawns_override_with_line_args -- --nocapture`가 fake editor args 파일 timeout으로 실패했다.
- GREEN: 같은 targeted Rust test 통과, `cargo test --manifest-path src-tauri/Cargo.toml editor_launch -- --nocapture` 통과(2 tests), `npm run test:e2e -- --project agent-runtime --reporter=dot`는 WSL import-only로 15 skipped/transform OK, 최신 빌드 기준 `npm run test:e2e:wsl -- --project agent-runtime` 통과(1 file / 15 tests).

## 2026-06-29 테스트 안정화 — real-launch env guard 격리

- OQ-61 real-launch 검증은 전역 env `CLCOMX_TEST_MODE_EDITOR_REAL_LAUNCH`를 사용한다. Rust test는 기본 병렬 실행이므로 모듈-local 임시 env guard만 쓰면 다른 test-mode editor detection 테스트와 교차될 수 있다.
- `app_env::test_support::set_test_mode_editor_real_launch_env()`를 추가해 해당 env도 공유 lock/restore guard로 관리하게 했고, `editor_launch` real-launch test가 이 guard를 사용하도록 바꿨다.
- RED: `cargo test --manifest-path src-tauri/Cargo.toml test_mode_editor_real_launch_guard_sets_and_restores_env -- --nocapture`가 `set_test_mode_editor_real_launch_env` 부재로 컴파일 실패했다.
- GREEN: 같은 targeted test 통과, `cargo test --manifest-path src-tauri/Cargo.toml editor_launch -- --nocapture` 통과(2 tests), 최종 `npm run verify` 통과(Vitest 132 files / 989 tests, Rust 164 tests, svelte-check 0 errors/0 warnings, Vite build OK, cargo check OK).

## 2026-06-29 E2E 보강 — scrubbed direct workspace cold restore

- FE-24b/OQ-16의 scrubbed cold restore 경로는 Svelte 단위 테스트와 workspace scrub 테스트로 고정돼 있었지만, 실제 `workspace.json`을 seed한 Windows 앱 부팅 경계에서는 검증되지 않았다.
- `e2e/agent-runtime/agent-runtime.test.ts`에 scrubbed direct `workspace.json` seed spec을 추가했다. `runtimeKind:"direct-codex"`와 provider/capability metadata는 있으나 `providerThreadId`가 없는 탭을 복원하면 direct host가 mount되고 legacy PTY host는 열리지 않으며, 복원 불가 notice 표시 후 fresh direct session으로 새 prompt가 동작해야 한다.
- E2E helper는 장시간 agent-runtime project에서 고정 `tauri-driver` port 4444가 이전 세션 종료 직후 재사용되는 race를 줄이도록 cleanup 시 driver quit, process exit 대기, port close 대기를 수행한다. launcher picker류 click은 Windows WebDriver에서 간헐적으로 native click이 no-op 되는 구간이 있어 DOM click helper로 좁혀 안정화했다.
- RED: 최초 Windows `agent-runtime` E2E는 restore notice testid 부재로 cold-restore spec이 실패했다. 이후 locale 기대값(ko 기본 문자열)과 `can not listen to address: 127.0.0.1:4444` port race, picker click no-op으로 full project 재실행이 불안정했다.
- GREEN: `npm run test:e2e:wsl -- --skip-build --project agent-runtime` 통과(1 file / 16 tests), `npm run test:e2e -- --project agent-runtime --reporter=dot` 통과(WSL import-only, 1 file / 16 skipped), 최종 `npm run verify` 통과(Vitest 132 files / 989 tests, Rust 164 tests, svelte-check 0 errors/0 warnings, Vite build OK, cargo check OK).

## 2026-06-29 보강 — OQ-54 replay full-snapshot 상한 방어

- OQ-54는 Codex `thread/read(includeTurns)`가 gap-only인지 전체 snapshot인지 아직 실제 app-server wire로 확인되지 않아, tombstone replay의 정확한 조회 범위·필터링 정책은 계속 열린 상태다. 다만 전체 snapshot이 반환될 경우 현재 read-only replay가 loader event 전체를 scratch reducer에 넣을 수 있어, 정책 확정 전 하한 방어가 필요했다.
- `DEFAULT_REPLAY_EVENT_LIMIT`(기본 1000)을 추가하고, `createPortReplayLoader`의 provider port event 수집과 `loadReplayTranscript`의 scratch reduce 입력 양쪽에 같은 상한을 적용했다. 이 상한은 live store 병합 금지·scratch 폐기 경계를 바꾸지 않으며, OQ-54의 실제 gap/full 판정이나 정밀 range policy를 대체하지 않는다.
- RED: `npm run test -- src/lib/features/agent-runtime/service/runtime-replay.test.ts`가 full snapshot 3건 입력에서 `eventCount` 3을 반환하고, provider port loader도 3건 모두 수집해 새 상한 테스트 2개가 실패했다.
- GREEN: 같은 targeted test가 통과했다(1 file, 9 tests). 앱 launch, Windows E2E, 실제 Codex app-server `thread/read(includeTurns)` 응답 범위 실측은 수행하지 않았다.

## 2026-06-29 E2E 재검증 — agent-runtime 및 전체 Windows pack

- 사용자 지시에 따라 수동 앱 launch는 하지 않고 E2E runner부터 재검증했다. 첫 `npm run test:e2e:wsl -- --skip-build --project agent-runtime`는 현재 shell `PATH`에 `powershell.exe`가 없어 runner 진입 전 실패했다. `PATH`에 `/mnt/c/Windows/System32/WindowsPowerShell/v1.0`과 `/mnt/c/Windows/System32`를 추가하자 다음 실패는 sandbox가 `/mnt/c/temp/clcomx` mirror permission/time 설정을 막은 `rsync` code 23으로 분리됐다.
- 권한 상승으로 Windows mirror sync와 WebDriver/Tauri process 실행을 허용한 뒤, `env PATH="$PATH:/mnt/c/Windows/System32/WindowsPowerShell/v1.0:/mnt/c/Windows/System32" npm run test:e2e:wsl -- --skip-build --project agent-runtime`가 통과했다(1 file / 16 tests). 이어서 같은 PATH/권한 조건으로 `npm run test:e2e:wsl -- --skip-build` 전체 pack도 통과했다. 전체 pack은 `smoke`, `settings`, `windows-tabs`, `workspace-restore`, `image-paste`, `agent-runtime`, `terminal-input`, `terminal-links`, `terminal-aux` 순차 실행이며 현재 9 projects / 27 tests다.
- 이번 재검증은 E2E runner 경유 실행이며, 별도 수동 앱 launch는 수행하지 않았다. 실제 설치 external editor focus/line reveal(OQ-61), 실제 Codex app-server `thread/read(includeTurns)` 응답 범위(OQ-54), provider same-turn late notification 실측(OQ-53)은 여전히 후속 실측 범위다.

## 2026-06-29 보강 — WSL E2E runner PowerShell fallback

- 위 E2E 재검증 중 현재 shell `PATH`에 `powershell.exe`가 없어 WSL wrapper가 Windows runner를 시작하지 못하는 문제가 재현됐다. Windows PowerShell 기본 경로는 존재했으므로, wrapper가 `PATH`에만 의존하지 않고 `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`를 fallback으로 사용할 수 있어야 한다.
- `scripts/e2e-smoke-windows.sh`가 `POWERSHELL_EXE` env override → `command -v powershell.exe` → Windows 기본 PowerShell 경로 순서로 실행 파일을 해석하도록 보강했다. 최종 PowerShell 호출은 해석된 `"$POWERSHELL_EXE"`를 사용한다. `docs/testing/e2e.md`에도 WSL PATH fallback을 명시했다.
- RED: `npm run test -- scripts/e2e-runner-scripts.test.ts -t "PowerShell"`가 `command -v powershell.exe`와 fallback 경로 부재로 실패했다.
- GREEN: 같은 targeted test 통과, 이어서 `npm run test -- scripts/e2e-runner-scripts.test.ts` 통과(1 file / 4 tests). `powershell.exe` PATH 보정 없이 권한 상승만 붙인 `npm run test:e2e:wsl -- --skip-build --project agent-runtime`도 fallback 경로로 Windows runner에 진입해 통과했다(1 file / 16 tests).

## 2026-06-29 실측/보강 — OQ-54 Codex thread/read full snapshot

- `codex-cli 0.142.2` app-server를 `--stdio`로 직접 띄워 `initialize` → `thread/list{limit:5}` → `thread/read(includeTurns:false/true)` 순서로 read-only probe를 수행했다. sandbox 안에서는 `~/.codex` state runtime 초기화가 read-only 파일시스템 오류로 막혔고, 권한 상승 재실행에서 프로브가 성공했다.
- 실측 결과 `thread/list`의 listed thread는 `turns:[]`, `thread/read{includeTurns:false}`도 `turns.length=0`이었다. 같은 thread에 `thread/read{includeTurns:true}`를 보내면 전체 thread snapshot이 반환됐고, 현재 thread 기준 `turns.length=32`, 첫 turn `items.length=33`, `itemsView:"full"`이었다. 따라서 OQ-54의 gap-only vs snapshot 질문은 현재 Codex API 기준 full snapshot으로 해소했다.
- full snapshot 비용 방어가 조용한 잘림이 되지 않도록 `ReplayPanel`이 `ReplayResult.truncated`를 표시해 partial snapshot notice를 보여주도록 보강했다. 이 notice는 read-only inspection 경계만 알리며 live store 병합 금지, scratch 폐기, 기본 1000 event 상한은 유지한다.
- RED: `npm run test -- src/lib/features/agent-runtime/view/ReplayPanel.test.ts -t "partial snapshot"`가 partial notice 부재로 실패했다.
- GREEN: 같은 targeted test 통과. 이어서 `npm run test -- src/lib/features/agent-runtime/service/runtime-replay.test.ts src/lib/features/agent-runtime/view/ReplayPanel.test.ts src/lib/i18n/key-parity.test.ts` 통과(3 files / 19 tests), `npx --no-install svelte-check --tsconfig ./tsconfig.json` 0 errors / 0 warnings, `git diff --check` 통과.

## 2026-06-29 실측 — OQ-46 Codex reasoning snapshot 후보 부재

- OQ-54와 같은 `codex app-server --stdio` read-only probe로 최근 thread 3개의 `thread/read{includeTurns:true}` snapshot item 종류를 확인했다. 현재 thread는 `agentMessage` 880개, `contextCompaction` 17개, `fileChange` 201개, `mcpToolCall` 2개, `userMessage` 2개였고, 표본 3개 모두에서 `reasoning` item 또는 `summary` 필드를 가진 completed reasoning item은 발견되지 않았다.
- 따라서 OQ-46의 `summary[]` vs `content[]` 권위 필드는 해소하지 않는다. 현재 보수 매핑(CX-5c)은 유지하고, 실제 reasoning item이 포함된 Codex wire/snapshot을 확보할 때 다시 좁힌다.

## 2026-06-30 보강 — OQ-52 default-cap 1,000-turn synthetic fixture

- OQ-52는 v1 기본 cap 구현 자체는 닫혀 있었지만, 문서의 "수백~수천 turn" 검출 문구에 비해 store-level 증거가 작은 injected cap fixture 중심이었다.
- `agent-runtime-store.svelte.test.ts`에 기본 cap(`HOT_WINDOW_SEALED_TURNS=50`, `TOMBSTONE_LRU=200`) 그대로 1,000 turn을 합성하는 OQ-52 fixture를 추가했다. 이 테스트는 `visibleItemIds`/`itemVersions`/`itemsById`가 hot window에 수렴하고, `turnsById`와 tombstone LRU가 `hotWindow + tombstoneLru` 범위에 머무르며, evicted-tombstone late drop과 sealed-retained late patch/reseal 분기가 장기 세션 뒤에도 유지되는지 검증한다.
- 확인: `npm run test -- src/lib/features/agent-runtime/state/agent-runtime-store.svelte.test.ts -t "OQ-52"` 통과(1 file, 1 selected test). product 동작 변경, 앱 launch, 실제 대용량 세션 성능 실측은 수행하지 않았다.
