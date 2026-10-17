//! Shared filesystem intent for versioned sandbox runners.
//!
//! This is a plan, not evidence of enforcement. Deny floors always override
//! grants, including runtime reads and private scratch. Windows deliberately
//! refuses plans with requested roots until a separate minifilter project
//! provides filesystem enforcement.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::protected::PROTECTED;
use crate::types::{SandboxError, SandboxPolicy};

/// Required v2 wire fields. Trees include descendants; writable files are
/// exact paths and never grant their parent directory. Denies take precedence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilesystemPlan {
    pub readable_trees: Vec<String>,
    pub writable_trees: Vec<String>,
    pub writable_files: Vec<String>,
    pub deny_read: Vec<String>,
    pub deny_write: Vec<String>,
    pub runtime_reads: Vec<String>,
    /// A host-owned per-run directory, never the shared OS temporary root.
    /// The caller creates it privately and keeps it alive for the entire run.
    pub private_scratch: String,
}

impl FilesystemPlan {
    /// Build from trusted host context, resolving existing ancestors (including
    /// Windows junctions) before attaching the non-existing write-target tail.
    /// No directories are created and no process is launched by this function.
    pub fn from_policy(
        policy: &SandboxPolicy,
        home: &Path,
        runtime_reads: &[PathBuf],
        private_scratch: &Path,
    ) -> Result<Self, SandboxError> {
        // forbidden_readable_roots is the dispatcher's declared-root admission
        // ceiling, not a global read-deny list: it includes OS temporary and
        // runtime directories needed by private scratch and loader reads.
        build_with(
            policy,
            home,
            runtime_reads,
            private_scratch,
            DenyFloors {
                write_only: &crate::protected::system_forbidden_roots(),
                read_write: &dirs::data_dir()
                    .map(|data| data.join("cognia"))
                    .into_iter()
                    .collect::<Vec<_>>(),
            },
            PathStyle::native(),
            &canonicalize_native,
        )
    }

    /// Keep the requested grant lists even when a deny covers every grant:
    /// otherwise a protected-only request could bypass fail-closed admission.
    pub fn has_roots(&self) -> bool {
        !self.readable_trees.is_empty()
            || !self.writable_trees.is_empty()
            || !self.writable_files.is_empty()
    }

    /// Evaluate canonical native paths; this expresses intent, not an OS
    /// access check. The caller must resolve the candidate before evaluation.
    pub fn allows_read(&self, canonical_path: &Path) -> bool {
        self.allows(canonical_path, PathStyle::native(), false)
    }

    /// As with reads, a deny wins even over an exact writable-file grant.
    pub fn allows_write(&self, canonical_path: &Path) -> bool {
        self.allows(canonical_path, PathStyle::native(), true)
    }

    fn allows(&self, path: &Path, style: PathStyle, write: bool) -> bool {
        let Ok(path) = style.normalize(path) else {
            return false;
        };
        let denies = if write {
            &self.deny_write
        } else {
            &self.deny_read
        };
        if denies.iter().any(|root| style.contains(root, &path)) {
            return false;
        }
        style.contains(&self.private_scratch, &path)
            || self
                .writable_trees
                .iter()
                .any(|root| style.contains(root, &path))
            || self.writable_files.iter().any(|file| file == &path)
            || (!write
                && self
                    .readable_trees
                    .iter()
                    .chain(&self.runtime_reads)
                    .any(|root| style.contains(root, &path)))
    }
}

/// Windows lexical semantics are explicit so the same vectors run on macOS.
/// Native construction additionally resolves symlinks/junctions through the OS.
#[derive(Clone, Copy)]
enum PathStyle {
    Posix,
    Windows,
}

