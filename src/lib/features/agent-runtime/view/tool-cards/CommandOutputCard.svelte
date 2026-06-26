<!--
  CommandOutputCard — execute tool call의 command/cwd/stdout/stderr embed(08 §4·§7.3, T5.3).

  08 §7.4가 허용하는 "live append만 하는 경량 read-only 렌더"를 채택한다(full xterm 미사용).
  이렇게 하면 임베드가 키 입력 포커스를 가지지 않아 **앱 단축키를 가로채지 않는다**(작업 지침: app shortcut 비가로채기).
  stdout/stderr stream 구분을 보존하고(04 §3.2.3), stderr diagnostic은 기본 접힘이다(09).
  고정 높이 + resize 가능한 출력 영역. 모든 문자열은 i18n 키만 쓴다(하드코딩 금지).
-->
<script lang="ts">
  import { t } from "../../../../i18n";
  import { TEST_IDS } from "../../../../testids";

  interface Props {
    /** 실행 명령(헤더 표시). */
    command?: string;
    /** 작업 디렉토리(헤더 표시). */
    cwd?: string;
    /** 표준 출력 누적 문자열. */
    stdout?: string;
    /** 표준 오류 누적 문자열(기본 접힘). */
    stderr?: string;
  }

  let { command, cwd, stdout = "", stderr = "" }: Props = $props();

  // stderr는 diagnostic이라 기본 접힘(09). 내용이 있으면 토글로 펼친다.
  let stderrExpanded = $state(false);
  const hasStderr = $derived(stderr.trim().length > 0);
  const hasStdout = $derived(stdout.trim().length > 0);
</script>

<div class="command-output-card" data-testid={TEST_IDS.agentCommandOutputCard}>
  <div class="cmd-header">
    <span class="cmd-prompt" aria-hidden="true">$</span>
    <span class="cmd-line" title={command}>{command ?? $t("agentRuntime.command.title")}</span>
    {#if cwd}
      <span class="cmd-cwd" title={cwd}>{$t("agentRuntime.command.cwdLabel")}: {cwd}</span>
    {/if}
  </div>

  <!-- read-only 출력 임베드: tabindex/contenteditable 없음 → 포커스·키 입력 비가로채기. -->
  <div
    class="cmd-output"
    data-testid={TEST_IDS.agentCommandOutput}
    data-stream="stdout"
    role="log"
    aria-label={$t("agentRuntime.command.stdoutLabel")}
  >
    {#if hasStdout}
      <pre class="cmd-pre">{stdout}</pre>
    {:else}
      <span class="cmd-empty">{$t("agentRuntime.command.empty")}</span>
    {/if}
  </div>

  {#if hasStderr}
    <button
      type="button"
      class="cmd-stderr-toggle"
      aria-expanded={stderrExpanded}
      onclick={() => (stderrExpanded = !stderrExpanded)}
    >
      {$t("agentRuntime.command.stderrLabel")}
    </button>
    {#if stderrExpanded}
      <div class="cmd-output stderr" data-stream="stderr" role="log">
        <pre class="cmd-pre">{stderr}</pre>
      </div>
    {/if}
  {/if}
</div>

<style>
  .command-output-card {
    border: 1px solid var(--color-border, rgba(127, 127, 127, 0.25));
    border-radius: 0.45rem;
    overflow: hidden;
    font-size: 0.8rem;
  }
  .cmd-header {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.4rem 0.6rem;
    background: var(--color-surface, rgba(127, 127, 127, 0.06));
    font-family: var(--font-mono, monospace);
  }
  .cmd-prompt {
    opacity: 0.5;
  }
  .cmd-line {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cmd-cwd {
    flex: 0 0 auto;
    font-size: 0.7rem;
    opacity: 0.55;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
  }
  .cmd-output {
    max-height: 16rem;
    overflow: auto;
    resize: vertical;
    padding: 0.4rem 0.6rem;
    background: var(--color-bg, transparent);
  }
  .cmd-output.stderr {
    border-top: 1px solid var(--color-border, rgba(127, 127, 127, 0.2));
  }
  .cmd-pre {
    margin: 0;
    font-family: var(--font-mono, monospace);
    font-size: 0.76rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cmd-empty {
    opacity: 0.45;
    font-size: 0.76rem;
  }
  .cmd-stderr-toggle {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.3rem 0.6rem;
    background: none;
    border: none;
    border-top: 1px solid var(--color-border, rgba(127, 127, 127, 0.2));
    color: var(--color-warning, #d29922);
    font: inherit;
    font-size: 0.74rem;
    cursor: pointer;
  }
</style>
