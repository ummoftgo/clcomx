use crate::app_env::{ensure_parent_dir, state_path};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const THEME_PACK_FORMAT_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MonacoThemeTokenRulePayload {
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_style: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MonacoThemePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherit: Option<bool>,
    pub colors: BTreeMap<String, String>,
    pub rules: Vec<MonacoThemeTokenRulePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeSourceEntryPayload {
    pub id: String,
    pub name: String,
    pub dark: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    pub theme: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monaco: Option<MonacoThemePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemePackPayload {
    #[serde(default = "default_theme_pack_format_version")]
    pub format_version: u32,
    pub themes: Vec<ThemeSourceEntryPayload>,
}

fn default_theme_pack_format_version() -> u32 {
    THEME_PACK_FORMAT_VERSION
}

pub(crate) fn load_theme_pack_or_default() -> ThemePackPayload {
    let bundled = bundled_theme_pack().unwrap_or_default();
    let path = match theme_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("Failed to resolve theme.json path: {error}");
            return bundled;
        }
    };

    if !path.exists() {
        if let Err(error) = ensure_parent_dir(&path) {
            eprintln!("Failed to prepare theme.json directory: {error}");
            return bundled;
        }

        let overlay = empty_overlay_theme_pack();
        if let Err(error) = write_theme_pack_file(&path, &overlay) {
            eprintln!("Failed to create {}: {error}", path.display());
        }

        return overlay;
    }

    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => {
            eprintln!("Failed to read {}: {error}", path.display());
            return bundled;
        }
    };

    let raw_value = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Invalid {}: {error}", path.display());
            return bundled;
        }
    };

    let format_version = raw_value
        .get("formatVersion")
        .and_then(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok());

    match serde_json::from_value::<ThemePackPayload>(raw_value.clone()) {
        Ok(pack) if format_version.unwrap_or_default() >= THEME_PACK_FORMAT_VERSION => {
            trim_theme_pack_for_storage(&pack)
        }
        Ok(legacy_pack) => {
            let migrated = migrate_legacy_theme_pack_to_overlay(legacy_pack, &bundled);
            if let Err(error) = backup_theme_pack_file(&path) {
                eprintln!("{error}");
            } else if let Err(error) = write_theme_pack_file(&path, &migrated) {
                eprintln!("Failed to migrate {}: {error}", path.display());
            }
            migrated
        }
        Err(error) => {
            eprintln!("Invalid {}: {error}", path.display());
            bundled
        }
    }
}

pub(crate) fn load_custom_css_or_default() -> Result<String, String> {
    let path = custom_css_path()?;
    if !path.exists() {
        return Ok(String::new());
    }

    fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {}", path.display(), error))
}

fn theme_path() -> Result<PathBuf, String> {
    state_path("theme.json")
}

fn custom_css_path() -> Result<PathBuf, String> {
    state_path("custom.css")
}

fn bundled_theme_pack() -> Result<ThemePackPayload, String> {
    let mut base_pack: ThemePackPayload = serde_json::from_str(include_str!(
        "../../../../src/lib/themes/default-theme-pack.json"
    ))
    .map_err(|error| format!("Invalid bundled theme pack: {error}"))?;
    let mut monaco_pack: ThemePackPayload = serde_json::from_str(include_str!(
        "../../../../src/lib/themes/default-monaco-pack.json"
    ))
    .map_err(|error| format!("Invalid bundled monaco theme pack: {error}"))?;
    if base_pack.format_version == 0 {
        base_pack.format_version = THEME_PACK_FORMAT_VERSION;
    }
    if monaco_pack.format_version == 0 {
        monaco_pack.format_version = THEME_PACK_FORMAT_VERSION;
    }
    Ok(merge_theme_pack_payloads(base_pack, monaco_pack))
}

fn empty_overlay_theme_pack() -> ThemePackPayload {
    ThemePackPayload {
        format_version: THEME_PACK_FORMAT_VERSION,
        themes: Vec::new(),
    }
}

fn merge_theme_pack_payloads(
    base: ThemePackPayload,
    overlay: ThemePackPayload,
) -> ThemePackPayload {
    ThemePackPayload {
        format_version: base.format_version.max(overlay.format_version),
        themes: base
            .themes
            .into_iter()
            .chain(overlay.themes.into_iter())
            .collect(),
    }
}

