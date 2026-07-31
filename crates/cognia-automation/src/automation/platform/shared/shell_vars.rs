//! Parse `KEY=value` lines emitted by shell tools (`xdotool --shell`
//! prints `X=512\nY=384\nSCREEN=0\nWINDOW=70254593`). Lives in `shared`
//! so the parser unit-tests run on every platform even though the only
//! production consumer today is the Linux AT-SPI backend's
//! window-under-cursor pick.

/// Extract the value of `KEY=` from a block of `KEY=value` lines.
/// Returns `None` for a missing key or an empty value.
pub fn parse_shell_var(out: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    out.lines()
        .find_map(|l| l.strip_prefix(prefix.as_str()))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_shell_var_extracts_window_id() {
        let out = "X=512\nY=384\nSCREEN=0\nWINDOW=70254593\n";
        assert_eq!(parse_shell_var(out, "WINDOW").as_deref(), Some("70254593"));
        assert_eq!(parse_shell_var(out, "X").as_deref(), Some("512"));
        assert_eq!(parse_shell_var(out, "MISSING"), None);
    }

    #[test]
    fn parse_shell_var_ignores_empty_values_and_partial_keys() {
        let out = "WINDOW=\nWINDOWISH=9\n";
        assert_eq!(parse_shell_var(out, "WINDOW"), None);
        assert_eq!(parse_shell_var(out, "WINDOWISH").as_deref(), Some("9"));
    }
}
