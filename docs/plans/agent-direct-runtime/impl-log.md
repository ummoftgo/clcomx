# Direct Agent Runtime — 구현 로그 / 게이트 결정 기록

> 이 문서는 구현 세션의 preflight 결과와 게이트 결정(T0.0/T2.0/H4 및 관련 OQ)을 기록한다. 13의 결정 정본을 인용·구체화하며, 구현 에이전트가 따르는 확정값을 모은다.

확인일: 2026-06-26. 구현 브랜치: `feat/agent-runtime-impl` (기점 `feat/agent-runtime`).

## T0.0 / OQ-41 — preflight (확인 완료)

| 항목 | baseline(문서) | 현재 환경 | 결정 |
|---|---|---|---|
| 작업 루트 | `/home/xenia/work/claudemx` | `/home/xenia/work/claudemx` | 일치 |
| git root | 동일 | `/home/xenia/work/claudemx` | 일치 |
| 브랜치 | `codex/direct-agent-runtime-docs` | `feat/agent-runtime-impl` | 구현용 신규 브랜치 |
| Codex CLI | `rust-v0.142.0` | `codex-cli 0.142.2` | 패치 diff. `generate-ts` 동작·v2 thread/turn 모델 유지 → **수용** |
| `generate-ts` | 제공 가정 | **제공됨** (`--out <DIR>`) | T0.3는 generate-ts 사용(수기 미러 fallback 불필요) |
| claude-agent-acp | `0.51.0` 핀 | npm 최신 `0.52.0` | **0.51.0 고정 유지**(RD-5; OQ-08/OQ-41 diff 결론 전 임의 상향 금지) |
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
- **OQ-36 (resolve owner, 결정)**: `resolve_trusted_executable(provider, distro)` / `resolve_trusted_adapter_entry(provider, distro)`의 owner 모듈 = **`agent_runtime/resolver.rs`**(allowlist.rs가 호출). 탐색: WSL distro 안에서 `command -v codex`/`command -v node`로 신뢰 절대경로 resolve, claude adapterEntryPath는 `claude-agent-acp` 패키지의 `dist/index.js`를 node_modules에서 resolve. 캐시 = `(provider, distro)` 키 in-memory(프로세스 수명; TTL 없음, miss 시 재resolve, 무효화 트리거는 후속). resolve 실패 = `Err(String)`("codex/node not found in WSL distro <distro>"). 동명 바이너리(`/tmp/codex`·`/tmp/node`)는 절대경로 resolve로 차단.
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
- **OQ-52/53/54 (보수적 기본값, unverified)**: `HOT_WINDOW_SEALED_TURNS = 50`, `TOMBSTONE_LRU = 200`, `SEAL_QUIESCENCE_GRACE_MS = 250`. late same-turn은 seal grace로 흡수(sealed-retained patch). 정확 수치는 실측 후속.
- **RD-2/RD-4**: direct runtime은 실험 flag 뒤. raw protocol log 기본 off. websocket start는 로깅/스냅샷 전 reject.

---

## 구현 완료 요약 (Phase 0–7, 2026-06-26)

브랜치 `feat/agent-runtime-impl`, 커밋 `c36b97c`(P0)→`cd4aec8`(P6). 신규 소스 42 + 테스트 28 + backend Rust 7. 울트라코드 Workflow로 페이즈별 병렬/순차 분배.

| Phase | 내용 | 검증 |
|---|---|---|
| 0 | 스캐폴드, 타입 정본(15), Codex 생성 타입 vendoring, claude dep 핀, 픽스처, 게이트 결정 | svelte-check 0, cargo check |
| 1 | reducer(seal/eviction/3-상태), pending table, audit, store, router/registry, legacy-pty | vitest +55 |
| 2 | Rust wire 타입, resolver/allowlist, process spawn, JSON-RPC framing, command 5종, transport 래퍼 | cargo +112 |
| 3 | Codex app-server 어댑터(wire→AgentEvent, reconcile, approval, 삼중 키) | CX-1..20 |
| 4 | Claude ACP 어댑터(JSON-RPC 2.0, chunk/replace, permission rpcId 보존, turn 합성) | CL-1..27 |
| 5 | 데스크톱식 transcript UI(host 분기, 메시지/카드/approval/composer, 격리 replay) | vitest 732 |
| 6 | persistence(runtime_kind/agent_runtime, scrub), Claude entry resolve, launcher direct 선택, fallback | vitest 754, cargo 115 |

**최종 게이트(11 §8.6)**: `npm run verify` 통과 — vitest 754 / cargo test 115 / svelte-check 0 errors(1169 files) / vite build OK / cargo check OK. `cargo build` 바이너리 링크 성공.

**환경 제약(Phase 7 잔여)**:
- E2E(E2E-1..10)·app launch(T7.2): selenium + Windows Tauri 앱 구동 필요 → 현재 WSL 헤드리스 환경에서 실행 불가. test-mode mock(`is_test_mode`/CLCOMX_TEST_MODE)은 backend 연결됨. 빌드 게이트(check/build)는 충족. 실제 GUI smoke는 Windows 환경에서 수행.

**알려진 후속(13 OQ 인용)**:
- 무거운 item heap byte cap(HOT_WINDOW_BYTES) 미구현 — turn-count cap만(OQ-52).
- approval 영속 audit 로그 — v1 in-memory만(OQ-51).
- cross-key 전역 seq 정렬 — per-키 receive-order만(D-SEQ, OQ-17).
- cold-restore 후 direct 대화 복원 — scrub로 디스크 키 부재, 1차 범위 밖(OQ-16, PTY와 일관).
- recent history direct provider 배지 — history는 direct id 미저장(10 §5.5).
- Codex `thread/read includeTurns` 범위·same-turn late notification 실측 — 격리 replay/seal grace는 보수적 기본값(OQ-53/54).
