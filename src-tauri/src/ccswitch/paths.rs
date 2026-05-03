// Path resolution for CCSwitch's SQLite database.
//
// CCSwitch uses the same directory across all OSes: `~/.cc-switch/`. The
// database file inside it is `cc-switch.db`. CCSwitch supports redirecting
// this directory for cloud sync (Dropbox / OneDrive / iCloud / WebDAV) but
// the default is fixed and is what we resolve here. If a user has redirected
// it, they can still point cognia-next at the relocated DB by following the
// CCSwitch symlink convention (CCSwitch leaves a marker in the default path
// when redirected).

use std::path::PathBuf;

/// Resolve `~/.cc-switch/cc-switch.db`. Returns `None` only when we cannot
/// determine the user's home directory at all (extremely unlikely on a
/// supported desktop platform).
pub fn ccswitch_db_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cc-switch").join("cc-switch.db"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_path_lives_under_home() {
        let path = ccswitch_db_path().expect("home dir resolvable on test host");
        let home = dirs::home_dir().unwrap();
        assert!(path.starts_with(&home));
        assert!(path.ends_with("cc-switch.db"));
        // The intermediate directory is `.cc-switch` (note the leading dot).
        let parent = path.parent().unwrap();
        assert_eq!(parent.file_name().unwrap(), ".cc-switch");
    }
}
