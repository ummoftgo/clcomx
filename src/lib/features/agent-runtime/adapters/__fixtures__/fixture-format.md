# Adapter fixture 포맷 (정본)

> provider wire message 시퀀스를 재생해 adapter/reducer를 테스트하는 fixture 포맷. 11 §1 replay harness와 단일 형식으로 통일한다.

## 정본 직렬화 = NDJSON `.jsonl`

- 파일 확장자: `.jsonl` (한 줄 = 한 envelope).
- 각 줄: `{ "direction": "in" | "out", "message": JsonRpcMessage }`
  - `in` = provider → client (수신, adapter가 `AgentEvent`로 변환할 대상)
  - `out` = client → provider (송신, adapter가 생성해야 할 wire)
- `JsonRpcMessage`는 15 §8.1 union(`jsonrpc` optional — Codex는 생략, ACP는 `"2.0"`).
- 논리적으로는 `{direction,message}[]` 배열과 동형이나, **정본 직렬화는 NDJSON**(11 §1.2 harness가 줄 단위로 로드).

## 기대 산출

- `<name>.expected.json`: 해당 fixture를 재생했을 때 reducer/adapter가 내놓는 정규화 결과.
  - adapter 테스트: 기대 `AgentEvent[]`.
  - reducer 테스트: 기대 `TranscriptModel` 또는 그 부분.

## Codex / Claude 공용

- Codex(`codex/...`) 와 Claude(`claude-acp/...`) 모두 이 포맷을 쓴다.
- backend test-mode mock(T2.5 `is_test_mode()`)도 같은 `.jsonl`을 줄 단위로 로드해 재생한다(E2E mock과 fixture replay 단일 출처).

## 예시

`codex-initialize.jsonl` / `claude-initialize.jsonl`(hello-world). 더 풍부한 시퀀스 fixture는 Phase 3(Codex)·Phase 4(Claude) adapter task가 추가한다.
