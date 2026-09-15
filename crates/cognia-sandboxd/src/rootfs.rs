//! Reading an image's filesystem from a root directory without leaving it.
//!
//! `probe` inspects the user image through a root path (`/` in production, a
//! fixture tree in tests). Symlinks inside an image are routinely absolute —
//! `/bin/sh -> /bin/busybox`, `/lib64/ld-linux-x86-64.so.2 ->
//! /lib/x86_64-linux-gnu/…` — and must resolve against that root, never
//! against the probing process's own `/`.

use std::io;
use std::path::{Component, Path, PathBuf};

/// Symlink hops before giving up, as `MAXSYMLINKS` on Linux.
const MAX_SYMLINK_HOPS: usize = 40;

/// Resolves `path` (interpreted as absolute inside the image) to a host path
/// under `root`, following symlinks the way the image's kernel view would.
/// `..` never climbs above `root`. Returns `NotFound` when a component is
/// missing.
pub fn resolve(root: &Path, path: &str) -> io::Result<PathBuf> {
    let mut hops = 0;
    // Components still to walk, stored reversed so `pop` takes the next one.
    let mut pending: Vec<String> = components_of(path).into_iter().rev().collect();
    let mut resolved: Vec<String> = Vec::new();

    while let Some(component) = pending.pop() {
        match component.as_str() {
            "." => continue,
            ".." => {
                resolved.pop();
                continue;
            }
            _ => {}
        }
        let candidate = host_path(root, &resolved).join(&component);
        let metadata = std::fs::symlink_metadata(&candidate)?;
        if !metadata.file_type().is_symlink() {
            resolved.push(component);
            continue;
        }
        hops += 1;
        if hops > MAX_SYMLINK_HOPS {
            return Err(io::Error::other(format!(
                "too many levels of symbolic links resolving {path}"
            )));
        }
        let target = std::fs::read_link(&candidate)?;
        let target = target.to_string_lossy();
        if target.starts_with('/') {
            resolved.clear();
        }
        for next in components_of(&target).into_iter().rev() {
            pending.push(next);
        }
    }
    Ok(host_path(root, &resolved))
}

/// The in-image absolute path a resolved host path corresponds to.
pub fn image_path(root: &Path, host: &Path) -> String {
    match host.strip_prefix(root) {
        Ok(relative) => format!("/{}", relative.to_string_lossy()),
        Err(_) => host.to_string_lossy().into_owned(),
    }
}

/// Whether `path` exists inside the image (following symlinks).
pub fn exists(root: &Path, path: &str) -> bool {
    resolve(root, path).is_ok_and(|host| host.exists())
}

fn components_of(path: &str) -> Vec<String> {
    Path::new(path)
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            Component::ParentDir => Some("..".into()),
            Component::CurDir => Some(".".into()),
            Component::RootDir | Component::Prefix(_) => None,
        })
        .collect()
}

fn host_path(root: &Path, components: &[String]) -> PathBuf {
    let mut path = root.to_path_buf();
    for component in components {
        path.push(component);
    }
    path
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    #[test]
    fn follows_absolute_and_relative_links_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("lib/x86_64-linux-gnu")).unwrap();
        std::fs::write(root.join("bin/busybox"), b"elf").unwrap();
        symlink("/bin/busybox", root.join("bin/sh")).unwrap();
        std::fs::write(
            root.join("lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"),
            b"ld",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("lib64")).unwrap();
        symlink(
            "../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
            root.join("lib64/ld-linux-x86-64.so.2"),
        )
        .unwrap();

        assert_eq!(resolve(root, "/bin/sh").unwrap(), root.join("bin/busybox"));
        assert_eq!(
            resolve(root, "/lib64/ld-linux-x86-64.so.2").unwrap(),
            root.join("lib/x86_64-linux-gnu/ld-linux-x86-64.so.2")
        );
        assert_eq!(
            image_path(root, &resolve(root, "/bin/sh").unwrap()),
            "/bin/busybox"
        );
        assert!(exists(root, "/bin/sh"));
        assert!(!exists(root, "/bin/bash"));
    }

    #[test]
    fn never_escapes_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("rootfs");
        std::fs::create_dir_all(root.join("etc")).unwrap();
        std::fs::write(dir.path().join("secret"), b"host").unwrap();
        std::fs::write(root.join("etc/secret"), b"image").unwrap();
        symlink("../../../../secret", root.join("etc/up")).unwrap();
        symlink("/../../etc/secret", root.join("etc/abs")).unwrap();

        // Both clamp at the image root, so they land on the image's own file
        // (or nothing), never the host's.
        assert!(resolve(&root, "/etc/up").is_err());
        assert_eq!(resolve(&root, "/etc/abs").unwrap(), root.join("etc/secret"));
        assert_eq!(
            resolve(&root, "/../../etc/secret").unwrap(),
            root.join("etc/secret")
        );
    }

    #[test]
    fn stops_on_symlink_loops() {
        let dir = tempfile::tempdir().unwrap();
        symlink("/b", dir.path().join("a")).unwrap();
        symlink("/a", dir.path().join("b")).unwrap();
        let error = resolve(dir.path(), "/a").unwrap_err();
        assert!(error.to_string().contains("too many levels"));
    }
}
