//! File/directory path completion for the terminal autocomplete engine
//! (ADR-0039 phase 2).
//!
//! The renderer's path completion provider sends the session cwd plus the
//! path-ish token under the cursor; we resolve the directory part, list it,
//! prefix-filter, and return candidate entry names. All the interesting
//! logic lives in [`complete_paths_inner`] (pure, unit-tested); the Tauri
//! command is a thin wrapper.
//!
//! Notes:
//!   * `~`/`~/x` expands to the user home (`dirs::home_dir`).
//!   * Both `/` and `\` are accepted as separators in the fragment; the
//!     completed name keeps the entry's real on-disk casing.
//!   * Prefix matching is case-insensitive on Windows and macOS-style
//!     pragmatism everywhere else: exact-case matches sort first, then
//!     case-insensitive ones.
//!   * Hidden entries (dotfiles) only surface when the typed prefix itself
//!     starts with `.` or `show_hidden` is set.
//!   * The result is capped — completion needs "the first screenful",
//!     never the whole directory.

use serde::Serialize;

use std::path::{Path, PathBuf};

/// Hard ceiling regardless of the caller-requested limit.
const MAX_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathCandidate {
    /// Entry name with on-disk casing (no directory part, no separator).
    pub name: String,
    pub is_dir: bool,
}

/// Split a path-ish fragment into `(dir_part, name_prefix)` where
/// `dir_part` keeps its trailing separator (or is empty when the fragment
/// has no separator at all).
fn split_fragment(fragment: &str) -> (&str, &str) {
    match fragment.rfind(['/', '\\']) {
        Some(idx) => (&fragment[..=idx], &fragment[idx + 1..]),
        None => ("", fragment),
    }
}

/// Resolve the directory to list: absolute dir parts win, `~` expands to
/// home, everything else is cwd-relative.
fn resolve_dir(cwd: &str, dir_part: &str) -> PathBuf {
    if dir_part.is_empty() {
        return PathBuf::from(cwd);
    }
    let expanded: PathBuf =
        if dir_part == "~" || dir_part.starts_with("~/") || dir_part.starts_with("~\\") {
            match dirs::home_dir() {
                Some(home) => {
                    let rest = dir_part[1..].trim_start_matches(['/', '\\']);
                    if rest.is_empty() {
                        home
                    } else {
                        home.join(rest)
                    }
                }
                None => PathBuf::from(dir_part),
            }
        } else {
            PathBuf::from(dir_part)
        };
    if expanded.is_absolute() {
        expanded
    } else {
        Path::new(cwd).join(expanded)
    }
}

/// Pure core — list `cwd`-resolved `fragment` completions.
pub fn complete_paths_inner(
    cwd: &str,
    fragment: &str,
    show_hidden: bool,
    limit: usize,
) -> Result<Vec<PathCandidate>, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is required".into());
    }
    let limit = limit.clamp(1, MAX_LIMIT);
    let (dir_part, prefix) = split_fragment(fragment);
    let dir = resolve_dir(cwd, dir_part);

    let read =
        std::fs::read_dir(&dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;

    let include_hidden = show_hidden || prefix.starts_with('.');
    let prefix_lower = prefix.to_lowercase();

    let mut exact: Vec<PathCandidate> = Vec::new();
    let mut loose: Vec<PathCandidate> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        if !prefix.is_empty() {
            if name.starts_with(prefix) {
                // exact-case match
            } else if name.to_lowercase().starts_with(&prefix_lower) {
                // case-insensitive match — collected separately so exact
                // matches rank first on case-sensitive filesystems.
            } else {
                continue;
            }
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let candidate = PathCandidate { name, is_dir };
        if !prefix.is_empty() && candidate.name.starts_with(prefix) {
            exact.push(candidate);
        } else {
            loose.push(candidate);
        }
        if exact.len() + loose.len() >= MAX_LIMIT * 2 {
            break;
        }
    }

    // Dirs before files, then name, within each tier.
    let sort = |v: &mut Vec<PathCandidate>| {
        v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    };
    sort(&mut exact);
    sort(&mut loose);
    exact.extend(loose);
    exact.dedup_by(|a, b| a.name == b.name);
    exact.truncate(limit);
    Ok(exact)
}

