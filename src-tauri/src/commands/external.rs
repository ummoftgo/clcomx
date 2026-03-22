use std::process::Command;

fn validate_external_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("URL is empty".into());
    }

    let parsed = url::Url::parse(trimmed).map_err(|error| format!("Invalid URL: {error}"))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "ftp") {
        return Err("Only http, https, and ftp URLs are supported".into());
    }

    if parsed.host_str().is_none() {
        return Err("URL host is missing".into());
    }

    Ok(trimmed.to_string())
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let validated = validate_external_url(&url)?;

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &validated])
            .spawn()
            .map_err(|error| format!("Failed to open URL: {error}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&validated)
            .spawn()
            .map_err(|error| format!("Failed to open URL: {error}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&validated)
            .spawn()
            .map_err(|error| format!("Failed to open URL: {error}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    #[test]
    fn accepts_supported_url_schemes() {
        assert_eq!(
            validate_external_url("https://example.com/path?q=1").unwrap(),
            "https://example.com/path?q=1"
        );
        assert_eq!(
            validate_external_url("http://example.com").unwrap(),
            "http://example.com"
        );
        assert_eq!(
            validate_external_url("ftp://example.com/files").unwrap(),
            "ftp://example.com/files"
        );
    }

    #[test]
    fn rejects_unsupported_or_invalid_urls() {
        assert!(validate_external_url("mailto:test@example.com").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("https://").is_err());
        assert!(validate_external_url("not-a-url").is_err());
    }
}
