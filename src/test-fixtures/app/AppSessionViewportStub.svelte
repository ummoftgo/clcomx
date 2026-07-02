<script lang="ts">
  import type { SessionFallbackToPtyRequest } from "../../lib/features/session/contracts/session-shell";

  let {
    onSessionFallbackToPty,
    onSessionTitleChange,
  }: {
    onSessionFallbackToPty?: (request: SessionFallbackToPtyRequest) => void | Promise<void>;
    onSessionTitleChange?: (sessionId: string, title: string | null) => void | Promise<void>;
  } = $props();

  /** direct fallback 요청을 App 경계에서 검증하기 위한 테스트 fixture 콜백이다. */
  function requestFallbackToPty(): void {
    void onSessionFallbackToPty?.({
      sessionId: "session-1",
      agentId: "claude",
      distro: "Ubuntu",
      workDir: "/workspace/demo",
      resumeToken: "legacy-resume-1",
    });
  }

  /** direct runtime provider title 갱신을 App 경계에서 검증하기 위한 테스트 fixture 콜백이다. */
  function requestTitleChange(): void {
    void onSessionTitleChange?.("session-1", "Provider title");
  }

  /** provider가 title clear를 보낼 때 App fallback title 정규화를 검증한다. */
  function requestTitleClear(): void {
    void onSessionTitleChange?.("session-1", null);
  }
</script>

<div data-testid="session-viewport-stub">
  <button
    data-testid="session-viewport-fallback-pty"
    type="button"
    onclick={requestFallbackToPty}
  >
    Fallback PTY
  </button>
  <button
    data-testid="session-viewport-title-change"
    type="button"
    onclick={requestTitleChange}
  >
    Title Change
  </button>
  <button
    data-testid="session-viewport-title-clear"
    type="button"
    onclick={requestTitleClear}
  >
    Title Clear
  </button>
</div>
