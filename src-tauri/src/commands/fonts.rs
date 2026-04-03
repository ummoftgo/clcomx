#[cfg(windows)]
use std::collections::HashSet;

#[cfg(windows)]
use windows::{
    core::{BOOL, PCWSTR},
    Win32::{
        Globalization::GetUserDefaultLocaleName,
        Graphics::DirectWrite::{
            DWriteCreateFactory, IDWriteFactory, IDWriteLocalizedStrings,
            DWRITE_FACTORY_TYPE_SHARED,
        },
    },
};

#[tauri::command]
pub fn list_monospace_fonts() -> Result<Vec<String>, String> {
    query_system_fonts()
}

#[cfg(windows)]
fn query_system_fonts() -> Result<Vec<String>, String> {
    unsafe {
        let factory: IDWriteFactory =
            DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).map_err(|e| e.to_string())?;
        let mut collection = None;
        factory
            .GetSystemFontCollection(&mut collection, false)
            .map_err(|e| e.to_string())?;
        let collection =
            collection.ok_or_else(|| "Failed to access system font collection".to_string())?;
        let locale = get_preferred_locale_name();

        let mut seen = HashSet::new();
        let mut fonts = Vec::new();

        for index in 0..collection.GetFontFamilyCount() {
            let family = collection.GetFontFamily(index).map_err(|e| e.to_string())?;
            let family_names = family.GetFamilyNames().map_err(|e| e.to_string())?;

            let name = get_best_localized_string(&family_names, &locale)
                .or_else(|| get_best_localized_string(&family_names, "en-us"))
                .or_else(|| get_string_by_index(&family_names, 0))
                .ok_or_else(|| "Failed to read font family name".to_string())?;

            if !name.is_empty() && seen.insert(name.clone()) {
                fonts.push(name);
            }
        }

        fonts.sort_by_key(|name| name.to_lowercase());
        Ok(fonts)
    }
}

#[cfg(not(windows))]
fn query_system_fonts() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(windows)]
unsafe fn get_preferred_locale_name() -> String {
    let mut buffer = [0u16; 85];
    let length = GetUserDefaultLocaleName(&mut buffer);
    if length <= 0 {
        return "en-us".to_string();
    }

    String::from_utf16_lossy(&buffer[..(length as usize - 1)])
}

#[cfg(windows)]
unsafe fn get_best_localized_string(
    strings: &IDWriteLocalizedStrings,
    locale_name: &str,
) -> Option<String> {
    let mut index = 0;
    let mut exists = BOOL(0);
    let locale_wide = encode_wide(locale_name);

    strings
        .FindLocaleName(
            PCWSTR::from_raw(locale_wide.as_ptr()),
            &mut index,
            &mut exists,
        )
        .ok()?;

    if !exists.as_bool() {
        return None;
    }

    get_string_by_index(strings, index)
}

#[cfg(windows)]
unsafe fn get_string_by_index(strings: &IDWriteLocalizedStrings, index: u32) -> Option<String> {
    let length = strings.GetStringLength(index).ok()? as usize;
    let mut buffer = vec![0u16; length + 1];
    strings.GetString(index, &mut buffer).ok()?;

    Some(String::from_utf16_lossy(&buffer[..length]))
}

#[cfg(windows)]
fn encode_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
