# Current State

## 현재 실행 흐름

CLCOMX는 Tauri v2, Svelte 5, xterm.js, Rust PTY backend로 구성되어 있다.

1. 사용자가 새 세션을 만든다.
2. `src/lib/agents/registry.ts`가 `claude`, `claude --resume <id>`, `codex`, `codex resume <id>` 형태의 shell command를 만든다.
3. `src/lib/pty.ts`의 `spawnPty`가 `wsl.exe -d <distro> -e bash -li -c ...`로 WSL 안에서 command를 실행한다.
4. `src-tauri/src/features/terminal/mod.rs`가 portable PTY를 통해 stdout/stderr stream을 읽고 `pty-output`, `pty-exit` event를 emit한다.
5. `src/lib/features/terminal/controller/main-terminal-runtime-controller.ts`가 output chunk를 xterm에 쓰고, loading/ready signal, bottom lock, resume fallback marker, canonical screen snapshot을 관리한다.

## 현재 강점

- Claude/Codex의 터미널 TUI를 거의 그대로 보여준다.
- WSL에서 실제 CLI를 실행하므로 CLI 인증, config, shell environment를 자연스럽게 재사용한다.
- xterm, 보조 터미널 dock, 파일 링크, 이미지 붙여넣기, session restore가 이미 통합되어 있다.
- PTY output log와 chunk log가 있어 late attach와 화면 복구가 가능하다.

## 현재 한계

- agent message, tool call, approval, diff, command output이 구조화되지 않고 terminal byte stream으로 섞인다.
- Codex/Claude의 내부 session/turn/message/tool identifier를 안정적으로 알 수 없다.
- approval UI나 tool progress UI를 만들려면 terminal text와 escape sequence를 추정해야 한다.
- 여러 turn stream 또는 background task를 정확히 라우팅하기 어렵다.
- terminal ready signal, prompt glyph, footer text 같은 UI marker에 의존하는 회귀 위험이 있다.

## 보존할 기능

- 보조 셸 dock과 명령 실행 화면
- legacy PTY session 실행
- xterm 기반 terminal rendering
- 파일 경로 링크, URL 링크, 이미지 붙여넣기
- 기존 session history와 resume token fallback

## 분리할 경계

Direct runtime은 기존 `spawnPty`를 대체하지 않고 새 runtime family로 추가한다.

- PTY runtime: terminal-first agent 또는 shell subprocess를 실행한다.
- Direct agent runtime: JSON-RPC/protocol event를 읽어 normalized transcript event로 변환한다.
- UI renderer: terminal byte stream이 아니라 normalized event를 기준으로 message, tool card, approval modal, diff card를 그린다.
