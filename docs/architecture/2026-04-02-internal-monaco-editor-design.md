## Internal Monaco Editor

### Goal

- Add an internal editor to the app without embedding the full VS Code workbench.
- Keep the current terminal-first session model and open files inside the same session tab.
- Support opening files from terminal links and from an app-level quick-open flow.
- Preserve room for later explorer/LSP expansion without pulling that scope into v1.

### Decisions

1. The internal editor uses `monaco-editor`, not OpenVSCode Server or a separate embedded IDE.
2. The editor lives inside the existing session tab and switches the session body between `terminal` and `editor`.
3. External editors remain supported. Internal and external open flows coexist.
4. Quick open uses the session `workDir` as its default root. It does not track shell `pwd`.
5. v1 supports text files only.
6. v1 supports multiple open files per session.
7. v1 restores opened editor tabs, active file, and current `viewMode`, but not dirty buffers or undo history.

### Monaco Version Policy

- Use the latest stable `monaco-editor` version available at implementation start.
- As of `2026-04-02`, `npm view monaco-editor version` returned `0.55.1`.
- Re-check the registry immediately before dependency changes and use the newest stable result.

### UI Model

- Each session keeps a local editor state:
  - `viewMode: "terminal" | "editor"`
  - `editorRootDir: string`
  - `openEditorTabs: EditorTabRef[]`
  - `activeEditorPath: string | null`
  - `dirtyPaths: string[]`
- The session body renders either terminal or editor, never both at once.
- The current bottom action area is reused first for:
  - `Open File`
  - `Editor`
  - `Terminal`
- `Ctrl+P` opens quick open.
- `Ctrl+S` saves the active editor tab.

### Link And Open Behavior

- Terminal file link menu keeps external editor behavior and adds internal editor behavior.
- File link actions:
  - `파일 열기`
  - `내부 에디터로 열기`
  - `다른 에디터로 열기`
  - `경로 복사`
- `파일 열기` follows `settings.interface.fileOpenTarget`.
- If a directory is opened internally, the app opens quick open rooted at that directory.

### Settings And Public Contracts

- Add `settings.interface.fileOpenTarget: "internal" | "external"`.
- Keep existing:
  - `settings.interface.fileOpenMode`
  - `settings.interface.defaultEditorId`
- Add frontend/backend contracts for:
  - `search_session_files(sessionId, rootDir, query, limit)`
  - `read_session_file(sessionId, wslPath)`
  - `write_session_file(sessionId, wslPath, content, expectedMtimeMs)`

### Backend File Policy

- Search root:
  - default: session `workDir`
  - override: directory chosen from internal-open flow
- Include dotfiles.
- Exclude heavy/generated directories:
  - `.git`
  - `node_modules`
  - `target`
  - `dist`
  - `build`
  - `coverage`
  - `.next`
  - `.svelte-kit`
- Search ranking:
  1. basename exact match
  2. basename prefix match
  3. basename substring match
  4. relative path substring match
  5. shallower path
  6. shorter path
- Text files only.
- Reject binary files with a dedicated error.
- Reject text files larger than `2 MiB` with a dedicated error.
- Keep a backend in-memory search cache per `(sessionId, rootDir)`.
- Invalidate that cache after writes under the same root.

### Save And Conflict Policy

- Save is manual only in v1.
- Dirty warning is shown when closing a tab or closing the app with unsaved editor tabs.
- Dirty warning is not shown just because the user switches between terminal and editor.
- `write_session_file` uses optimistic concurrency with `expectedMtimeMs`.
- If the file changed on disk since read, return a conflict error instead of overwriting silently.

### Restore Policy

- Persist per-session editor snapshot in `WorkspaceTabSnapshot`:
  - `viewMode`
  - `editorRootDir`
  - `openEditorTabs`
  - `activeEditorPath`
- Do not persist:
  - unsaved content
  - undo stack
  - dirty flags

### Monaco Integration Notes

- Monaco is integrated directly inside the existing Svelte app webview.
- Add Vite worker configuration for Monaco workers.
- Use `file://` URIs for per-file Monaco models.
- v1 includes:
  - syntax highlighting
  - multi-file tabs
  - line/column reveal
  - dirty indicators
  - save
- v1 excludes:
  - explorer sidebar
  - LSP/diagnostics/definition
  - diff editor
  - binary/image preview

### Preview And Mocking

- Extend preview runtime with internal editor commands and mock file data.
- Add at least one editor-focused preview preset.
- Keep preview shell and real app shell behavior aligned for:
  - quick open
  - file tab strip
  - editor/terminal mode switch
  - dirty badge and close warning

### Team Execution

#### Implementation Teams

1. `Backend File/State`
   - file search/read/write commands
   - binary/size policy
   - workspace snapshot extensions
   - tests
2. `Frontend Monaco Shell`
   - Monaco dependency and worker setup
   - editor shell
   - file tabs
   - save flow
   - preview support
3. `App UX Integration`
   - terminal link menu integration
   - quick open modal
   - bottom action integration
   - session mode switching
   - dirty warnings

#### Execution Rules

- Do not request intermediate status updates from the implementation teams.
- Let each team finish its owned slice, then integrate.
- Run build/launch verification only after:
  - design doc saved
  - implementation integrated
  - review feedback applied
  - local state is unambiguous

### Review Process

#### Review Teams

1. `Frontend Quality`
   - Svelte state boundaries
   - Monaco lifecycle
   - preview parity
   - UX regressions
2. `Backend Correctness`
   - file path handling
   - cache correctness
   - persistence and restore behavior
   - concurrency behavior
3. `Security And Failure Modes`
   - root boundary enforcement
   - binary/large-file failure handling
   - overwrite/conflict behavior
   - destructive edge cases

#### Feedback Handling

- Always accept findings that risk:
  - data loss
  - invalid path resolution
  - broken save/restore behavior
  - missing coverage on critical flows
- Usually accept findings on maintainability, preview parity, or obvious test gaps.
- Reject only when the finding:
  - expands scope beyond approved v1
  - conflicts with explicit design decisions
  - is mostly stylistic without technical impact
- If a finding is rejected, document the reason and the later phase where it belongs.

### Required Verification

- `npm run test`
- `npx tsc --noEmit`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run build`
- After implementation and review are complete:
  - `bash scripts/build-dev.sh`

### Acceptance Scenarios

- Terminal file link opens inside the internal editor.
- Directory link opens quick open rooted at that directory.
- `Ctrl+P` opens files from the session root.
- Multiple files can be opened and switched inside one session.
- `Ctrl+S` saves the active file.
- Closing a tab or app with unsaved files shows a warning.
- Reopening the app restores opened editor tabs and active file for that session.