impl PathStyle {
    fn native() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Posix
        }
    }

    fn normalize(self, path: &Path) -> Result<String, SandboxError> {
        let raw = path.to_str().ok_or_else(|| invalid("path is not UTF-8"))?;
        if raw.chars().any(char::is_control) {
            return Err(invalid("path contains a control character"));
        }
        let raw = match self {
            Self::Windows => raw.replace('\\', "/"),
            Self::Posix => raw.to_owned(),
        };
        // Canonical Windows paths commonly carry a verbatim prefix. Convert
        // only ordinary drive/UNC paths, never device namespaces.
        let raw = if matches!(self, Self::Windows) {
            let raw = raw.to_ascii_lowercase();
            if let Some(unc) = raw.strip_prefix("//?/unc/") {
                format!("//{unc}")
            } else {
                raw.strip_prefix("//?/").unwrap_or(&raw).to_owned()
            }
        } else {
            raw
        };
        if raw.split('/').any(|component| component == "..") {
            return Err(invalid("path contains a parent traversal"));
        }
        let (prefix, tail) = match self {
            Self::Posix if raw.starts_with('/') => ("/".to_owned(), &raw[1..]),
            Self::Windows
                if raw.as_bytes().get(1) == Some(&b':')
                    && raw.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                    && raw.as_bytes().get(2) == Some(&b'/') =>
            {
                (raw[..3].to_owned(), &raw[3..])
            }
            Self::Windows if raw.starts_with("//") => {
                let mut parts = raw[2..].splitn(3, '/');
                let server = parts.next().unwrap_or_default();
                let share = parts.next().unwrap_or_default();
                if server.is_empty() || share.is_empty() || server == "." || share == "." {
                    return Err(invalid("invalid UNC path"));
                }
                (
                    format!("//{server}/{share}/"),
                    parts.next().unwrap_or_default(),
                )
            }
            _ => return Err(invalid("path is not absolute")),
        };
        let components: Vec<_> = tail
            .split('/')
            .filter(|p| !p.is_empty() && *p != ".")
            .collect();
        if matches!(self, Self::Windows)
            && components
                .iter()
                .any(|part| part.contains(':') || part.ends_with([' ', '.']))
        {
            return Err(invalid("ambiguous Windows path or alternate data stream"));
        }
        Ok(format!("{prefix}{}", components.join("/")))
    }

    fn contains(self, root: &str, path: &str) -> bool {
        path == root
            || path
                .strip_prefix(root)
                .is_some_and(|tail| root.ends_with('/') || tail.starts_with('/'))
    }
}

fn invalid(reason: &str) -> SandboxError {
    SandboxError::InvalidPolicy {
        reason: format!("filesystem plan: {reason}"),
    }
}

fn canonicalize_native(path: &Path) -> Result<PathBuf, SandboxError> {
    // Reuse the existing validation contract; on Windows it is lexical only,
    // so explicitly resolve existing ancestors on every platform below.
    crate::paths::safe_canonicalize(path).map_err(|error| invalid(&error.to_string()))?;
    let mut ancestor = path;
    let mut tail = Vec::new();
    loop {
        match std::fs::canonicalize(ancestor) {
            Ok(mut resolved) => {
                for component in tail.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // A dangling link must not be mistaken for a not-yet-created
                // target, whose future resolution could escape the plan.
                if std::fs::symlink_metadata(ancestor).is_ok() {
                    return Err(invalid("path contains a dangling symlink"));
                }
                match (ancestor.parent(), ancestor.file_name()) {
                    (Some(parent), Some(name)) => {
                        tail.push(name);
                        ancestor = parent;
                    }
                    _ => return Err(invalid("path has no resolvable existing ancestor")),
                }
            }
            Err(error) => return Err(invalid(&format!("cannot canonicalize path: {error}"))),
        }
    }
}

/// Pure builder: resolution and platform semantics are injected, so tests do
/// not depend on the machine's drive letters, home, or installed toolchains.
struct DenyFloors<'a> {
    write_only: &'a [PathBuf],
    read_write: &'a [PathBuf],
}

