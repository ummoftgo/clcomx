# Window Move Screen-State Authority

Date: 2026-03-29

## Status

Accepted and in progress.

## Decision

CLCOMX keeps app-restart restore unchanged and changes only runtime window moves.

- App restart: keep the current `new PTY + resume` model
- Runtime move: restore from a runtime-only canonical parsed screen-state owner
- Workspace persistence: never store runtime screen-state payloads
- Fallback: if canonical restore is unavailable, fall back to the current raw replay attach path

## Boundary

This architecture does not attempt to keep a live PTY alive across app restart.

On restart, the product still:

- restores saved window and tab structure
- creates new PTYs
- runs `claude --resume ...` or `codex resume ...`

The new behavior applies only while the app is already running and a session moves between windows.

## Problem

The current replay model restores stream history, not the exact current screen.

- Backend workspace ownership changes in [move_session_to_window()](/home/xenia/work/claudemx/src-tauri/src/commands/settings.rs#L1500)
- The target terminal then reattaches in [attachToExistingPty()](/home/xenia/work/claudemx/src/lib/components/Terminal.svelte#L1554)
- Raw replay comes from [pty_get_output_snapshot()](/home/xenia/work/claudemx/src-tauri/src/commands/pty.rs#L692)

That is adequate for plain shell output, but it is weak for Codex and other TUIs that redraw aggressively, clear regions, and position the cursor directly.

## Rejected Approaches

### 1. Raw PTY Replay

- Positive: simple and durable
- Negative: reproduces history, not the live screen
- Decision: keep only as fallback

### 2. Source Terminal Capture Handoff

- Positive: reuses xterm serialization without adding a new owner
- Negative: still depends on the currently visible source terminal
- Negative: creates handoff races around capture timing and source window state
- Negative: makes long-lived correctness depend on the same UI terminal that may soon unmount
- Decision: reject as the long-term model

### 3. Rust-Owned Terminal Emulator

- Positive: would give the backend a single canonical authority
- Negative: effectively creates a second terminal-state implementation outside xterm
- Negative: much larger scope and higher correctness risk
- Decision: reject for this product

## Chosen Architecture

Use a runtime-only canonical parsed screen-state owner hosted in the main frontend runtime.

The important distinction is:

- Rust remains authoritative for PTY lifecycle, workspace state, and raw output transport
- A hidden xterm-compatible runtime in the main window becomes authoritative for parsed terminal screen-state

This canonical owner is not the source terminal and not the target terminal. It is a separate runtime participant that continuously tracks PTY output and can produce a fresh serialized snapshot for any visible window.

## Why This Is Better

This separates concerns cleanly.

- Rust already owns PTYs well, but it does not parse terminal screen-state
- Visible terminals are views and interaction surfaces, but they are not a reliable long-term source of truth for handoff
- xterm serialization remains useful, but it should come from a dedicated owner instead of the terminal that happens to be visible at move time

This removes the coupling between:

- window move timing
- source terminal lifecycle
- target terminal lifecycle
- the canonical notion of "what the screen looks like right now"

## Runtime Components

### Backend PTY Authority

Rust continues to own:

- PTY spawn / write / resize / kill
- session-to-PTY mapping
- workspace persistence
- raw output log and bounded output-chunk journal

Relevant commands:

- [pty_get_runtime_snapshot()](/home/xenia/work/claudemx/src-tauri/src/commands/pty.rs#L712)
- [pty_get_output_delta_since()](/home/xenia/work/claudemx/src-tauri/src/commands/pty.rs#L771)

### Canonical Parsed Screen Authority

The main window hosts a hidden xterm instance per active PTY and keeps it updated from PTY output.

Implementation entry point:

- [installCanonicalScreenAuthority()](/home/xenia/work/claudemx/src/lib/terminal/canonical-screen-authority.ts)

Responsibilities:

- register active sessions and their PTYs
- seed hidden xterm state from backend runtime snapshot
- keep hidden xterm state current by consuming `pty-output`
- resize the PTY and hidden xterm when a target window asks for different `cols/rows`
- wait for redraw to settle
- serialize the current screen and append any delta produced after capture

### Visible Terminals

Visible `Terminal.svelte` instances remain normal views.

On attach to an existing PTY they now:

1. report the target terminal's actual `term.cols/rows`
2. request a canonical snapshot for that geometry
3. restore from serialized screen-state plus delta
4. fall back to raw replay only if canonical restore is unavailable

Current attach path:

- [attachToExistingPty()](/home/xenia/work/claudemx/src/lib/components/Terminal.svelte#L1554)

## Data Flow

### Normal Runtime

1. A visible terminal spawns or attaches to a PTY
2. It registers that session with the canonical authority
3. The canonical authority seeds or reuses its hidden xterm
4. Incoming `pty-output` updates both the visible terminal and the canonical authority

### Runtime Window Move

1. Workspace ownership moves as it does today
2. The target terminal mounts and computes its real `term.cols/rows`
3. The target requests a canonical snapshot for those dimensions
4. The canonical authority resizes the PTY if needed and waits for redraw quiet
5. The canonical authority serializes the hidden xterm and asks Rust for delta after the capture fence
6. The target terminal restores the serialized screen and applies the delta
7. Normal live PTY streaming continues

## Important Invariants

- The canonical parsed state is runtime-only
- `workspace.json` must never store serialized screen payloads
- The backend remains the source of truth for PTY existence and raw transport
- The canonical owner remains the source of truth for parsed live screen-state during runtime moves
- Target terminal geometry is authoritative for restore dimensions
- Raw replay remains available as a safety fallback

## Failure Handling

Fallback to raw replay is still required when:

- the main-window authority is unavailable
- canonical snapshot preparation throws
- delta history has already rolled out of the bounded journal
- a move occurs before the canonical owner has been able to seed or catch up

This is acceptable because fallback keeps the product usable while the canonical path matures.

## Consequences

### Positive

- removes dependency on source-terminal capture timing
- aligns the design with xterm-compatible screen-state ownership
- makes runtime move restore depend on target geometry, not guessed geometry
- provides a stable path for Codex and other redraw-heavy TUIs

### Negative

- adds a hidden xterm authority that consumes memory and CPU
- introduces another runtime participant to reason about
- still relies on bounded chunk retention for delta replay

### Risks

- if active PTYs are not registered early enough, the authority may need to lazy-seed from a truncated output log
- if the delta journal is too small, restore may fall back more often than desired
- if the main window authority is unavailable, secondary windows lose the fast-path

## Implementation Notes

The current implementation direction is:

- backend runtime snapshot + delta journal support in [pty.rs](/home/xenia/work/claudemx/src-tauri/src/commands/pty.rs)
- frontend wrappers in [pty.ts](/home/xenia/work/claudemx/src/lib/pty.ts)
- authority installation in [App.svelte](/home/xenia/work/claudemx/src/App.svelte)
- hidden canonical owner in [canonical-screen-authority.ts](/home/xenia/work/claudemx/src/lib/terminal/canonical-screen-authority.ts)
- target restore path in [Terminal.svelte](/home/xenia/work/claudemx/src/lib/components/Terminal.svelte)

## Validation

Minimum validation areas:

- Codex move between windows without prompt drift or broken redraw regions
- Claude move between windows without footer ghosting regressions
- long scrollback continuity after move
- runtime move while target uses DOM renderer
- runtime move while target uses WebGL renderer
- delta replay completeness under sustained output
- fallback behavior when delta history is incomplete

## Prior Art

- xterm.js README and serialize guidance point toward `xterm-headless` / serialize style reconnect flows rather than raw replay
- adjacent cases in xterm, Tauri, VS Code, and Tabby all show that replay-only restore and geometry guessing are brittle in multiwindow terminal scenarios

