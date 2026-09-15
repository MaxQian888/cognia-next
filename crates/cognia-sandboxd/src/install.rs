//! `install`: stage bundle trees into the injection volume (ADR-0183).
//!
//! Two stages, because the libc tree can only be chosen after the user image
//! has been probed:
//!
//! - `core` — the manifest, the static tools, the libc-independent vendor
//!   binaries and the CA bundle.
//! - `libc` — the `glibc/` or `musl/` tree the probe asked for.
//!
//! Each stage copies into a staging name and renames into place, then records
//! the manifest digest in a marker. A rerun of the same bundle (a restarted
//! init container, a reused Docker volume) finds the marker and does nothing;
//! a different bundle replaces the tree.
//!
//! What gets copied is checked, not trusted to the bundle build: symlinks must
//! be relative and stay inside their tree (an absolute link would point into
//! the user image once relocated to `/cognia`), set-id bits are dropped, and
//! device files, sockets and FIFOs are refused.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::layout::{Libc, BIN_DIR, CERTS_DIR, COMMON_DIR, MANIFEST_FILE};
use crate::manifest::{BundleManifest, ManifestError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Core,
    Libc(Libc),
}

impl Stage {
    fn marker_name(self) -> String {
        match self {
            Stage::Core => ".cognia-stage-core".into(),
            Stage::Libc(libc) => format!(".cognia-stage-{libc}"),
        }
    }

    /// Top-level entries this stage owns, and whether each must exist.
    fn entries(self) -> Vec<(&'static str, bool)> {
        match self {
            Stage::Core => vec![
                (MANIFEST_FILE, true),
                (BIN_DIR, true),
                (COMMON_DIR, true),
                (CERTS_DIR, true),
            ],
            Stage::Libc(libc) => vec![(libc.as_str(), true)],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed { release_tag: String },
    AlreadyCurrent { release_tag: String },
}

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error("the bundle has no {0}")]
    MissingEntry(String),
    #[error("{path}: {reason}")]
    Refused { path: String, reason: String },
    #[error("{path}: {source}")]
    Io { path: String, source: io::Error },
}

fn io_error(path: &Path) -> impl FnOnce(io::Error) -> InstallError + '_ {
    move |source| InstallError::Io {
        path: path.display().to_string(),
        source,
    }
}

/// Copies `stage` from the bundle tree at `from` into the injection root `to`.
pub fn install(from: &Path, to: &Path, stage: Stage) -> Result<InstallOutcome, InstallError> {
    let manifest_path = from.join(MANIFEST_FILE);
    let manifest_bytes = fs::read(&manifest_path).map_err(io_error(&manifest_path))?;
    let manifest = BundleManifest::parse(&manifest_bytes)?;
    let digest = hex::encode(Sha256::digest(&manifest_bytes));

    if let Stage::Libc(libc) = stage {
        if !manifest.runtimes.is_empty()
            && !manifest
                .runtimes
                .iter()
                .any(|runtime| runtime.libc.contains(&libc))
        {
            return Err(InstallError::Refused {
                path: libc.to_string(),
                reason: "the bundle builds no runtime for this libc".into(),
            });
        }
    }

    fs::create_dir_all(to).map_err(io_error(to))?;
    let marker = to.join(stage.marker_name());
    if fs::read_to_string(&marker).is_ok_and(|recorded| recorded.trim() == digest) {
        return Ok(InstallOutcome::AlreadyCurrent {
            release_tag: manifest.release_tag,
        });
    }
    // A half-finished earlier attempt must not look current if we fail below.
    match fs::remove_file(&marker) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(&marker)(error)),
    }

    for (entry, required) in stage.entries() {
        let source = from.join(entry);
        match fs::symlink_metadata(&source) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if required {
                    return Err(InstallError::MissingEntry(entry.to_string()));
                }
                continue;
            }
            Err(error) => return Err(io_error(&source)(error)),
        }
        let staging = to.join(format!(".staging-{entry}-{}", std::process::id()));
        remove_any(&staging)?;
        if let Err(error) = copy_tree(&source, &staging, &source) {
            let _ = remove_any(&staging);
            return Err(error);
        }
        let destination = to.join(entry);
        remove_any(&destination)?;
        fs::rename(&staging, &destination).map_err(io_error(&destination))?;
    }

    let marker_tmp = to.join(format!("{}.tmp", stage.marker_name()));
    fs::write(&marker_tmp, format!("{digest}\n")).map_err(io_error(&marker_tmp))?;
    fs::rename(&marker_tmp, &marker).map_err(io_error(&marker))?;
    Ok(InstallOutcome::Installed {
        release_tag: manifest.release_tag,
    })
}

fn remove_any(path: &Path) -> Result<(), InstallError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path).map_err(io_error(path)),
        Ok(_) => fs::remove_file(path).map_err(io_error(path)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(path)(error)),
    }
}

