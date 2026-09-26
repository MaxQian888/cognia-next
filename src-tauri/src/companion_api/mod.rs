//! The desktop app's side of the companion (ADR-0196 P7).
//!
//! The companion core — state, the listener and its routes, authentication,
//! canonical remote execution, the WebSocket planes, signaling, A2A and ACP —
//! is the `cognia-companion` crate, glob-re-exported here so every
//! `crate::companion_api::…` / `app_lib::companion_api::…` path and every
//! `generate_handler!` entry resolves unchanged.
//!
//! What stays is what names the app:
//!
//! - [`rpc`] and [`dispatch_host`] — the RPC dispatch table and the host it
//!   runs arms on (the desktop `AppHandle` or the headless services);
//! - [`commands`] — the Tauri command shells the renderer calls;
//! - [`wiring`] — the app's [`runtime::CompanionRuntime`], which hands the
//!   core its dispatcher and the routes it cannot name;
//! - [`host`] — the WebView renderer adapter (`TauriRenderer`);
//! - [`skill_transactions`], `langfuse`, and the parity tests that read the
//!   dispatch table against the published contract.

pub use cognia_companion::*;

mod command_contract_parity;
pub mod commands;
pub mod dispatch_host;
mod event_catalog_parity;
/// The crate's renderer port plus the desktop's WebView adapter.
pub mod host;
pub(crate) mod langfuse;
/// What every dispatchable arm answers with (ADR-0175 B4).
mod output_registry;
pub mod rpc;
pub mod skill_transactions;
pub mod spec_parity;
pub mod wiring;

#[cfg(test)]
mod tests {
    /// Every `.rs` file under `companion_api/` must be mounted by a `mod`
    /// declaration or a `#[path]` one. A file nothing mounts is never
    /// compiled, and it is what a move into `crates/` leaves behind when it
    /// copies a module instead of moving it (ADR-0196 P4): the stale copy sits
    /// at the old path, reads as live code, and every test stays green.
    #[test]
    fn every_source_file_is_mounted() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/companion_api");
        let orphans = unmounted_sources(&root);
        assert!(
            orphans.is_empty(),
            "not mounted by any `mod` declaration, so never compiled — delete them if \
             they moved to a crate, or declare them: {orphans:?}"
        );
    }

    #[test]
    fn unmounted_sources_finds_stray_files_and_undeclared_module_dirs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let write = |path: &str, source: &str| {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, source).unwrap();
        };
        write(
            "mod.rs",
            "pub mod a;\npub(crate) mod sub;\nmod gen_host;\n#[cfg(test)]\nmod tests {\n}\n",
        );
        write("a.rs", "");
        write("stale.rs", "");
        write("sub/mod.rs", "mod inner;\n");
        write("sub/inner.rs", "");
        write("sub/zombie.rs", "");
        write(
            "gen_host.rs",
            "#[path = \"generated/table.rs\"]\npub mod table;\n",
        );
        write("generated/table.rs", "");
        write("generated/old.rs", "");
        write("moved/mod.rs", "");

        assert_eq!(
            unmounted_sources(root),
            ["generated/old.rs", "moved", "stale.rs", "sub/zombie.rs"]
        );
    }

    /// The `.rs` files and module directories under `root` (a directory whose
    /// module file is `root/mod.rs`) that nothing mounts, relative to `root`.
    fn unmounted_sources(root: &std::path::Path) -> Vec<String> {
        let mut mounts = std::collections::HashSet::new();
        collect_path_mounts(root, &mut mounts);
        let mut orphans = Vec::new();
        walk_module_dir(root, &root.join("mod.rs"), &mounts, &mut orphans);
        let mut orphans: Vec<String> = orphans
            .iter()
            .map(|path| path.strip_prefix(root).unwrap().display().to_string())
            .collect();
        orphans.sort();
        orphans
    }

    /// Names declared as file modules (`mod name;`, any visibility) in
    /// `module_file`. Inline `mod name { .. }` blocks mount no file.
    fn declared_file_modules(module_file: &std::path::Path) -> std::collections::HashSet<String> {
        let source = std::fs::read_to_string(module_file).unwrap_or_default();
        source
            .lines()
            .filter_map(|line| {
                let line = line.trim_start();
                let rest = match line.strip_prefix("pub") {
                    Some(rest) => match rest.trim_start().strip_prefix('(') {
                        Some(scoped) => scoped.split_once(')')?.1,
                        None => rest,
                    },
                    None => line,
                };
                let name = rest.trim_start().strip_prefix("mod ")?;
                Some(name.trim().strip_suffix(';')?.trim().to_string())
            })
            .collect()
    }

    /// Every file a `#[path = "…"]` attribute mounts, resolved against the
    /// directory of the file that carries it (the rule for a non-inline
    /// module declaration).
    fn collect_path_mounts(
        dir: &std::path::Path,
        mounts: &mut std::collections::HashSet<std::path::PathBuf>,
    ) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_path_mounts(&path, mounts);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let source = std::fs::read_to_string(&path).unwrap_or_default();
                for line in source.lines() {
                    let Some(rest) = line.trim_start().strip_prefix("#[path = \"") else {
                        continue;
                    };
                    if let Some((target, _)) = rest.split_once('"') {
                        if let Ok(target) = dir.join(target).canonicalize() {
                            mounts.insert(target);
                        }
                    }
                }
            }
        }
    }

    fn is_mounted(
        path: &std::path::Path,
        mounts: &std::collections::HashSet<std::path::PathBuf>,
    ) -> bool {
        path.canonicalize().is_ok_and(|path| mounts.contains(&path))
    }

    /// Check the entries of `dir`, whose `mod` declarations live in
    /// `module_file` (`dir/mod.rs`, or `dir.rs` beside it).
    fn walk_module_dir(
        dir: &std::path::Path,
        module_file: &std::path::Path,
        mounts: &std::collections::HashSet<std::path::PathBuf>,
        orphans: &mut Vec<std::path::PathBuf>,
    ) {
        let declared = declared_file_modules(module_file);
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        entries.sort();
        for path in entries {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if path.is_file() {
                let Some(stem) = name.strip_suffix(".rs") else {
                    continue;
                };
                if path == module_file {
                    continue;
                }
                if declared.contains(stem) {
                    let children = dir.join(stem);
                    if children.is_dir() {
                        walk_module_dir(&children, &path, mounts, orphans);
                    }
                } else if !is_mounted(&path, mounts) {
                    orphans.push(path);
                }
            } else if path.is_dir() {
                let mod_rs = path.join("mod.rs");
                if mod_rs.is_file() {
                    if declared.contains(&name) {
                        walk_module_dir(&path, &mod_rs, mounts, orphans);
                    } else {
                        orphans.push(path);
                    }
                } else if !dir.join(format!("{name}.rs")).is_file() {
                    // No module file of its own: only `#[path]` targets may
                    // live here.
                    collect_unmounted(&path, mounts, orphans);
                }
            }
        }
    }

    fn collect_unmounted(
        dir: &std::path::Path,
        mounts: &std::collections::HashSet<std::path::PathBuf>,
        orphans: &mut Vec<std::path::PathBuf>,
    ) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_unmounted(&path, mounts, orphans);
            } else if path.extension().is_some_and(|ext| ext == "rs") && !is_mounted(&path, mounts)
            {
                orphans.push(path);
            }
        }
    }
}
