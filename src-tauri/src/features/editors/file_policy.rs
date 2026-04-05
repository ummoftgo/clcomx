use super::path_resolution::basename_for_path;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

pub(super) const MAX_SESSION_FILE_BYTES: u64 = 2 * 1024 * 1024;
const SEARCH_TEXT_SAMPLE_BYTES: u64 = 8 * 1024;

pub(super) fn ensure_text_file_policy_from_metadata(metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.len() > MAX_SESSION_FILE_BYTES {
        return Err("FileTooLarge".into());
    }

    Ok(())
}

pub(super) fn sniff_file_is_binary(path: &Path) -> Result<bool, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let mut buffer = [0u8; SEARCH_TEXT_SAMPLE_BYTES as usize];
    let read = file
        .read(&mut buffer)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    Ok(is_binary_bytes(&buffer[..read]))
}

pub(super) fn ensure_text_file_policy(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    ensure_text_file_policy_from_metadata(metadata)?;
    if sniff_file_is_binary(path)? {
        return Err("BinaryFile".into());
    }

    Ok(())
}

#[allow(dead_code)]
pub(super) fn is_likely_text_path(path: &str) -> bool {
    let basename = basename_for_path(path);
    if basename.eq_ignore_ascii_case("Dockerfile") {
        return true;
    }

    matches!(
        Path::new(&basename)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "json"
            | "rs"
            | "md"
            | "py"
            | "sh"
            | "svelte"
            | "toml"
            | "yml"
            | "yaml"
            | "html"
            | "css"
            | "scss"
            | "txt"
            | "lock"
            | "xml"
            | "svg"
    )
}

fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

pub(super) fn read_text_file_with_policy(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<(String, u64), String> {
    ensure_text_file_policy_from_metadata(metadata)?;
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read {}: {error}", path.display()))?;

    let size_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if is_binary_bytes(&bytes) {
        return Err("BinaryFile".into());
    }

    let content = String::from_utf8(bytes).map_err(|_| "BinaryFile".to_string())?;
    Ok((content, size_bytes))
}

pub(super) fn metadata_mtime_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

pub(super) fn infer_language_id(wsl_path: &str) -> String {
    let basename = basename_for_path(wsl_path);
    if basename.eq_ignore_ascii_case("Dockerfile") {
        return "dockerfile".into();
    }
    if basename.to_ascii_lowercase().ends_with(".blade.php") {
        return "php".into();
    }

    match Path::new(&basename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "ts" => "typescript".into(),
        "tsx" => "typescriptreact".into(),
        "js" => "javascript".into(),
        "jsx" => "javascriptreact".into(),
        "php" | "phtml" => "php".into(),
        "json" => "json".into(),
        "rs" => "rust".into(),
        "md" => "markdown".into(),
        "py" => "python".into(),
        "sh" => "shell".into(),
        "svelte" => "svelte".into(),
        "toml" => "toml".into(),
        "yml" | "yaml" => "yaml".into(),
        "html" => "html".into(),
        "css" => "css".into(),
        "scss" => "scss".into(),
        "txt" => "plaintext".into(),
        _ => "plaintext".into(),
    }
}

#[cfg(test)]
mod tests;