/// Copies `source` to `destination`; `tree_root` bounds where symlinks may point.
fn copy_tree(source: &Path, destination: &Path, tree_root: &Path) -> Result<(), InstallError> {
    let metadata = fs::symlink_metadata(source).map_err(io_error(source))?;
    let file_type = metadata.file_type();

    if file_type.is_symlink() {
        let target = fs::read_link(source).map_err(io_error(source))?;
        check_link(source, &target, tree_root)?;
        return make_symlink(&target, destination);
    }
    if file_type.is_dir() {
        fs::create_dir(destination).map_err(io_error(destination))?;
        let mut children: Vec<PathBuf> = fs::read_dir(source)
            .map_err(io_error(source))?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<_, _>>()
            .map_err(io_error(source))?;
        children.sort();
        for child in children {
            let name = child.file_name().expect("read_dir entries have names");
            copy_tree(&child, &destination.join(name), tree_root)?;
        }
        set_mode(destination, &metadata)?;
        return Ok(());
    }
    if file_type.is_file() {
        fs::copy(source, destination).map_err(io_error(destination))?;
        set_mode(destination, &metadata)?;
        return Ok(());
    }
    Err(InstallError::Refused {
        path: source.display().to_string(),
        reason: "only files, directories and symlinks can be installed".into(),
    })
}