fn build_with(
    policy: &SandboxPolicy,
    home: &Path,
    runtime_reads: &[PathBuf],
    private_scratch: &Path,
    floors: DenyFloors<'_>,
    style: PathStyle,
    resolve: &impl Fn(&Path) -> Result<PathBuf, SandboxError>,
) -> Result<FilesystemPlan, SandboxError> {
    let canonical = |path: &Path| {
        style.normalize(path)?;
        style.normalize(&resolve(path)?)
    };
    let list = |paths: &[PathBuf]| -> Result<Vec<String>, SandboxError> {
        paths
            .iter()
            .map(|path| canonical(path))
            .collect::<Result<BTreeSet<_>, _>>()
            .map(|paths| paths.into_iter().collect())
    };
    let (readable, writable, files) = match policy {
        SandboxPolicy::Bash {
            readable, writable, ..
        } => (readable.as_slice(), writable.as_slice(), &[][..]),
        SandboxPolicy::Edit {
            readable,
            target_files,
        }
        | SandboxPolicy::Write {
            readable,
            target_files,
        }
        | SandboxPolicy::TextEditor {
            readable,
            target_files,
        } => (readable.as_slice(), &[][..], target_files.as_slice()),
    };
    let mut plan = FilesystemPlan {
        readable_trees: list(readable)?,
        writable_trees: list(writable)?,
        writable_files: list(files)?,
        deny_read: list(floors.read_write)?,
        deny_write: list(floors.write_only)?,
        runtime_reads: list(runtime_reads)?,
        private_scratch: canonical(private_scratch)?,
    };
    plan.deny_write.extend(plan.deny_read.iter().cloned());
    let mut floor_roots = BTreeSet::from([canonical(home)?, plan.private_scratch.clone()]);
    // Include ancestors: requesting ~/.ssh directly, or an exact file inside
    // .git, must retain the same floor as requesting the containing home/repo.
    let file_parents: Vec<_> = plan
        .writable_files
        .iter()
        .filter_map(|path| {
            path.rsplit_once('/')
                .map(|(parent, _)| style.normalize(Path::new(&format!("{parent}/"))))
        })
        .collect::<Result<_, _>>()?;
    for path in plan
        .readable_trees
        .iter()
        .chain(&plan.writable_trees)
        .chain(&file_parents)
        .chain(&plan.runtime_reads)
    {
        let mut ancestor = path.as_str();
        loop {
            floor_roots.insert(ancestor.to_owned());
            let Some((parent, _)) = ancestor.rsplit_once('/') else {
                break;
            };
            if style.normalize(Path::new(parent)).is_err() {
                break;
            }
            ancestor = parent;
        }
    }
    for root in floor_roots {
        for entry in PROTECTED {
            let path = canonical(Path::new(&format!(
                "{}/{rel}",
                root.trim_end_matches('/'),
                rel = entry.rel
            )))?;
            if entry.secret {
                plan.deny_read.push(path.clone());
            }
            plan.deny_write.push(path);
        }
    }
    for paths in [&mut plan.deny_read, &mut plan.deny_write] {
        paths.sort();
        paths.dedup();
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::NetworkPolicy;

    fn bash(readable: &[&str], writable: &[&str]) -> SandboxPolicy {
        SandboxPolicy::Bash {
            readable: readable.iter().map(PathBuf::from).collect(),
            writable: writable.iter().map(PathBuf::from).collect(),
            network: NetworkPolicy::On,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        }
    }

    fn windows(policy: &SandboxPolicy) -> FilesystemPlan {
        build_with(
            policy,
            Path::new(r"C:\Users\me"),
            &[PathBuf::from(r"C:\Windows")],
            Path::new(r"C:\Temp\private-123"),
            DenyFloors {
                write_only: &[PathBuf::from(r"C:\Windows")],
                read_write: &[PathBuf::from(r"D:\AppData\cognia")],
            },
            PathStyle::Windows,
            &|path| Ok(path.to_path_buf()),
        )
        .unwrap()
    }

    #[test]
    fn filesystem_plan_windows_paths_deduplicate_and_keep_component_boundaries() {
        let plan = windows(&bash(
            &[r"C:\Work", "c:/work/./", r"\\server\share\repo"],
            &[r"C:\Work"],
        ));
        assert_eq!(plan.readable_trees, ["//server/share/repo", "c:/work"]);
        assert!(plan.allows(Path::new(r"c:\WORK\src\main.rs"), PathStyle::Windows, true));
        assert!(!plan.allows(Path::new(r"C:\Workspace\secret"), PathStyle::Windows, true));
        assert!(plan.allows(
            Path::new(r"C:\Windows\System32\kernel32.dll"),
            PathStyle::Windows,
            false
        ));
        assert!(!plan.allows(
            Path::new(r"C:\Windows\System32\kernel32.dll"),
            PathStyle::Windows,
            true
        ));
    }

    #[test]
    fn filesystem_plan_deny_floors_override_broad_and_explicit_grants() {
        let plan = windows(&bash(
            &[r"C:\Users\me", r"C:\Users\me\.ssh"],
            &[r"C:\Users\me"],
        ));
        assert!(!plan.allows(
            Path::new(r"C:\Users\me\.ssh\id_rsa"),
            PathStyle::Windows,
            false
        ));
        assert!(!plan.allows(
            Path::new(r"C:\Users\me\.git\hooks\pre-commit"),
            PathStyle::Windows,
            true
        ));
        assert!(plan.allows(
            Path::new(r"C:\Users\me\.git\config"),
            PathStyle::Windows,
            false
        ));
        assert!(plan.allows(Path::new(r"C:\Users\me\.env"), PathStyle::Windows, true));
        let denied_only = windows(&bash(&[r"C:\Users\me\.ssh"], &[]));
        assert!(denied_only.has_roots());
    }

    #[test]
    fn filesystem_plan_exact_files_never_grant_parents_or_siblings() {
        for policy in [
            SandboxPolicy::Edit {
                target_files: vec![PathBuf::from(r"C:\Work\a.txt")],
                readable: vec![],
            },
            SandboxPolicy::Write {
                target_files: vec![PathBuf::from(r"C:\Work\a.txt")],
                readable: vec![],
            },
            SandboxPolicy::TextEditor {
                target_files: vec![PathBuf::from(r"C:\Work\a.txt")],
                readable: vec![],
            },
        ] {
            let plan = windows(&policy);
            assert!(plan.writable_trees.is_empty());
            assert!(plan.allows(Path::new(r"C:\Work\a.txt"), PathStyle::Windows, true));
            for forbidden in [r"C:\Work", r"C:\Work\b.txt", r"C:\Work\a.txt\child"] {
                assert!(!plan.allows(Path::new(forbidden), PathStyle::Windows, true));
            }
        }
        let denied = windows(&SandboxPolicy::Edit {
            target_files: vec![PathBuf::from(r"C:\Work\.git\config")],
            readable: vec![],
        });
        assert!(denied.has_roots());
        assert!(!denied.allows(Path::new(r"C:\Work\.git\config"), PathStyle::Windows, true));
    }

    #[test]
    fn filesystem_plan_runtime_and_scratch_do_not_hide_requested_root_admission() {
        let plan = windows(&bash(&[], &[]));
        assert!(!plan.has_roots());
        assert!(plan.allows(
            Path::new(r"C:\Temp\private-123\out"),
            PathStyle::Windows,
            true
        ));
        assert!(!plan.allows(Path::new(r"C:\Temp\other\out"), PathStyle::Windows, true));
        assert!(!plan.allows(
            Path::new(r"C:\Temp\private-123\.ssh\key"),
            PathStyle::Windows,
            true
        ));
        assert!(!plan.allows(
            Path::new(r"C:\Temp\private-123\.ssh\key"),
            PathStyle::Windows,
            false
        ));
    }

    #[test]
    fn filesystem_plan_app_store_floor_applies_outside_home_and_overrides_grants() {
        let plan = windows(&bash(&[r"D:\AppData"], &[r"D:\AppData"]));
        for write in [false, true] {
            assert!(!plan.allows(
                Path::new(r"D:\AppData\cognia\secret-store.enc"),
                PathStyle::Windows,
                write
            ));
            assert!(plan.allows(
                Path::new(r"D:\AppData\other\file"),
                PathStyle::Windows,
                write
            ));
        }
        let plan = windows(&bash(&[], &[]));
        assert!(plan.deny_read.contains(&"d:/appdata/cognia".to_owned()));
        assert!(plan.deny_write.contains(&"d:/appdata/cognia".to_owned()));
    }

    #[test]
    fn filesystem_plan_wire_fields_are_required_and_unknown_fields_refused() {
        let value = serde_json::to_value(windows(&bash(&[], &[]))).unwrap();
        for field in value.as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<FilesystemPlan>(missing).is_err(),
                "{field}"
            );
        }
        let mut unknown = value.clone();
        unknown["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<FilesystemPlan>(unknown).is_err());
        assert!(serde_json::from_value::<FilesystemPlan>(value).is_ok());
    }

    #[test]
    fn filesystem_plan_windows_rejects_ambiguous_paths() {
        for path in [
            r"C:relative",
            r"\root-relative",
            r"C:\a\..\b",
            "C:/a\n",
            r"C:\a:stream",
            r"C:\a.\b",
            r"\\.\device",
        ] {
            assert!(
                PathStyle::Windows.normalize(Path::new(path)).is_err(),
                "{path}"
            );
        }
        assert_eq!(
            PathStyle::Windows
                .normalize(Path::new(r"\\?\C:\Work"))
                .unwrap(),
            "c:/work"
        );
        assert_eq!(
            PathStyle::Windows
                .normalize(Path::new(r"\\?\UNC\Server\Share\Work"))
                .unwrap(),
            "//server/share/work"
        );
    }

    #[cfg(unix)]
    #[test]
    fn filesystem_plan_native_resolves_symlinks_and_preserves_missing_file_tail() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().canonicalize().unwrap();
        std::fs::create_dir(real.join("workspace")).unwrap();
        std::fs::write(real.join("workspace/existing.txt"), "original").unwrap();
        std::os::unix::fs::symlink(real.join("workspace"), real.join("alias")).unwrap();
        let policy = SandboxPolicy::Write {
            target_files: vec![real.join("alias/new.txt"), real.join("alias/existing.txt")],
            readable: vec![real.join("alias"), real.join("workspace")],
        };
        let plan = FilesystemPlan::from_policy(&policy, &real, &[], &real.join("scratch")).unwrap();
        assert_eq!(
            plan.readable_trees,
            [real.join("workspace").to_str().unwrap()]
        );
        assert_eq!(
            plan.writable_files,
            [
                real.join("workspace/existing.txt").to_str().unwrap(),
                real.join("workspace/new.txt").to_str().unwrap()
            ]
        );
        assert!(!plan.allows_write(&real.join("workspace/other.txt")));
        std::os::unix::fs::symlink(real.join("missing"), real.join("dangling")).unwrap();
        assert!(
            FilesystemPlan::from_policy(&policy, &real, &[], &real.join("dangling/child")).is_err()
        );
    }
}
