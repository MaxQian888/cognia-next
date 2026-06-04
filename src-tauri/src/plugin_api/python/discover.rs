//! Python interpreter discovery for the plugin runtime.
//!
//! Resolution order: an explicit `pythonPath` from the manager config, then
//! the Windows `py -3` launcher, then `python3`, then `python`. Each
//! candidate is validated by actually running `--version` — PATH presence is
//! not trusted (Windows Store stubs exist on PATH but exit non-zero).
//!
//! "No interpreter found" is a normal outcome (`Ok(None)`), not an error:
//! the desktop runs without Python support and `plugin_python_runtime_info`
//! reports `available: false`.

use std::process::Command;

/// Minimum supported Python (matches the design spec).
const MIN_VERSION: (u32, u32, u32) = (3, 9, 0);

/// A validated interpreter invocation. `argv_prefix` is the full command
/// prefix (e.g. `["py", "-3"]` or `["python3"]`) the host spawn appends
/// `-u <host.py>` to.
#[derive(Debug, Clone)]
pub struct Interpreter {
    pub argv_prefix: Vec<String>,
    pub version: String,
}

/// Candidate command prefixes in resolution order.
fn candidates(explicit: Option<&str>) -> Vec<Vec<String>> {
    let mut list: Vec<Vec<String>> = Vec::new();
    if let Some(path) = explicit {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            list.push(vec![trimmed.to_string()]);
        }
    }
    #[cfg(windows)]
    list.push(vec!["py".into(), "-3".into()]);
    list.push(vec!["python3".into()]);
    list.push(vec!["python".into()]);
    list
}

/// Resolve a usable interpreter. `Ok(None)` means "no Python on this
/// machine" — callers must not treat that as an error.
pub fn discover_interpreter(explicit: Option<&str>) -> Option<Interpreter> {
    for argv_prefix in candidates(explicit) {
        if let Some(version) = probe_version(&argv_prefix) {
            if let Some(parsed) = parse_python_version(&version) {
                if meets_min(parsed) {
                    return Some(Interpreter {
                        argv_prefix,
                        version,
                    });
                }
                log::warn!(
                    "python discover: {} is {version}, below minimum {}.{}.{}",
                    argv_prefix.join(" "),
                    MIN_VERSION.0,
                    MIN_VERSION.1,
                    MIN_VERSION.2
                );
            }
        }
    }
    None
}

/// Run `<prefix> --version` and return the reported version string
/// (e.g. "3.12.4"). Old Pythons print to stderr; check both streams.
fn probe_version(argv_prefix: &[String]) -> Option<String> {
    let (program, args) = argv_prefix.split_first()?;
    let mut cmd = Command::new(program);
    cmd.args(args).arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    extract_version_token(&stdout).or_else(|| extract_version_token(&stderr))
}

/// Pull the "X.Y.Z" token out of a `Python X.Y.Z` banner line.
fn extract_version_token(banner: &str) -> Option<String> {
    let trimmed = banner.trim();
    let rest = trimmed.strip_prefix("Python ")?;
    let token = rest.split_whitespace().next()?;
    parse_python_version(token).map(|_| token.to_string())
}

fn parse_python_version(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    // Patch may carry suffixes like "0rc1" — take leading digits, default 0.
    let patch = parts
        .next()
        .map(|p| {
            let digits: String = p.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().unwrap_or(0)
        })
        .unwrap_or(0);
    Some((major, minor, patch))
}

fn meets_min(v: (u32, u32, u32)) -> bool {
    v >= MIN_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stdout_banner() {
        assert_eq!(extract_version_token("Python 3.12.4\n"), Some("3.12.4".into()));
    }

    #[test]
    fn parses_rc_suffix_banner() {
        assert_eq!(extract_version_token("Python 3.13.0rc1"), Some("3.13.0rc1".into()));
        assert_eq!(parse_python_version("3.13.0rc1"), Some((3, 13, 0)));
    }

    #[test]
    fn rejects_garbage_banner() {
        assert_eq!(extract_version_token("not a python banner"), None);
        assert_eq!(extract_version_token(""), None);
        assert_eq!(parse_python_version("abc"), None);
    }

    #[test]
    fn parses_two_part_version() {
        assert_eq!(parse_python_version("3.9"), Some((3, 9, 0)));
    }

    #[test]
    fn meets_min_boundary() {
        assert!(meets_min((3, 9, 0)));
        assert!(meets_min((3, 12, 1)));
        assert!(meets_min((4, 0, 0)));
        assert!(!meets_min((3, 8, 18)));
        assert!(!meets_min((2, 7, 18)));
    }

    #[test]
    fn explicit_path_is_first_candidate() {
        let list = candidates(Some("C:/custom/python.exe"));
        assert_eq!(list[0], vec!["C:/custom/python.exe".to_string()]);
    }

    #[test]
    fn blank_explicit_path_is_skipped() {
        let list = candidates(Some("   "));
        assert_ne!(list[0], vec!["   ".to_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_candidate_order_includes_py_launcher() {
        let list = candidates(None);
        assert_eq!(list[0], vec!["py".to_string(), "-3".to_string()]);
        assert_eq!(list[1], vec!["python3".to_string()]);
        assert_eq!(list[2], vec!["python".to_string()]);
    }

    #[test]
    fn bogus_explicit_path_does_not_panic() {
        // May still resolve via PATH fall-through on dev machines — only
        // assert it returns without panicking.
        let _ = discover_interpreter(Some("Z:/definitely/not/python.exe"));
    }

    #[test]
    fn probe_version_unknown_program_is_none() {
        assert_eq!(
            probe_version(&["cognia-definitely-not-a-real-binary".to_string()]),
            None
        );
    }
}