/// A link must be relative and, resolved lexically from its own directory,
/// stay inside the stage tree.
fn check_link(link: &Path, target: &Path, tree_root: &Path) -> Result<(), InstallError> {
    let refuse = |reason: &str| InstallError::Refused {
        path: link.display().to_string(),
        reason: reason.into(),
    };
    if target.is_absolute() {
        return Err(refuse(
            "absolute symlinks break once the bundle is relocated",
        ));
    }
    let relative_dir = link
        .parent()
        .and_then(|parent| parent.strip_prefix(tree_root).ok())
        .unwrap_or_else(|| Path::new(""));
    let mut depth: i64 = relative_dir.components().count() as i64;
    for component in target.components() {
        match component {
            Component::ParentDir => depth -= 1,
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => {
                return Err(refuse(
                    "absolute symlinks break once the bundle is relocated",
                ))
            }
        }
        if depth < 0 {
            return Err(refuse("the symlink points outside its bundle tree"));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn make_symlink(target: &Path, destination: &Path) -> Result<(), InstallError> {
    std::os::unix::fs::symlink(target, destination).map_err(io_error(destination))
}

#[cfg(not(unix))]
fn make_symlink(_target: &Path, destination: &Path) -> Result<(), InstallError> {
    Err(InstallError::Refused {
        path: destination.display().to_string(),
        reason: "bundles are only installed on Linux".into(),
    })
}

#[cfg(unix)]
fn set_mode(path: &Path, metadata: &fs::Metadata) -> Result<(), InstallError> {
    use std::os::unix::fs::PermissionsExt;
    // Never carry set-uid, set-gid or sticky bits into someone's image.
    let mode = metadata.permissions().mode() & 0o777;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(io_error(path))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _metadata: &fs::Metadata) -> Result<(), InstallError> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::{symlink, PermissionsExt};

    use super::*;

    fn manifest(tag: &str) -> String {
        format!(
            r#"{{"version":1,"releaseTag":"{tag}","minGlibc":"2.28","runtimes":[
                {{"id":"claude-code","version":"2","libc":["glibc","musl"]}},
                {{"id":"gemini-cli","version":"1","libc":["glibc"]}}]}}"#
        )
    }

    fn bundle(tag: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(MANIFEST_FILE), manifest(tag)).unwrap();
        for sub in [
            "bin",
            "certs",
            "common/git/bin",
            "common/bin",
            "glibc/bin",
            "glibc/lib/node_modules/@anthropic-ai/claude-code",
            "musl/bin",
        ] {
            fs::create_dir_all(root.join(sub)).unwrap();
        }
        fs::write(root.join("bin/cognia-sandboxd"), b"sandboxd").unwrap();
        fs::set_permissions(
            root.join("bin/cognia-sandboxd"),
            fs::Permissions::from_mode(0o4755),
        )
        .unwrap();
        fs::write(root.join("certs/ca-bundle.pem"), b"pem").unwrap();
        fs::write(root.join("common/git/bin/git"), b"git").unwrap();
        symlink("../git/bin/git", root.join("common/bin/git")).unwrap();
        fs::write(root.join("glibc/bin/node"), tag.as_bytes()).unwrap();
        fs::set_permissions(
            root.join("glibc/bin/node"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        fs::write(
            root.join("glibc/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
            b"cli",
        )
        .unwrap();
        symlink(
            "../lib/node_modules/@anthropic-ai/claude-code/cli.js",
            root.join("glibc/bin/claude"),
        )
        .unwrap();
        fs::write(root.join("musl/bin/node"), b"musl-node").unwrap();
        dir
    }

    #[test]
    fn stages_core_then_the_probed_libc_tree() {
        let from = bundle("v1");
        let to = tempfile::tempdir().unwrap();

        assert_eq!(
            install(from.path(), to.path(), Stage::Core).unwrap(),
            InstallOutcome::Installed {
                release_tag: "v1".into()
            }
        );
        assert!(to.path().join(MANIFEST_FILE).is_file());
        assert!(to.path().join("certs/ca-bundle.pem").is_file());
        assert_eq!(fs::read(to.path().join("common/bin/git")).unwrap(), b"git");
        assert!(!to.path().join("glibc").exists());
        let mode = fs::metadata(to.path().join("bin/cognia-sandboxd"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o7777, 0o755, "set-uid bit must be dropped");

        install(from.path(), to.path(), Stage::Libc(Libc::Glibc)).unwrap();
        assert_eq!(
            fs::read_link(to.path().join("glibc/bin/claude")).unwrap(),
            PathBuf::from("../lib/node_modules/@anthropic-ai/claude-code/cli.js")
        );
        assert_eq!(
            fs::read(to.path().join("glibc/bin/claude")).unwrap(),
            b"cli"
        );
        assert!(!to.path().join("musl").exists());
        assert!(fs::read_dir(to.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".staging")));
    }

    #[test]
    fn is_idempotent_for_a_bundle_and_replaces_a_different_one() {
        let to = tempfile::tempdir().unwrap();
        let v1 = bundle("v1");
        install(v1.path(), to.path(), Stage::Libc(Libc::Glibc)).unwrap();
        fs::write(to.path().join("glibc/bin/stray"), b"x").unwrap();
        assert_eq!(
            install(v1.path(), to.path(), Stage::Libc(Libc::Glibc)).unwrap(),
            InstallOutcome::AlreadyCurrent {
                release_tag: "v1".into()
            }
        );
        assert!(to.path().join("glibc/bin/stray").exists());

        let v2 = bundle("v2");
        assert_eq!(
            install(v2.path(), to.path(), Stage::Libc(Libc::Glibc)).unwrap(),
            InstallOutcome::Installed {
                release_tag: "v2".into()
            }
        );
        assert_eq!(fs::read(to.path().join("glibc/bin/node")).unwrap(), b"v2");
        assert!(!to.path().join("glibc/bin/stray").exists());
    }

    #[test]
    fn refuses_links_that_leave_the_tree_or_are_absolute() {
        let to = tempfile::tempdir().unwrap();
        let absolute = bundle("v1");
        symlink(
            "/opt/cognia/glibc/bin/node",
            absolute.path().join("glibc/bin/node2"),
        )
        .unwrap();
        let error = install(absolute.path(), to.path(), Stage::Libc(Libc::Glibc)).unwrap_err();
        assert!(error.to_string().contains("absolute symlinks"), "{error}");
        assert!(!to.path().join(".cognia-stage-glibc").exists());

        let escaping = bundle("v1");
        symlink(
            "../../musl/bin/node",
            escaping.path().join("glibc/bin/escape"),
        )
        .unwrap();
        let error = install(escaping.path(), to.path(), Stage::Libc(Libc::Glibc)).unwrap_err();
        assert!(
            error.to_string().contains("outside its bundle tree"),
            "{error}"
        );
    }

    #[test]
    fn refuses_a_bundle_missing_required_entries_or_the_libc() {
        let to = tempfile::tempdir().unwrap();
        let from = bundle("v1");
        fs::remove_dir_all(from.path().join("certs")).unwrap();
        assert!(matches!(
            install(from.path(), to.path(), Stage::Core),
            Err(InstallError::MissingEntry(entry)) if entry == "certs"
        ));
        let no_tools = bundle("v1");
        fs::remove_dir_all(no_tools.path().join("common")).unwrap();
        assert!(matches!(
            install(no_tools.path(), to.path(), Stage::Core),
            Err(InstallError::MissingEntry(entry)) if entry == "common"
        ));

        let no_musl_runtime = bundle("v1");
        fs::write(
            no_musl_runtime.path().join(MANIFEST_FILE),
            r#"{"version":1,"releaseTag":"v1","minGlibc":"2.28","runtimes":[{"id":"gemini-cli","version":"1","libc":["glibc"]}]}"#,
        )
        .unwrap();
        assert!(matches!(
            install(no_musl_runtime.path(), to.path(), Stage::Libc(Libc::Musl)),
            Err(InstallError::Refused { .. })
        ));

        let broken = tempfile::tempdir().unwrap();
        fs::write(broken.path().join(MANIFEST_FILE), b"{}").unwrap();
        assert!(matches!(
            install(broken.path(), to.path(), Stage::Core),
            Err(InstallError::Manifest(_))
        ));
    }

    #[test]
    fn refuses_special_files() {
        let to = tempfile::tempdir().unwrap();
        let from = bundle("v1");
        let fifo = from.path().join("bin/pipe");
        let path = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path; mkfifo has no other preconditions.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o644) }, 0);
        let error = install(from.path(), to.path(), Stage::Core).unwrap_err();
        assert!(error
            .to_string()
            .contains("only files, directories and symlinks"));
    }
}
