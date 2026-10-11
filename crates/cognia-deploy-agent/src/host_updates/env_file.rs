//! The one line of the Compose project's env file the agent owns.
//!
//! The server image is pinned where Compose already reads it from: the
//! `COGNIA_SERVER_IMAGE` variable in the project's env file. The agent
//! rewrites that line, and only that line, so an operator's own
//! `docker compose up` keeps running the version the agent installed instead
//! of falling back to a mutable tag. Every other byte of the file is left as
//! the operator wrote it.

use std::path::Path;

/// The variable the Compose files take the server image from.
pub const SERVER_IMAGE_VAR: &str = "COGNIA_SERVER_IMAGE";

/// The value `key` is assigned in `content`; the last assignment wins, as in
/// Compose. Quotes around the value are removed.
pub fn read_var(content: &str, key: &str) -> Option<String> {
    content
        .lines()
        .filter_map(|line| assignment(line, key))
        .next_back()
        .map(|value| unquote(value).to_owned())
}

/// `content` with `key` set to `value` (or removed when `None`). The last
/// assignment is rewritten in place and earlier ones are dropped, so exactly
/// one remains; a missing one is appended.
pub fn set_var(content: &str, key: &str, value: Option<&str>) -> String {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let last = lines
        .iter()
        .rposition(|line| assignment(line.trim_end_matches(['\n', '\r']), key).is_some());
    let mut out = String::with_capacity(content.len() + 64);
    for (index, line) in lines.iter().enumerate() {
        let body = line.trim_end_matches(['\n', '\r']);
        if assignment(body, key).is_none() {
            out.push_str(line);
            continue;
        }
        if Some(index) == last {
            if let Some(value) = value {
                out.push_str(&format!("{key}={value}"));
                out.push_str(&line[body.len()..]);
            }
        }
    }
    if last.is_none() {
        if let Some(value) = value {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&format!("{key}={value}\n"));
        }
    }
    out
}

fn assignment<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let line = line.trim_start();
    let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
    let rest = line.strip_prefix(key)?;
    let rest = rest.trim_start();
    rest.strip_prefix('=').map(str::trim)
}

fn unquote(value: &str) -> &str {
    for quote in ['"', '\''] {
        if let Some(inner) = value
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            return inner;
        }
    }
    value
}

/// Replace `path` with `content` atomically, keeping its owner and mode: the
/// file belongs to the operator, not to the agent.
pub fn write_preserving(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no directory", path.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    let existing = std::fs::metadata(path).ok();
    let temp = parent.join(format!(".{name}.cognia-host-updates.tmp"));
    std::fs::write(&temp, content).map_err(|error| format!("{}: {error}", temp.display()))?;
    #[cfg(unix)]
    if let Some(metadata) = &existing {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        let applied = std::fs::set_permissions(
            &temp,
            std::fs::Permissions::from_mode(metadata.mode() & 0o7777),
        )
        .and_then(|()| std::os::unix::fs::chown(&temp, Some(metadata.uid()), Some(metadata.gid())));
        if let Err(error) = applied {
            let _ = std::fs::remove_file(&temp);
            return Err(format!("{}: {error}", temp.display()));
        }
    }
    #[cfg(not(unix))]
    let _ = existing;
    std::fs::rename(&temp, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("{}: {error}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = SERVER_IMAGE_VAR;

    #[test]
    fn reads_the_last_assignment_like_compose() {
        let env = "# image\nCOGNIA_SERVER_IMAGE=a:1\nOTHER=x\nexport COGNIA_SERVER_IMAGE = \"b@sha256:2\"\n";
        assert_eq!(read_var(env, KEY).as_deref(), Some("b@sha256:2"));
        assert_eq!(read_var("COGNIA_SERVER_IMAGE_TAG=x\n", KEY), None);
        assert_eq!(read_var("", KEY), None);
    }

    #[test]
    fn rewrites_only_its_own_line() {
        let env = "A=1\r\n# keep me\nCOGNIA_SERVER_IMAGE=old\nB='two'\n";
        assert_eq!(
            set_var(env, KEY, Some("repo@sha256:new")),
            "A=1\r\n# keep me\nCOGNIA_SERVER_IMAGE=repo@sha256:new\nB='two'\n"
        );
        // Duplicates collapse onto the one Compose would read.
        assert_eq!(
            set_var(
                "COGNIA_SERVER_IMAGE=a\nX=1\nCOGNIA_SERVER_IMAGE=b\n",
                KEY,
                Some("c")
            ),
            "X=1\nCOGNIA_SERVER_IMAGE=c\n"
        );
        // Missing: appended, after a newline the file lacked.
        assert_eq!(
            set_var("A=1", KEY, Some("c")),
            "A=1\nCOGNIA_SERVER_IMAGE=c\n"
        );
        assert_eq!(set_var("", KEY, Some("c")), "COGNIA_SERVER_IMAGE=c\n");
        // Removing restores a file that never pinned it.
        assert_eq!(set_var("A=1\nCOGNIA_SERVER_IMAGE=c\n", KEY, None), "A=1\n");
        assert_eq!(set_var("A=1\n", KEY, None), "A=1\n");
    }

    #[test]
    fn a_rewrite_keeps_the_operators_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(".env");
        std::fs::write(&path, "A=1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        }
        write_preserving(&path, "A=2\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "A=2\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o640);
        }
        assert_eq!(
            std::fs::read_dir(tmp.path()).unwrap().count(),
            1,
            "no temp left"
        );
    }
}
