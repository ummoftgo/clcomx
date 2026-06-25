# Project Memory

These rules are project-level working defaults for future agent sessions.

## Team Mobilization

- If the user's intent is not realistically solvable as a simple direct task, recruit additional teammates first and run shared analysis, research, and design discussion before implementation.
- If the same symptom has been addressed 3 or more times without resolution, stop patching directly and automatically mobilize teammates.

## Repeat-Failure Protocol

When the repeat-failure threshold is hit:

1. Summarize the failed attempts and the observed symptoms.
2. Analyze likely root causes from the current code and architecture.
3. Investigate similar cases, prior art, or adjacent projects.
4. Discuss how those findings apply to this codebase before making more code changes.

Do not continue iterative patching until that review loop is complete.

## Build / Run Gate

- Treat `test build -> app launch` as the start of an explicit verification pass, not as a casual intermediate step.
- Do not launch the app for verification while any of these are still pending for the current step:
  - teammate analysis or design discussion that is still expected to affect the implementation,
  - documentation or architecture write-up that is part of the current change,
  - local cleanup needed to make the verification target unambiguous.
- If implementation is likely to continue after discussion or documentation, finish that work first and launch only once the current slice is actually ready for runtime verification.
- When multiple agents are involved, do not treat one finished code path as permission to launch early; wait until the shared conclusion and required follow-up edits are complete.
- Before reporting that the app has been launched, verify that the intended build command has fully completed and that the launch corresponds to the final artifact for the current slice.

## Review Guidelines

- When leaving review feedback, comments, findings, or inline code-review notes, write them in Korean by default.
- Keep review comments actionable: include the affected file or line, the observed issue, why it matters, and the recommended fix.
- Order review findings by severity when multiple issues are reported: Critical, High, Medium, Low, Info.
- Use English technical identifiers, API names, command names, and exact code symbols as written in the source when translating them would reduce precision.

## Coding Conventions

### File and directory layout

- Split code by domain/feature across directories and files. Do not write long, monolithic single files — one file should carry one clear responsibility. This favors long-term maintainability.
- Follow the existing layered split: frontend `features/<feature>/{view,controller,state,contracts,service}`; backend keeps thin command wrappers plus a `features/<x>/` module (for Tauri/Rust: `commands/<x>.rs` wrapper + `features/<x>/{mod,...}.rs`).
- If a single file exceeds ~2000 lines — even for one cohesive feature — review whether it can be split into subclasses, submodules, or pure functions. This is a review obligation, not a hard mandate: keep it whole if splitting would hurt cohesion, but state that you checked.

### Comments

- Write comments in Korean, report-style and plain; avoid unnecessary jargon/slang (판교어). Keep English for technical identifiers, API names, and code symbols.
- Give every class and function a language-appropriate doc-comment — PHP: PHPDoc; JS/TS: JSDoc; Rust: rustdoc (`///`) — stating the purpose in one line plus a brief note on each argument.
- Add a short one-line Korean comment on key or non-obvious logic (branching, algorithms, lifecycle/cleanup, framing, etc.).
- Avoid redundant or self-evident comments that merely restate the code.
