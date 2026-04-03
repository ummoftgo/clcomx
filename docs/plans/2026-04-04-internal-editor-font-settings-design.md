## Summary

- Add a dedicated `editor` settings block for the internal Monaco editor.
- Seed editor font settings from terminal settings when the editor block is missing, then keep them independent afterward.
- Add a new `Internal Editor` settings section with primary font, fallback font, and font size controls.
- Apply editor font family and font size to Monaco at creation time and update them live through `editor.updateOptions(...)`.

## Goals

- Let users configure the internal editor font without affecting terminal font settings.
- Preserve compatibility for existing users who do not yet have an `editor` block in `settings.json`.
- Keep the current theme migration and terminal theme structure untouched.

## Approach

### Settings model

- Extend `Settings` with `editor.fontFamily`, `editor.fontFamilyFallback`, and `editor.fontSize`.
- Default values for fresh installs match the terminal defaults.
- Normalization and backend parsing treat a missing `editor` block as:
  - `editor.fontFamily = terminal.fontFamily`
  - `editor.fontFamilyFallback = terminal.fontFamilyFallback`
  - `editor.fontSize = terminal.fontSize`

### UI

- Add an `Internal Editor` entry to the settings navigation.
- Add a dedicated settings section component using the same `FontPicker` and range/number patterns already used by terminal settings.
- Keep the settings copy explicit that editor font settings are separate from terminal settings.

### Monaco integration

- Extend the Monaco host contract with presentation options for `fontFamily` and `fontSize`.
- Build the editor font stack from primary + fallback lists.
- Pass the initial options when creating Monaco and update them live with `editor.updateOptions(...)` when settings change.

### Compatibility and migration

- Existing terminal theme/theme pack behavior remains unchanged.
- Existing settings files gain implicit editor defaults through normalization and backend parsing rather than a destructive rewrite.
- Saved settings should persist explicit editor values once a user changes them.

## Testing

- Frontend:
  - settings normalization copies terminal values when `editor` is missing
  - `InternalEditor` passes initial font options to the Monaco host
  - changing editor settings updates Monaco host options live
- Backend:
  - parsing legacy settings without `editor` seeds values from terminal
  - explicit editor values override copied defaults

## Notes

- This slice only covers font family and font size.
- Save button behavior stays as already implemented: button enabled only when the active file is dirty.