/// Tauri command — see module docs. `limit` defaults to 50.
#[tauri::command]
pub fn terminal_complete_paths(
    cwd: String,
    fragment: String,
    show_hidden: Option<bool>,
    limit: Option<usize>,
) -> Result<Vec<PathCandidate>, String> {
    complete_paths_inner(
        &cwd,
        &fragment,
        show_hidden.unwrap_or(false),
        limit.unwrap_or(50),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "cognia-complete-test-{label}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("mk temp root");
            Self { root }
        }

        fn dir(&self, name: &str) -> &Self {
            fs::create_dir_all(self.root.join(name)).expect("mk dir");
            self
        }

        fn file(&self, name: &str) -> &Self {
            fs::write(self.root.join(name), b"x").expect("mk file");
            self
        }

        fn cwd(&self) -> String {
            self.root.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn lists_cwd_entries_dirs_first() {
        let t = TempTree::new("dirs-first");
        t.dir("src").file("readme.md").dir("docs");
        let out = complete_paths_inner(&t.cwd(), "", false, 50).expect("ok");
        let names: Vec<&str> = out.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["docs", "src", "readme.md"]);
        assert!(out[0].is_dir);
        assert!(!out[2].is_dir);
    }

    #[test]
    fn prefix_filters_and_keeps_disk_casing() {
        let t = TempTree::new("prefix");
        t.dir("Documents").dir("Downloads").file("notes.txt");
        let out = complete_paths_inner(&t.cwd(), "do", false, 50).expect("ok");
        let names: Vec<&str> = out.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["Documents", "Downloads"]);
    }

    #[test]
    fn exact_case_matches_rank_before_loose_ones() {
        let t = TempTree::new("case-rank");
        t.file("Makefile").file("makefile.bak");
        let out = complete_paths_inner(&t.cwd(), "make", false, 50).expect("ok");
        assert_eq!(out[0].name, "makefile.bak");
        let out2 = complete_paths_inner(&t.cwd(), "Make", false, 50).expect("ok");
        assert_eq!(out2[0].name, "Makefile");
    }

    #[test]
    fn descends_into_a_directory_fragment() {
        let t = TempTree::new("descend");
        t.dir("src");
        fs::write(t.root.join("src").join("main.rs"), b"x").expect("file");
        fs::create_dir_all(t.root.join("src").join("lib")).expect("dir");
        let out = complete_paths_inner(&t.cwd(), "src/ma", false, 50).expect("ok");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "main.rs");
        // Backslash separator works too.
        let out2 = complete_paths_inner(&t.cwd(), "src\\li", false, 50).expect("ok");
        assert_eq!(out2[0].name, "lib");
    }

    #[test]
    fn hidden_entries_gated_unless_prefix_is_dotted_or_flag_set() {
        let t = TempTree::new("hidden");
        t.dir(".git").file(".env").file("app.ts");
        let plain = complete_paths_inner(&t.cwd(), "", false, 50).expect("ok");
        assert_eq!(plain.len(), 1);
        assert_eq!(plain[0].name, "app.ts");
        let dotted = complete_paths_inner(&t.cwd(), ".", false, 50).expect("ok");
        assert_eq!(dotted.len(), 2);
        let flagged = complete_paths_inner(&t.cwd(), "", true, 50).expect("ok");
        assert_eq!(flagged.len(), 3);
    }

    #[test]
    fn absolute_dir_part_ignores_cwd() {
        let t = TempTree::new("absolute");
        t.dir("inner");
        fs::write(t.root.join("inner").join("a.txt"), b"x").expect("file");
        let abs_fragment = format!(
            "{}{}a",
            t.root.join("inner").display(),
            std::path::MAIN_SEPARATOR
        );
        let out = complete_paths_inner("/nonexistent-cwd", &abs_fragment, false, 50).expect("ok");
        assert_eq!(out[0].name, "a.txt");
    }

    #[test]
    fn tilde_expands_to_home() {
        let home = dirs::home_dir().expect("home dir in test env");
        let out = complete_paths_inner("/anywhere-irrelevant", "~/", false, 5);
        // Home always exists — listing it must succeed (content varies).
        assert!(
            out.is_ok(),
            "listing ~ failed: {out:?} (home={})",
            home.display()
        );
    }

    #[test]
    fn caps_results_to_limit() {
        let t = TempTree::new("cap");
        for i in 0..20 {
            t.file(&format!("f{i:02}.txt"));
        }
        let out = complete_paths_inner(&t.cwd(), "f", false, 5).expect("ok");
        assert_eq!(out.len(), 5);
    }

    #[test]
    fn errors_on_missing_dir_and_blank_cwd() {
        assert!(complete_paths_inner("", "x", false, 5).is_err());
        let t = TempTree::new("missing");
        assert!(complete_paths_inner(&t.cwd(), "no-such-dir/x", false, 5).is_err());
    }
}