fn merge_monaco_theme_payloads(
    base: Option<&MonacoThemePayload>,
    overlay: Option<&MonacoThemePayload>,
) -> Option<MonacoThemePayload> {
    if base.is_none() && overlay.is_none() {
        return None;
    }

    let mut colors = base.map(|entry| entry.colors.clone()).unwrap_or_default();
    if let Some(overlay_entry) = overlay {
        colors.extend(overlay_entry.colors.clone());
    }

    let mut rules = base.map(|entry| entry.rules.clone()).unwrap_or_default();
    if let Some(overlay_entry) = overlay {
        rules.extend(overlay_entry.rules.clone());
    }

    Some(MonacoThemePayload {
        source: overlay
            .and_then(|entry| entry.source.clone())
            .or_else(|| base.and_then(|entry| entry.source.clone())),
        base: overlay
            .and_then(|entry| entry.base.clone())
            .or_else(|| base.and_then(|entry| entry.base.clone())),
        inherit: overlay
            .and_then(|entry| entry.inherit)
            .or_else(|| base.and_then(|entry| entry.inherit)),
        colors,
        rules,
    })
}

fn resolve_theme_pack_payload(
    pack: &ThemePackPayload,
) -> BTreeMap<String, ThemeSourceEntryPayload> {
    let mut resolved: BTreeMap<String, ThemeSourceEntryPayload> = BTreeMap::new();

    for source_theme in &pack.themes {
        let base_theme = source_theme.extends.as_ref().and_then(|extends| {
            if extends.as_str() == source_theme.id {
                resolved.get(source_theme.id.as_str())
            } else {
                resolved.get(extends.as_str())
            }
        });

        let mut theme = base_theme
            .map(|theme| theme.theme.clone())
            .unwrap_or_default();
        theme.extend(source_theme.theme.clone());

        let monaco = merge_monaco_theme_payloads(
            base_theme.and_then(|theme| theme.monaco.as_ref()),
            source_theme.monaco.as_ref(),
        );

        resolved.insert(
            source_theme.id.clone(),
            ThemeSourceEntryPayload {
                id: source_theme.id.clone(),
                name: source_theme.name.clone(),
                dark: source_theme.dark,
                extends: source_theme
                    .extends
                    .as_ref()
                    .filter(|extends| extends.as_str() != source_theme.id)
                    .cloned(),
                theme,
                monaco,
            },
        );
    }

    resolved
}

fn trim_theme_pack_for_storage(pack: &ThemePackPayload) -> ThemePackPayload {
    ThemePackPayload {
        format_version: THEME_PACK_FORMAT_VERSION,
        themes: pack
            .themes
            .iter()
            .filter(|theme| !theme.id.trim().is_empty() && !theme.name.trim().is_empty())
            .cloned()
            .collect(),
    }
}

fn theme_entry_theme_diff(
    current: &BTreeMap<String, String>,
    bundled: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    current
        .iter()
        .filter_map(|(key, value)| {
            if bundled.get(key) == Some(value) {
                None
            } else {
                Some((key.clone(), value.clone()))
            }
        })
        .collect()
}

