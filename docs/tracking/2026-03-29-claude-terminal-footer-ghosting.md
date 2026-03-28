# Claude Terminal Footer Ghosting Watch

## Summary

Claude Code를 CLCOMX 임베디드 xterm에서 사용할 때, 프롬프트 하단의 버전/토큰/상태 footer가 잔상처럼 남거나 스크롤 중 본문과 섞여 올라가는 문제가 관찰됐다.

이 이슈는 단순 canvas 픽셀 ghosting이 아니라, **Claude footer redraw와 xterm buffer/state가 실제로 오염되는 계열**로 판별됐다. 다만 2026-03-29 기준 실험 패치 적용 후에는 증상이 크게 줄었고, 현재는 **재발 감시 단계**다.

## What We Confirmed

- raw PTY output에 Claude footer redraw 시퀀스가 직접 들어온다.
  - `CSI ? 2026 h/l` synchronized output 토글
  - 절대 커서 이동 시퀀스
  - `current`, `latest`, token 수치, plan mode/footer 텍스트
- xterm visible buffer에도 footer 조각이 실제로 섞여 들어갔다.
  - 따라서 DOM overlay나 paint-only 문제로 보기 어렵다.
- 초기에 CLCOMX 쪽 `post-write scrollToBottom()`과 공격적인 bottom-lock이 증상을 증폭시켰다.
- 우측 footer 정렬 잔여 문제는 Unicode 폭 계산에도 영향을 받는 것으로 보였다.

## Current Experimental Mitigations

현재 실험은 기본 동작이 아니라 env flag로만 켜진다.

- `CLCOMX_DEBUG_TERMINAL_HOOKS=1`
  - 실제 Claude 세션에서도 terminal debug hook을 연다.
  - raw output snapshot, viewport, visible buffer lines를 채취할 수 있다.
- `CLCOMX_SOFT_FOLLOW_EXPERIMENT=1`
  - Claude 세션에서 footer redraw 중 스크롤 증폭을 줄이기 위한 실험을 켠다.

실험 모드에서 들어간 핵심 완화:

- 반복적인 bottom-lock scroll tick 완화
- synchronized output / repaint chunk에 대한 즉시 `scrollToBottom()` 억제
- repaint 이후 deferred/coalesced bottom scroll 적용
- xterm `Unicode11` 폭 규칙 활성화

## Status On 2026-03-29

- 초기에는 footer 정보가 본문 표/문장 끝에 섞이고, `current/latest`, `medium`, stray digit 등이 buffer에 남는 현상이 명확했다.
- scroll 억제 실험 후 증상이 크게 줄었다.
- `Unicode11` 폭 규칙까지 추가한 뒤에는 수동 사용 중 눈에 띄는 증상이 거의 사라졌다.
- 다만 완전 종결로 보기엔 이르다.
  - 드물게 줄 끝 숫자 1개나 footer 파편이 남는 잔여 케이스가 한 번 더 관찰됐다.
  - 따라서 현재 상태는 `fixed`가 아니라 `watching`이다.

## Repro / Capture Procedure

실제 Claude 세션에서 재현이 의심되면 다음 env로 앱을 띄운다.

```bash
CLCOMX_DEBUG_TERMINAL_HOOKS=1
CLCOMX_SOFT_FOLLOW_EXPERIMENT=1
```

DevTools Console에서 아래 값을 먼저 확인한다.

```js
const shell = document.querySelector('[data-testid="terminal-shell"]:not(.hidden)');
({
  debugTerminalHooks: document.querySelector('[data-testid="app-root"]')?.dataset.debugTerminalHooks,
  softFollowExperiment: shell?.dataset.softFollowExperiment,
});
```

둘 다 `"true"`여야 한다.

그다음 snapshot 채취:

```js
const shell = document.querySelector('[data-testid="terminal-shell"]:not(.hidden)');
const sessionId = shell?.dataset.sessionId;
const hook = window.__clcomxTestHooks?.terminals?.[sessionId];

const output = await hook?.getOutputSnapshot?.();
const viewport = hook?.getViewportState?.();
const buffer = hook?.getBufferSnapshot?.();

console.log(JSON.stringify({
  sessionId,
  ptyId: shell?.dataset.ptyId,
  viewport,
  buffer,
  outputTail: output ? { seq: output.seq, tail: output.data.slice(-6000) } : null,
}, null, 2));
```

## Watch Points

장시간 Claude 세션에서 아래를 우선 관찰한다.

- 본문 줄 끝에 뜬금없는 숫자 1개 또는 2개가 남는지
- `current`, `latest`, token 수치, `medium`, `plan mode`, `accept edits` 같은 footer 조각이 본문에 섞이는지
- footer separator line이 본문 위쪽으로 같이 올라가는지
- 한국어/CJK/emoji가 섞인 footer 상태줄에서 우측 정렬이 갑자기 무너지는지

## Relevant Files

- [src/lib/components/Terminal.svelte](/home/xenia/work/claudemx/src/lib/components/Terminal.svelte)
- [src/lib/testing/test-bridge.ts](/home/xenia/work/claudemx/src/lib/testing/test-bridge.ts)
- [src/App.svelte](/home/xenia/work/claudemx/src/App.svelte)
- [src/lib/bootstrap.ts](/home/xenia/work/claudemx/src/lib/bootstrap.ts)
- [src/lib/types.ts](/home/xenia/work/claudemx/src/lib/types.ts)
- [src-tauri/src/app_env.rs](/home/xenia/work/claudemx/src-tauri/src/app_env.rs)
- [src-tauri/src/commands/settings.rs](/home/xenia/work/claudemx/src-tauri/src/commands/settings.rs)

## Exit Criteria

아래를 만족하면 안정화 대상으로 넘긴다.

- 여러 장시간 Claude 세션 동안 눈에 띄는 footer ghosting이 재현되지 않음
- snapshot 기준으로 visible buffer에 footer 파편 오염이 더 이상 보이지 않음
- 실험 플래그 없이도 유지할 최종 동작 범위를 정리할 수 있음
- 가능하면 재현 가능한 regression scenario를 E2E 또는 테스트 문서에 반영함
