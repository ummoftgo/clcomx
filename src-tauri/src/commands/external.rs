use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExternalUrlCommand {
    program: &'static str,
    args: Vec<String>,
}

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

fn external_url_command_for_target(
    target_os: &str,
    validated_url: &str,
) -> Result<ExternalUrlCommand, String> {
    match target_os {
        "windows" => Ok(ExternalUrlCommand {
            program: "rundll32.exe",
            args: vec![
                "url.dll,FileProtocolHandler".to_string(),
                validated_url.to_string(),
            ],
        }),
        "macos" => Ok(ExternalUrlCommand {
            program: "open",
            args: vec![validated_url.to_string()],
        }),
        "unix" => Ok(ExternalUrlCommand {
            program: "xdg-open",
            args: vec![validated_url.to_string()],
        }),
        _ => Err(format!("Unsupported URL opener target: {target_os}")),
    }
}

fn spawn_external_url_command(command: ExternalUrlCommand) -> Result<(), String> {
    Command::new(command.program)
        .args(&command.args)
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let validated = validate_external_url(&url)?;

    #[cfg(target_os = "windows")]
    {
        spawn_external_url_command(external_url_command_for_target("windows", &validated)?)?;
    }

    #[cfg(target_os = "macos")]
    {
        spawn_external_url_command(external_url_command_for_target("macos", &validated)?)?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        spawn_external_url_command(external_url_command_for_target("unix", &validated)?)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{external_url_command_for_target, validate_external_url};

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

    #[test]
    fn windows_opener_keeps_urls_out_of_cmd_shell_parsing() {
        let url = "https://example.test/path?x=1&echo=not-a-command";
        let command = external_url_command_for_target("windows", url).unwrap();

        assert_ne!(command.program, "cmd");
        assert!(!command.args.iter().any(|arg| arg == "/C"));
        assert!(command.args.iter().any(|arg| arg == url));
    }
}