fn migrate_legacy_theme_pack_to_overlay(
    legacy: ThemePackPayload,
    bundled: &ThemePackPayload,
) -> ThemePackPayload {
    let bundled_by_id = resolve_theme_pack_payload(bundled);

    let mut overlay = empty_overlay_theme_pack();

    for legacy_theme in legacy.themes {
        let Some(bundled_theme) = bundled_by_id.get(legacy_theme.id.as_str()) else {
            overlay.themes.push(legacy_theme);
            continue;
        };

        if bundled_theme.id == legacy_theme.id
            && bundled_theme.name == legacy_theme.name
            && bundled_theme.dark == legacy_theme.dark
            && bundled_theme.extends == legacy_theme.extends
            && bundled_theme.theme == legacy_theme.theme
            && bundled_theme.monaco == legacy_theme.monaco
        {
            continue;
        }

        let theme_diff = theme_entry_theme_diff(&legacy_theme.theme, &bundled_theme.theme);
        let monaco_override = if bundled_theme.monaco == legacy_theme.monaco {
            None
        } else if legacy_theme.monaco.is_none() && bundled_theme.monaco.is_some() {
            None
        } else {
            legacy_theme.monaco.clone()
        };

        let normalized_legacy_extends = legacy_theme
            .extends
            .as_deref()
            .filter(|extends| *extends != legacy_theme.id.as_str());
        let normalized_bundled_extends = bundled_theme
            .extends
            .as_deref()
            .filter(|extends| *extends != legacy_theme.id.as_str());

        let has_metadata_override = legacy_theme.name != bundled_theme.name
            || legacy_theme.dark != bundled_theme.dark
            || normalized_legacy_extends != normalized_bundled_extends;

        if theme_diff.is_empty() && monaco_override.is_none() && !has_metadata_override {
            continue;
        }

        overlay.themes.push(ThemeSourceEntryPayload {
            id: legacy_theme.id.clone(),
            name: legacy_theme.name,
            dark: legacy_theme.dark,
            extends: Some(legacy_theme.id),
            theme: theme_diff,
            monaco: monaco_override,
        });
    }

    trim_theme_pack_for_storage(&overlay)
}

fn write_theme_pack_file(path: &PathBuf, pack: &ThemePackPayload) -> Result<(), String> {
    let normalized = trim_theme_pack_for_storage(pack);
    let serialized = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("Failed to serialize theme pack: {error}"))?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", temp_path.display()))?;
    fs::rename(&temp_path, path)
        .map_err(|error| format!("Failed to replace {}: {error}", path.display()))?;
    Ok(())
}

