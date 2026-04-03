use crate::app_env::state_root_dir;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedClipboardImage {
    pub host_path: String,
    pub wsl_path: String,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCacheStats {
    pub path: String,
    pub files: u64,
    pub bytes: u64,
}

fn image_cache_dir() -> Result<PathBuf, String> {
    Ok(state_root_dir()?.join("temp").join("image"))
}

fn accumulate_cache_stats(path: &Path) -> Result<(u64, u64), String> {
    if !path.exists() {
        return Ok((0, 0));
    }

    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![path.to_path_buf()];

    while let Some(current) = stack.pop() {
        let metadata = fs::metadata(&current)
            .map_err(|e| format!("Failed to read {}: {}", current.display(), e))?;

        if metadata.is_file() {
            files += 1;
            bytes += metadata.len();
            continue;
        }

        if metadata.is_dir() {
            for entry in fs::read_dir(&current)
                .map_err(|e| format!("Failed to read {}: {}", current.display(), e))?
            {
                let entry = entry.map_err(|e| e.to_string())?;
                stack.push(entry.path());
            }
        }
    }

    Ok((files, bytes))
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "png",
    }
}

fn next_timestamped_path(dir: &Path, extension: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    for suffix in 0..1000 {
        let filename = if suffix == 0 {
            format!("clcomx_{timestamp}.{extension}")
        } else {
            format!("clcomx_{timestamp}-{suffix}.{extension}")
        };
        let candidate = dir.join(filename);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Failed to allocate image cache filename".into())
}

fn convert_drive_path_to_wsl(path_str: &str) -> Option<String> {
    let bytes = path_str.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' {
        return None;
    }

    let drive = (bytes[0] as char).to_ascii_lowercase();
    let rest = path_str[2..].replace('\\', "/");
    Some(format!("/mnt/{drive}{rest}"))
}

fn convert_unc_wsl_path(path_str: &str, distro: &str) -> Option<Result<String, String>> {
    let normalized = path_str.replace('/', "\\");
    if !(normalized.starts_with("\\\\wsl.localhost\\") || normalized.starts_with("\\\\wsl$\\")) {
        return None;
    }

    let trimmed = normalized.trim_start_matches('\\');
    let mut parts = trimmed.split('\\');
    let _host = parts.next()?;
    let host_distro = parts.next()?;
    let rest = parts.collect::<Vec<_>>();

    if !host_distro.eq_ignore_ascii_case(distro) {
        return Some(Err(format!(
            "Image cache path belongs to WSL distro '{}' but current session uses '{}'",
            host_distro, distro
        )));
    }

    if rest.is_empty() {
        return Some(Ok("/".into()));
    }

    Some(Ok(format!("/{}", rest.join("/"))))
}

fn host_path_to_wsl(path: &Path, distro: &str) -> Result<String, String> {
    let path_str = path.to_string_lossy().to_string();

    if let Some(wsl_path) = convert_drive_path_to_wsl(&path_str) {
        return Ok(wsl_path);
    }

    if let Some(result) = convert_unc_wsl_path(&path_str, distro) {
        return result;
    }

    if path_str.starts_with('/') {
        return Ok(path_str.replace('\\', "/"));
    }

    Err(format!(
        "Failed to convert '{}' to a WSL path for '{}'",
        path.display(),
        distro
    ))
}

#[tauri::command]
pub fn save_clipboard_image(
    bytes: Vec<u8>,
    distro: String,
    mime_type: Option<String>,
) -> Result<SavedClipboardImage, String> {
    let cache_dir = image_cache_dir()?;
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create {}: {}", cache_dir.display(), e))?;

    let extension = extension_for_mime(mime_type.as_deref().unwrap_or("image/png"));
    let path = next_timestamped_path(&cache_dir, extension)?;

    fs::write(&path, &bytes).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Failed to resolve image filename")?
        .to_string();

    Ok(SavedClipboardImage {
        host_path: path.to_string_lossy().to_string(),
        wsl_path: host_path_to_wsl(&path, &distro)?,
        filename,
    })
}

#[tauri::command]
pub fn get_image_cache_stats() -> Result<ImageCacheStats, String> {
    let cache_dir = image_cache_dir()?;
    let (files, bytes) = accumulate_cache_stats(&cache_dir)?;

    Ok(ImageCacheStats {
        path: cache_dir.to_string_lossy().to_string(),
        files,
        bytes,
    })
}

#[tauri::command]
pub fn open_image_cache_folder() -> Result<String, String> {
    let cache_dir = image_cache_dir()?;
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create {}: {}", cache_dir.display(), e))?;

    Command::new("explorer.exe")
        .arg(&cache_dir)
        .spawn()
        .map_err(|e| format!("Failed to open {}: {}", cache_dir.display(), e))?;

    Ok(cache_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn clear_image_cache() -> Result<u32, String> {
    let cache_dir = image_cache_dir()?;
    if !cache_dir.exists() {
        return Ok(0);
    }

    let mut deleted = 0u32;
    for entry in fs::read_dir(&cache_dir)
        .map_err(|e| format!("Failed to read {}: {}", cache_dir.display(), e))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
        } else {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
        }
        deleted += 1;
    }

    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const EXAMPLE_DISTRO: &str = "ExampleDistro";
    const OTHER_DISTRO: &str = "OtherDistro";

    fn example_wsl_file() -> String {
        format!("/home/tester/{}/temp/image.png", env!("CARGO_PKG_NAME"))
    }

    fn example_unc_wsl_file() -> String {
        format!(
            r"\\wsl.localhost\{}\home\tester\{}\temp\image.png",
            EXAMPLE_DISTRO,
            env!("CARGO_PKG_NAME")
        )
    }

    #[test]
    fn converts_windows_drive_paths_to_wsl_paths() {
        assert_eq!(
            convert_drive_path_to_wsl(r"C:\Users\xenia\image.png").as_deref(),
            Some("/mnt/c/Users/xenia/image.png")
        );
    }

    #[test]
    fn converts_unc_wsl_paths_when_distro_matches() {
        let unc_path = example_unc_wsl_file();
        let expected_wsl_path = example_wsl_file();
        let result = convert_unc_wsl_path(&unc_path, EXAMPLE_DISTRO);

        assert!(matches!(
            result,
            Some(Ok(path)) if path == expected_wsl_path
        ));
    }

    #[test]
    fn rejects_unc_wsl_paths_for_other_distros() {
        let result = convert_unc_wsl_path(
            &format!(r"\\wsl.localhost\{}\home\tester\image.png", EXAMPLE_DISTRO),
            OTHER_DISTRO,
        );

        assert!(matches!(result, Some(Err(message)) if message.contains(EXAMPLE_DISTRO)));
    }

    #[test]
    fn preserves_unix_style_paths() {
        let wsl_path = example_wsl_file();
        let path = PathBuf::from(&wsl_path);
        let result = host_path_to_wsl(&path, EXAMPLE_DISTRO).unwrap();
        assert_eq!(result, wsl_path);
    }
}
