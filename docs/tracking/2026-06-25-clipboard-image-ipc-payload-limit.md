# Clipboard Image IPC Payload Limit Follow-up

## Summary

클립보드 이미지 붙여넣기 경로에 25 MiB per-image 제한과 250 MiB cache quota를 추가했다. 프런트엔드는 `Blob.arrayBuffer()` 호출 전에 이미지 크기를 확인하고, Rust 명령은 파일 쓰기 전에 동일한 per-image 제한과 cache quota를 다시 검증한다.

다만 Tauri command가 `bytes: Vec<u8>`를 인자로 받는 구조이므로, 악의적인 직접 invoke는 Rust 명령 본문에 들어오기 전에 IPC 역직렬화 단계에서 큰 payload를 먼저 메모리에 올릴 수 있다. 현재 수정은 정상 UI 경로와 명령 진입 후 저장 단계의 DoS 위험을 줄이지만, 역직렬화 전 메모리 사용까지 완전히 제한하지는 않는다.

## Current Mitigations

- 프런트엔드 `saveClipboardImage`는 25 MiB를 넘는 `Blob`을 `arrayBuffer()`로 변환하지 않는다.
- overlay paste 경로는 초과 크기와 제한값을 사용자에게 i18n 메시지로 표시한다.
- Rust `save_clipboard_image`는 per-image 제한을 다시 확인한다.
- Rust 저장 경로는 cache quota 확인, 파일명 할당, 파일 쓰기를 같은 mutex 아래에서 수행해 동시 저장 race로 quota가 초과되는 일을 막는다.
- 관련 테스트가 프런트엔드와 Rust 양쪽에 추가됐다.

## Remaining Risk

- Tauri IPC 역직렬화가 `Vec<u8>` 할당을 먼저 수행할 수 있다.
- 따라서 신뢰할 수 없는 renderer 또는 개발자 도구에서 명령을 직접 호출할 수 있는 상황에서는 backend limit에 도달하기 전에 큰 payload가 메모리 압박을 만들 수 있다.
- 이 문제는 현재 command 내부 검증만으로는 해결하기 어렵고, 이미지 전달 방식 자체를 바꾸는 설계 변경이 필요하다.

## TODO

- `save_clipboard_image` command가 대용량 raw byte 배열을 직접 받지 않도록 설계한다.
- 후보 설계:
  - renderer에서 임시 파일로 먼저 쓰고 Rust에는 file handle/path와 metadata만 전달한다.
  - streaming IPC 또는 chunked transfer를 도입해 각 chunk에 크기 제한과 누적 제한을 적용한다.
  - Tauri/WebView 레벨에서 command payload size limit을 설정할 수 있는지 확인하고, 가능하면 앱 공통 제한으로 둔다.
- 새 설계에서는 다음을 명시적으로 보장한다.
  - per-image 제한을 넘는 데이터가 한 번에 Rust heap에 올라오지 않는다.
  - cache quota 검증과 최종 저장이 race 없이 원자적으로 동작한다.
  - 실패 시 임시 파일 또는 partial chunk가 남지 않는다.
  - 정상 UI 붙여넣기, 직접 invoke, 반복 병렬 invoke를 각각 테스트한다.

## Relevant Files

- [src/lib/clipboard.ts](/home/xenia/work/claudemx/src/lib/clipboard.ts)
- [src/lib/features/terminal/controller/overlay-clipboard-image-controller.ts](/home/xenia/work/claudemx/src/lib/features/terminal/controller/overlay-clipboard-image-controller.ts)
- [src-tauri/src/commands/clipboard.rs](/home/xenia/work/claudemx/src-tauri/src/commands/clipboard.rs)
- [src/lib/clipboard.test.ts](/home/xenia/work/claudemx/src/lib/clipboard.test.ts)
- [src/lib/features/terminal/controller/overlay-clipboard-image-controller.test.ts](/home/xenia/work/claudemx/src/lib/features/terminal/controller/overlay-clipboard-image-controller.test.ts)

## Exit Criteria

- 큰 이미지 payload가 IPC 역직렬화 전에 거부되거나 chunk 단위 제한을 받는다.
- `save_clipboard_image`에 대한 직접 invoke가 25 MiB 초과 이미지로 process memory를 크게 증가시키지 않는다.
- 병렬 붙여넣기 시 per-image 제한과 cache quota가 모두 유지된다.
- 임시 파일 또는 chunk 기반 설계를 선택한 경우 실패 cleanup 테스트가 포함된다.