fn backup_theme_pack_file(path: &PathBuf) -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let backup_path = path.with_file_name(format!("theme.json.bak.{timestamp}"));
    fs::copy(path, &backup_path).map_err(|error| {
        format!(
            "Failed to create theme backup {}: {error}",
            backup_path.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    const STATE_DIR_ENV: &str = "CLCOMX_STATE_DIR";

    fn env_lock() -> &'static Mutex<()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "clcomx-theme-tests-{}-{}-{}",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn bundled_theme_pack_defaults_to_current_format_version() {
        let bundled = bundled_theme_pack().unwrap();
        assert_eq!(bundled.format_version, THEME_PACK_FORMAT_VERSION);
        assert!(!bundled.themes.is_empty());
    }

    #[test]
    fn merge_theme_pack_payloads_keeps_overlay_entries_after_base_entries() {
        let merged = merge_theme_pack_payloads(
            ThemePackPayload {
                format_version: 1,
                themes: vec![ThemeSourceEntryPayload {
                    id: "base".into(),
                    name: "Base".into(),
                    dark: true,
                    extends: None,
                    theme: BTreeMap::from([("background".into(), "#111111".into())]),
                    monaco: None,
                }],
            },
            ThemePackPayload {
                format_version: 2,
                themes: vec![ThemeSourceEntryPayload {
                    id: "base".into(),
                    name: "Base Monaco".into(),
                    dark: true,
                    extends: Some("base".into()),
                    theme: BTreeMap::new(),
                    monaco: Some(MonacoThemePayload {
                        source: Some("builtin-vscode".into()),
                        base: Some("vs-dark".into()),
                        inherit: Some(true),
                        colors: BTreeMap::from([("editor.background".into(), "#111111".into())]),
                        rules: vec![],
                    }),
                }],
            },
        );

        assert_eq!(merged.format_version, 2);
        assert_eq!(merged.themes.len(), 2);
        assert_eq!(merged.themes[0].id, "base");
        assert_eq!(merged.themes[1].extends.as_deref(), Some("base"));
        assert_eq!(
            merged.themes[1]
                .monaco
                .as_ref()
                .and_then(|monaco| monaco.colors.get("editor.background")),
            Some(&"#111111".to_string())
        );
    }

    #[test]
    fn migrate_legacy_theme_pack_drops_unchanged_builtin_entries() {
        let bundled = bundled_theme_pack().unwrap();
        let legacy: ThemePackPayload = serde_json::from_str(include_str!(
            "../../../../src/lib/themes/default-theme-pack.json"
        ))
        .unwrap();
        let migrated = migrate_legacy_theme_pack_to_overlay(legacy, &bundled);

        assert_eq!(migrated.format_version, THEME_PACK_FORMAT_VERSION);
        assert!(migrated.themes.is_empty());
    }

    #[test]
    fn migrate_legacy_theme_pack_keeps_builtin_overrides_as_overlay_entries() {
        let bundled = bundled_theme_pack().unwrap();
        let mut legacy = bundled.clone();
        let dracula = legacy
            .themes
            .iter_mut()
            .find(|theme| theme.id == "dracula")
            .unwrap();
        dracula.theme.insert("background".into(), "#101820".into());

        let migrated = migrate_legacy_theme_pack_to_overlay(legacy, &bundled);
        let override_theme = migrated
            .themes
            .iter()
            .find(|theme| theme.id == "dracula")
            .unwrap();

        assert_eq!(migrated.format_version, THEME_PACK_FORMAT_VERSION);
        assert_eq!(override_theme.extends.as_deref(), Some("dracula"));
        assert_eq!(
            override_theme.theme.get("background"),
            Some(&"#101820".to_string())
        );
        assert_eq!(override_theme.theme.len(), 1);
    }

    #[test]
    fn migrate_legacy_theme_pack_preserves_custom_themes() {
        let bundled = bundled_theme_pack().unwrap();
        let mut legacy = bundled.clone();
        legacy.themes.push(ThemeSourceEntryPayload {
            id: "custom-night".into(),
            name: "Custom Night".into(),
            dark: true,
            extends: None,
            theme: BTreeMap::from([
                ("background".into(), "#111111".into()),
                ("foreground".into(), "#eeeeee".into()),
            ]),
            monaco: None,
        });

        let migrated = migrate_legacy_theme_pack_to_overlay(legacy, &bundled);
        let custom_theme = migrated
            .themes
            .iter()
            .find(|theme| theme.id == "custom-night")
            .unwrap();

        assert_eq!(custom_theme.extends, None);
        assert_eq!(
            custom_theme.theme.get("background"),
            Some(&"#111111".to_string())
        );
    }

    #[test]
    fn migrate_legacy_theme_pack_keeps_monaco_override_for_builtin_theme() {
        let bundled = bundled_theme_pack().unwrap();
        let mut legacy = bundled.clone();
        let dracula = legacy
            .themes
            .iter_mut()
            .find(|theme| theme.id == "dracula")
            .unwrap();
        dracula.monaco = Some(MonacoThemePayload {
            source: Some("test".into()),
            base: Some("vs-dark".into()),
            inherit: Some(true),
            colors: BTreeMap::from([("editor.background".into(), "#101820".into())]),
            rules: vec![MonacoThemeTokenRulePayload {
                token: "keyword".into(),
                foreground: Some("ff79c6".into()),
                background: None,
                font_style: None,
            }],
        });

        let migrated = migrate_legacy_theme_pack_to_overlay(legacy, &bundled);
        let override_theme = migrated
            .themes
            .iter()
            .find(|theme| theme.id == "dracula")
            .unwrap();

        assert_eq!(override_theme.extends.as_deref(), Some("dracula"));
        assert!(override_theme.theme.is_empty());
        assert_eq!(
            override_theme
                .monaco
                .as_ref()
                .and_then(|monaco| monaco.colors.get("editor.background")),
            Some(&"#101820".to_string())
        );
    }

    #[test]
    fn load_custom_css_returns_empty_string_when_file_is_missing() {
        let _guard = env_lock().lock().unwrap();
        let state_dir = unique_test_dir("missing-custom-css");
        let _ = fs::create_dir_all(&state_dir);
        let previous = std::env::var(STATE_DIR_ENV).ok();
        std::env::set_var(STATE_DIR_ENV, &state_dir);

        let result = load_custom_css_or_default();

        if let Some(value) = previous {
            std::env::set_var(STATE_DIR_ENV, value);
        } else {
            std::env::remove_var(STATE_DIR_ENV);
        }
        let _ = fs::remove_dir_all(&state_dir);

        assert_eq!(result.unwrap(), "");
    }
}
