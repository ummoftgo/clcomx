# Codex app-server generated types (DO NOT EDIT)

이 디렉토리는 `codex app-server generate-ts` 산출물을 **그대로** 배치한 것이다. **수동 수정 금지.**

- 생성 명령: `codex app-server generate-ts --out <this dir>`
- Codex CLI 버전: `codex-cli 0.142.2` (baseline 문서 핀 `rust-v0.142.0`, 패치 diff — impl-log.md OQ-41 참조)
- 생성 시점: 2026-06-26
- 정본 지위: Phase 3 Codex adapter의 wire 타입 **정본**(ref-codex보다 우선, 충돌 시 실제 생성 타입 우선).
- v2 thread/turn/item 모델은 `v2/` 하위에 있다(`TurnStartParams`/`UserInput`/`ServerNotification`/`ServerRequest` 등).

핵심 확인(impl-log.md H4):
- `v2/UserInput.ts` `text` variant는 `text_elements: Array<TextElement>` **필수** → outbound는 `{ type:"text", text, text_elements: [] }`.
