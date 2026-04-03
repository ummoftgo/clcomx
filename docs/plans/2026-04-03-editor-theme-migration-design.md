# Editor Theme Integration And Theme Pack Migration

## Status
Accepted

## Context

The internal Monaco editor currently does not follow the app theme. The app already has:

- built-in terminal/app themes in `src/lib/themes/default-theme-pack.json`
- runtime theme merging in `src/lib/themes/index.ts`
- user theme overrides in `state root/theme.json`
- final CSS overrides in `state root/custom.css`

The current `theme.json` behavior writes a full copy of the bundled theme pack on first boot. That makes later built-in theme improvements hard to deliver because unchanged built-in themes become frozen in the user file.

At the same time, Monaco theming has a wider color surface than the current xterm-oriented palette. Many built-in themes already have matching VS Code or Vim/Neovim theme sources, so Monaco should not rely only on terminal-palette inference.

Separately, the internal editor save button should only be enabled when the active file is dirty.

## Goals

- Keep the existing xterm/app theme structure working without regressions.
- Add Monaco-specific theming without forcing all current themes to be rewritten at once.
- Preserve user theme overrides and migrate old theme files safely.
- Keep `custom.css` as the last CSS override layer for app chrome.
- Enable the editor save button only when the active file has unsaved changes.

## Non-Goals

- Full VS Code theme parity for every Monaco color token in one pass.
- Replacing `custom.css` with a theme-only system.
- Blocking `Ctrl+S` when the active file is clean.

## Decision

### 1. Theme file format moves to versioned overlay packs

`theme.json` will move from a full bundled copy to an overlay format.

- Root field: `formatVersion`
- Current target version: `2`
- `themes` contains only:
  - user-added themes
  - built-in theme overrides

Unchanged built-in themes are not stored in the file.

### 2. Existing theme entry structure stays compatible

Each theme entry keeps the current `theme` field for xterm/app palette data.

An optional `monaco` block is added:

```json
{
  "formatVersion": 2,
  "themes": [
    {
      "id": "dracula",
      "name": "Dracula",
      "dark": true,
      "extends": "dracula",
      "theme": {
        "background": "#282a36",
        "foreground": "#f8f8f2"
      },
      "monaco": {
        "source": "builtin-vscode",
        "colors": {},
        "rules": []
      }
    }
  ]
}
```

- `theme` remains the source for xterm and app runtime CSS variables.
- `monaco` becomes the source for Monaco colors and token rules when present.

### 3. Monaco source policy

Monaco theme data is derived using this priority:

1. official or author-maintained VS Code theme source
2. official or author-maintained Vim/Neovim theme source
3. manually curated community port
4. fallback generated from the terminal palette

Built-in themes are grouped into:

- `VS Code 우선`
  - dracula
  - catppuccin-mocha
  - catppuccin-frappe
  - catppuccin-latte
  - nord
  - tokyo-night-storm
  - tokyo-night-moon
  - tokyo-night-day
  - everforest-dark
  - everforest-light
  - ayu-dark
  - ayu-light
  - rose-pine
  - rose-pine-dawn
  - github-light
  - one-half-light
  - night-owl-light
  - noctis-lux
  - noctis-lilac
  - iceberg-light

- `Vim/Neovim 보조`
  - solarized-dark
  - solarized-light
  - gruvbox-dark
  - gruvbox-light
  - kanagawa
  - kanagawa-lotus
  - nightfox
  - dayfox
  - moonfly
  - nightfly
  - srcery
  - jellybeans
  - tomorrow
  - zenbones

- `수동 검수 대상`
  - monokai
  - one-dark
  - one-light
  - atom-one-light
  - gotham

### 4. CSS responsibility split stays explicit

Theme application order remains:

1. resolved theme pack
2. runtime theme CSS variables
3. `custom.css`

`custom.css` continues to own app-shell and editor-chrome overrides.

Monaco syntax colors are not driven by CSS. They come from:

- built-in Monaco theme presets
- user `theme.json.monaco` overrides
- fallback palette mapping when explicit Monaco data is absent

### 5. Theme file migration is automatic and non-destructive

When bootstrapping:

- no `formatVersion` means legacy v1
- legacy v1 is read in-memory and converted to v2 overlay form
- if persisted migration is needed:
  - create one backup: `theme.json.bak.<timestamp>`
  - write to a temp file first
  - rename atomically where possible
  - keep the original file if migration fails

Legacy migration rules:

- built-in theme entries identical to bundled defaults are dropped
- changed built-in entries become overrides
- custom user themes are preserved
- `monaco` is optional after migration

### 6. Save button UX

The save button becomes enabled only when:

- there is an active tab
- the tab is dirty
- the tab is not loading
- the tab is not currently saving

`Ctrl+S` behavior remains unchanged.

## Implementation Outline

### Frontend

- Extend theme types in `src/lib/themes/index.ts`
- Add Monaco theme registry/adapter under `src/lib/editor/`
- Update `src/lib/editor/monaco-host.ts` to:
  - define Monaco themes
  - set the active Monaco theme on editor creation
  - react to runtime theme changes
- Update `src/lib/components/InternalEditor.svelte` save button disabled state

### Backend

- Extend theme payloads in `src-tauri/src/commands/settings.rs`
- Replace first-run full-copy `theme.json` behavior with versioned overlay loading
- Add migration path from legacy theme packs to v2 overlays

### Tests

- theme pack normalization and merge tests
- legacy theme file migration tests
- Monaco theme adapter tests
- save button dirty-state UI tests

## Risks

- Some built-in themes may need manual Monaco tuning despite having upstream sources.
- User-authored `theme.json` files may contain partial or malformed overrides.
- Monaco color coverage will be incremental; first pass should target correctness and consistency over completeness.

## Consequences

### Positive

- Built-in theme improvements can ship without being frozen by first-run files.
- Monaco editor visuals become consistent with the app theme system.
- User theme overrides remain supported.
- Theme customization stays extensible.

### Negative

- Theme loading and migration logic becomes more complex.
- Monaco theming introduces a second theme surface that must be tested.

