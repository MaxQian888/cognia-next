//! `plugin_install_from_github` — build-free install of a conforming plugin
//! straight from a public GitHub repository.
//!
//! Flow:
//!   1. Parse the reference (`owner/repo`, `owner/repo@ref`, `owner/repo/sub`,
//!      or a full `https://github.com/owner/repo[/tree/<ref>/<sub>]` URL).
//!   2. Resolve the ref (explicit > parsed `@ref` > the repo's default branch
//!      via the anonymous GitHub API).
//!   3. Download the `codeload` tarball (no local `git` needed) and extract it
//!      into a tempdir, stripping GitHub's top-level `{repo}-{ref}/` component.
//!   4. Locate the plugin root (explicit subdir, else `plugin.json` at the repo
//!      root or one directory deep) and parse the manifest.
//!   5. **No-build validation** — the declared entry artifact must already
//!      exist in the repo (`wasmMain` for `wasm`, `main`/`styles` for
//!      `frontend`/`hybrid`); declarative-only plugins pass with no entry.
//!   6. Read `README` / `LICENSE` text, then copy the plugin tree (minus dev
//!      dirs) into `<install_dir>/<plugin_id>/`.
//!
//! Public repos only — anonymous fetch. Token auth is intentionally out of
//! scope for this iteration.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::super::PluginRuntimeState;
use crate::generated_files::{apply_generated_files, safe_join};

/// Case-insensitive README filenames probed at the plugin root.
const README_NAMES: &[&str] = &["readme.md", "readme", "readme.txt", "readme.markdown"];
/// Case-insensitive LICENSE filenames probed at the plugin root.
const LICENSE_NAMES: &[&str] = &[
    "license",
    "license.md",
    "license.txt",
    "licence",
    "licence.md",
    "copying",
];
/// Directory names never copied into the install dir (VCS / build / deps).
const SKIP_DIRS: &[&str] = &[".git", ".github", "node_modules", "target"];

/// What we return to the TS side after a successful install. Mirrors
/// `WasmInstallResult` plus the README / license text the UI surfaces.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubInstallResult {
    pub manifest: serde_json::Value,
    pub path: String,
    pub source: String,
    pub install_root_kind: String,
    pub readme: Option<String>,
    pub license_text: Option<String>,
    pub repo: String,
    pub git_ref: String,
}

/// A parsed GitHub plugin reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubRef {
    pub owner: String,
    pub repo: String,
    pub git_ref: Option<String>,
    pub subdir: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PartialManifest {
    pub(crate) id: String,
    #[serde(rename = "type", default)]
    plugin_type: Option<String>,
    #[serde(default)]
    main: Option<String>,
    #[serde(default)]
    styles: Option<String>,
    #[serde(rename = "wasmMain", default)]
    wasm_main: Option<String>,
}

/// Parse a GitHub plugin reference. Accepts:
///   - `owner/repo`
///   - `owner/repo@ref`
///   - `owner/repo/sub/dir` (shorthand subdir)
///   - `owner/repo@ref/sub/dir`
///   - `https://github.com/owner/repo`
///   - `https://github.com/owner/repo/tree/<ref>/<sub...>`
///
/// Trailing `.git` on the repo token is stripped.
pub fn parse_github_ref(input: &str) -> Result<GithubRef, String> {
    let mut s = input.trim();
    if s.is_empty() {
        return Err("empty repository reference".into());
    }
    for prefix in ["https://", "http://", "git@"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest;
            break;
        }
    }
    // Strip a leading host. `git@github.com:owner/repo` uses a `:` separator.
    for host in ["github.com/", "www.github.com/", "github.com:"] {
        if let Some(rest) = s.strip_prefix(host) {
            s = rest;
            break;
        }
    }

    let segs: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
    if segs.len() < 2 {
        return Err(format!("expected 'owner/repo', got '{input}'"));
    }

    let owner = segs[0].to_string();
    let mut repo_token = segs[1];
    let mut git_ref: Option<String> = None;
    if let Some((repo_only, rf)) = repo_token.split_once('@') {
        repo_token = repo_only;
        let rf = rf.trim();
        if !rf.is_empty() {
            git_ref = Some(rf.to_string());
        }
    }
    let repo = repo_token.trim_end_matches(".git").to_string();
    if owner.is_empty() || repo.is_empty() {
        return Err(format!("expected 'owner/repo', got '{input}'"));
    }

    let mut subdir: Option<String> = None;
    let rest = &segs[2..];
    if !rest.is_empty() {
        if (rest[0] == "tree" || rest[0] == "blob") && rest.len() >= 2 {
            // GitHub web URL: .../tree/<ref>/<sub...>
            git_ref = Some(rest[1].to_string());
            if rest.len() > 2 {
                subdir = Some(rest[2..].join("/"));
            }
        } else {
            subdir = Some(rest.join("/"));
        }
    }

    Ok(GithubRef {
        owner,
        repo,
        git_ref,
        subdir,
    })
}

/// Resolve the repo's default branch via the anonymous GitHub API.
async fn resolve_default_branch(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Result<String, String> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}");
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("query repo metadata: {e}"))?
        .error_for_status()
        .map_err(|e| format!("repo metadata HTTP error (is the repo public?): {e}"))?;
    let bytes = crate::archive_limits::read_response_limited(
        resp,
        crate::archive_limits::MAX_METADATA_BYTES,
        "GitHub repository metadata",
    )
    .await?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse repo metadata: {e}"))?;
    value
        .get("default_branch")
        .and_then(|b| b.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "could not resolve the repository's default branch".to_string())
}

/// Extract a gzip tarball into `dest`, stripping the single top-level
/// directory GitHub wraps every archive in (`{repo}-{ref}/`). Entries that
/// would escape `dest` (via `..`) are skipped.
fn extract_tar_gz_stripping_root(bytes: &[u8], dest: &Path) -> Result<(), String> {
    extract_tar_gz_stripping_root_with_limits(
        bytes,
        dest,
        crate::archive_limits::MAX_ARCHIVE_ENTRIES,
        crate::archive_limits::MAX_UNPACKED_BYTES,
    )
}

fn extract_tar_gz_stripping_root_with_limits(
    bytes: &[u8],
    dest: &Path,
    max_entries: usize,
    max_unpacked_bytes: u64,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir {dest:?}: {e}"))?;
    let gz = GzDecoder::new(bytes);
    let mut archive = Archive::new(gz);
    let mut entry_count = 0_usize;
    let mut total_written = 0_u64;
    for entry in archive
        .entries()
        .map_err(|e| format!("read tar entries: {e}"))?
    {
        entry_count += 1;
        if entry_count > max_entries {
            return Err(format!(
                "plugin archive contains more than {} entries",
                max_entries
            ));
        }
        let mut entry = entry.map_err(|e| format!("read tar entry: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("tar entry path: {e}"))?
            .into_owned();

        // Drop the top-level component, then reject any traversal segments.
        let mut comps = path.components();
        comps.next();
        let rel = comps.as_path();
        if rel.as_os_str().is_empty() {
            continue;
        }
        if rel.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(format!("unsafe tar entry path: {path:?}"));
        }
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(format!(
                "archive entry must be a regular file or directory: {path:?}"
            ));
        }

        let out = dest.join(rel);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("mkdir {out:?}: {e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        let mut file = std::fs::File::create(&out).map_err(|e| format!("create {out:?}: {e}"))?;
        crate::archive_limits::copy_with_budget(
            &mut entry,
            &mut file,
            &mut total_written,
            max_unpacked_bytes,
            out.to_string_lossy().as_ref(),
        )?;
    }
    Ok(())
}

/// Locate `plugin.json` at `root` or exactly one directory deep (monorepo
/// layouts). Only one level is probed on purpose so a misplaced file can't be
/// silently picked.
pub(crate) fn find_plugin_manifest(root: &Path) -> Option<PathBuf> {
    let candidate = root.join("plugin.json");
    if candidate.exists() {
        return Some(candidate);
    }
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let nested = p.join("plugin.json");
            if nested.exists() {
                return Some(nested);
            }
        }
    }
    None
}

pub(crate) fn read_manifest(path: &Path) -> Result<(serde_json::Value, PartialManifest), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read manifest {path:?}: {e}"))?;
    let raw: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;
    let parsed: PartialManifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest fields: {e}"))?;
    if parsed.id.trim().is_empty() {
        return Err("manifest is missing a non-empty `id`".into());
    }
    Ok((raw, parsed))
}

/// Enforce the build-free contract: any declared entry artifact must already
/// ship in the repo. Source-only plugins that would need a build step are
/// rejected with an actionable message.
pub(crate) fn validate_no_build(root: &Path, manifest: &PartialManifest) -> Result<(), String> {
    match manifest.plugin_type.as_deref() {
        Some("wasm") => {
            let wasm_main = manifest.wasm_main.as_deref().map(str::trim).unwrap_or("");
            if wasm_main.is_empty()
                || crate::contained_path::resolve_existing_plugin_file(root, wasm_main).is_err()
            {
                return Err(
                    "WASM plugins must ship a prebuilt .wasm in the repo. Use \"Install WASM from Git\" to build from source instead."
                        .into(),
                );
            }
        }
        Some("frontend") | Some("hybrid") => {
            if let Some(main) = entry_field(&manifest.main) {
                if crate::contained_path::resolve_existing_plugin_file(root, main).is_err() {
                    return Err(format!(
                        "manifest 'main' entry '{main}' is missing from the repo — the plugin must ship its built artifact (this installer does not run a build)."
                    ));
                }
            }
            if let Some(styles) = entry_field(&manifest.styles) {
                if crate::contained_path::resolve_existing_plugin_file(root, styles).is_err() {
                    return Err(format!(
                        "manifest 'styles' entry '{styles}' is missing from the repo."
                    ));
                }
            }
        }
        // `python` and declarative-only plugins (skills / commands / agents /
        // themes with no JS or WASM entry) require no built artifact.
        _ => {}
    }
    Ok(())
}

fn entry_field(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// Read the first matching file (case-insensitive) at `root` as UTF-8 text.
fn read_optional_text(root: &Path, names: &[&str]) -> Option<String> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_lowercase();
        if names.iter().any(|n| file_name == *n) {
            if let Ok(text) = std::fs::read_to_string(entry.path()) {
                return Some(text);
            }
        }
    }
    None
}

/// Copy a plugin tree, skipping VCS / build / dependency directories.
pub(crate) fn copy_plugin_tree(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| format!("read_dir {src:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let path = entry.path();
        let name = entry.file_name();
        let rel = path.strip_prefix(src).unwrap();
        let target = dst.join(rel);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("stat plugin tree entry {path:?}: {e}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("plugin tree contains a symbolic link: {path:?}"));
        }
        if metadata.is_dir() {
            if SKIP_DIRS.iter().any(|s| name == std::ffi::OsStr::new(s)) {
                continue;
            }
            std::fs::create_dir_all(&target).map_err(|e| format!("mkdir {target:?}: {e}"))?;
            copy_plugin_tree(&path, &target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
            }
            std::fs::copy(&path, &target).map_err(|e| format!("copy {path:?}: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_install_from_github(
    state: State<'_, PluginRuntimeState>,
    repo: String,
    git_ref: Option<String>,
    subdir: Option<String>,
    generated_files: Option<BTreeMap<String, String>>,
) -> Result<GithubInstallResult, String> {
    plugin_install_from_github_for_state(
        state.inner(),
        repo,
        git_ref,
        subdir,
        generated_files.unwrap_or_default(),
    )
    .await
}

/// Host-neutral GitHub install used by Tauri and the headless companion host.
pub async fn plugin_install_from_github_for_state(
    state: &PluginRuntimeState,
    repo: String,
    git_ref: Option<String>,
    subdir: Option<String>,
    generated_files: BTreeMap<String, String>,
) -> Result<GithubInstallResult, String> {
    let mut gh = parse_github_ref(&repo)?;
    if let Some(r) = git_ref.filter(|s| !s.trim().is_empty()) {
        gh.git_ref = Some(r.trim().to_string());
    }
    if let Some(s) = subdir.filter(|s| !s.trim().is_empty()) {
        gh.subdir = Some(s.trim().trim_matches('/').to_string());
    }

    let policy_url = format!("https://api.github.com/repos/{}/{}", gh.owner, gh.repo);
    let builder = reqwest::Client::builder().user_agent("cognia-plugin-installer/0.1");
    let (builder, _) = cognia_net::proxy_config::apply_reqwest_policy(builder, &policy_url)
        .map_err(|error| error.to_string())?;
    let client = builder
        .build()
        .map_err(|e| format!("http client init: {e}"))?;

    // Step 1 — resolve the ref.
    let resolved_ref = match gh.git_ref.clone() {
        Some(r) => r,
        None => resolve_default_branch(&client, &gh.owner, &gh.repo).await?,
    };

    // Step 2 — download + extract the tarball.
    let tar_url = format!(
        "https://codeload.github.com/{}/{}/tar.gz/{}",
        gh.owner, gh.repo, resolved_ref
    );
    let response = client
        .get(&tar_url)
        .send()
        .await
        .map_err(|e| format!("download repository tarball: {e}"))?
        .error_for_status()
        .map_err(|e| {
            format!("download tarball (HTTP error — check the repo/ref is public): {e}")
        })?;
    let bytes = crate::archive_limits::read_response_limited(
        response,
        crate::archive_limits::MAX_DOWNLOAD_BYTES,
        "GitHub plugin tarball",
    )
    .await?;

    let staging = tempfile::tempdir().map_err(|e| format!("create temp dir: {e}"))?;
    extract_tar_gz_stripping_root(&bytes, staging.path())?;

    // Step 3 — resolve the plugin root.
    let plugin_root = match gh.subdir.as_deref() {
        Some(sub) => {
            let candidate = safe_join(staging.path(), sub)?;
            if !candidate.is_dir() {
                return Err(format!("plugin subdir does not exist: '{sub}'"));
            }
            if generated_files.is_empty() && !candidate.join("plugin.json").exists() {
                return Err(format!("subdir '{sub}' has no plugin.json"));
            }
            candidate
        }
        None if !generated_files.is_empty() => staging.path().to_path_buf(),
        None => {
            let manifest_path = find_plugin_manifest(staging.path())
                .ok_or_else(|| "repository is missing plugin.json".to_string())?;
            manifest_path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| staging.path().to_path_buf())
        }
    };

    // Step 4 — parse + validate (no build).
    apply_generated_files(&plugin_root, &generated_files)?;
    let manifest_path = plugin_root.join("plugin.json");
    let (manifest_value, parsed) = read_manifest(&manifest_path)?;
    crate::contract::validate_manifest_contract(&manifest_value)?;
    crate::contract::validate_existing_manifest_paths(&plugin_root, &manifest_value)?;
    validate_no_build(&plugin_root, &parsed)?;

    // Step 5 — read README / LICENSE text.
    let readme = read_optional_text(&plugin_root, README_NAMES);
    let license_text = read_optional_text(&plugin_root, LICENSE_NAMES);

    // Step 6 — copy the plugin tree into the canonical install dir.
    let plugin_dir = state.plugin_dir(&parsed.id);
    if plugin_dir.exists() {
        std::fs::remove_dir_all(&plugin_dir).map_err(|e| format!("clear {plugin_dir:?}: {e}"))?;
    }
    std::fs::create_dir_all(&plugin_dir).map_err(|e| format!("mkdir {plugin_dir:?}: {e}"))?;
    copy_plugin_tree(&plugin_root, &plugin_dir)?;
    crate::contract::validate_existing_manifest_paths(&plugin_dir, &manifest_value)?;

    Ok(GithubInstallResult {
        manifest: manifest_value,
        path: plugin_dir.to_string_lossy().into_owned(),
        source: "git".into(),
        install_root_kind: "installed".into(),
        readme,
        license_text,
        repo: format!("{}/{}", gh.owner, gh.repo),
        git_ref: resolved_ref,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(owner: &str, repo: &str, git_ref: Option<&str>, subdir: Option<&str>) -> GithubRef {
        GithubRef {
            owner: owner.into(),
            repo: repo.into(),
            git_ref: git_ref.map(Into::into),
            subdir: subdir.map(Into::into),
        }
    }

    #[test]
    fn parse_shorthand_owner_repo() {
        assert_eq!(
            parse_github_ref("acme/cool-plugin").unwrap(),
            r("acme", "cool-plugin", None, None)
        );
    }

    #[test]
    fn parse_strips_dot_git_and_reads_at_ref() {
        assert_eq!(
            parse_github_ref("acme/cool-plugin.git@v1.2.0").unwrap(),
            r("acme", "cool-plugin", Some("v1.2.0"), None)
        );
    }

    #[test]
    fn parse_shorthand_subdir() {
        assert_eq!(
            parse_github_ref("acme/monorepo/packages/plugin-a").unwrap(),
            r("acme", "monorepo", None, Some("packages/plugin-a"))
        );
    }

    #[test]
    fn parse_https_url() {
        assert_eq!(
            parse_github_ref("https://github.com/acme/cool-plugin").unwrap(),
            r("acme", "cool-plugin", None, None)
        );
    }

    #[test]
    fn parse_https_tree_url_with_ref_and_subdir() {
        assert_eq!(
            parse_github_ref("https://github.com/acme/monorepo/tree/main/packages/plugin-a")
                .unwrap(),
            r("acme", "monorepo", Some("main"), Some("packages/plugin-a"))
        );
    }

    #[test]
    fn parse_rejects_bare_token() {
        assert!(parse_github_ref("just-a-name").is_err());
        assert!(parse_github_ref("").is_err());
    }

    fn make_tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        let mut buf = Vec::new();
        {
            let enc = GzEncoder::new(&mut buf, Compression::fast());
            let mut builder = tar::Builder::new(enc);
            for (name, content) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, *content).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap();
        }
        buf
    }

    #[test]
    fn extract_strips_github_top_level_dir() {
        // GitHub wraps everything under `{repo}-{ref}/`.
        let tar = make_tar_gz(&[
            ("cool-plugin-main/plugin.json", br#"{"id":"x"}"#),
            ("cool-plugin-main/main.js", b"export default {}"),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        extract_tar_gz_stripping_root(&tar, tmp.path()).unwrap();
        assert!(tmp.path().join("plugin.json").exists());
        assert!(tmp.path().join("main.js").exists());
        // Top-level dir must NOT survive.
        assert!(!tmp.path().join("cool-plugin-main").exists());
    }

    #[test]
    fn extract_enforces_entry_and_unpacked_byte_limits() {
        let tar = make_tar_gz(&[("repo-main/a.js", b"1234"), ("repo-main/b.js", b"5678")]);

        let entry_dest = tempfile::tempdir().unwrap();
        let entry_error =
            extract_tar_gz_stripping_root_with_limits(&tar, entry_dest.path(), 1, 1024)
                .unwrap_err();
        assert!(entry_error.contains("more than 1 entries"));

        let byte_dest = tempfile::tempdir().unwrap();
        let byte_error =
            extract_tar_gz_stripping_root_with_limits(&tar, byte_dest.path(), 10, 7).unwrap_err();
        assert!(byte_error.contains("7-byte extraction limit"));
    }

    #[test]
    fn extract_rejects_symlink_entries() {
        use flate2::write::GzEncoder;
        use flate2::Compression;

        let mut bytes = Vec::new();
        {
            let encoder = GzEncoder::new(&mut bytes, Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_link_name("../../outside.js").unwrap();
            header.set_cksum();
            builder
                .append_data(&mut header, "repo-main/link.js", &[][..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }

        let dest = tempfile::tempdir().unwrap();
        let error = extract_tar_gz_stripping_root(&bytes, dest.path()).unwrap_err();
        assert!(error.contains("regular file or directory"));
        assert!(!dest.path().join("link.js").exists());
    }

    #[test]
    fn extract_rejects_other_special_entries() {
        use flate2::write::GzEncoder;
        use flate2::Compression;

        let mut bytes = Vec::new();
        {
            let encoder = GzEncoder::new(&mut bytes, Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Fifo);
            header.set_size(0);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "repo-main/pipe", &[][..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }

        let dest = tempfile::tempdir().unwrap();
        let error = extract_tar_gz_stripping_root(&bytes, dest.path()).unwrap_err();
        assert!(error.contains("regular file or directory"));
    }

    #[test]
    fn find_manifest_root_and_nested() {
        let tmp = tempfile::tempdir().unwrap();
        let root_manifest = tmp.path().join("plugin.json");
        std::fs::write(&root_manifest, "{}").unwrap();
        assert_eq!(find_plugin_manifest(tmp.path()), Some(root_manifest));

        std::fs::remove_file(tmp.path().join("plugin.json")).unwrap();
        let nested = tmp.path().join("pkg");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("plugin.json"), "{}").unwrap();
        let found = find_plugin_manifest(tmp.path()).unwrap();
        assert!(found.ends_with("plugin.json"));
        assert!(found.to_string_lossy().contains("pkg"));
    }

    #[test]
    fn read_manifest_requires_id() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("plugin.json");
        std::fs::write(&path, r#"{"id":""}"#).unwrap();
        assert!(read_manifest(&path).is_err());
        std::fs::write(&path, r#"{"id":"ok","type":"frontend"}"#).unwrap();
        let (_, parsed) = read_manifest(&path).unwrap();
        assert_eq!(parsed.id, "ok");
    }

    #[test]
    fn validate_rejects_wasm_without_artifact() {
        let tmp = tempfile::tempdir().unwrap();
        let m = PartialManifest {
            id: "x".into(),
            plugin_type: Some("wasm".into()),
            main: None,
            styles: None,
            wasm_main: Some("main.wasm".into()),
        };
        // No main.wasm on disk → rejected with the "build from source" hint.
        let err = validate_no_build(tmp.path(), &m).unwrap_err();
        assert!(err.contains("WASM"));
        // Once the artifact ships, it passes.
        std::fs::write(tmp.path().join("main.wasm"), b"\0asm").unwrap();
        assert!(validate_no_build(tmp.path(), &m).is_ok());
    }

    #[test]
    fn validate_rejects_frontend_missing_main() {
        let tmp = tempfile::tempdir().unwrap();
        let m = PartialManifest {
            id: "x".into(),
            plugin_type: Some("frontend".into()),
            main: Some("dist/index.js".into()),
            styles: None,
            wasm_main: None,
        };
        assert!(validate_no_build(tmp.path(), &m)
            .unwrap_err()
            .contains("main"));
        std::fs::create_dir_all(tmp.path().join("dist")).unwrap();
        std::fs::write(tmp.path().join("dist/index.js"), b"x").unwrap();
        assert!(validate_no_build(tmp.path(), &m).is_ok());
    }

    #[test]
    fn validate_allows_declarative_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        // No main / wasmMain → declarative-only contributions, no artifact needed.
        let m = PartialManifest {
            id: "x".into(),
            plugin_type: Some("frontend".into()),
            main: None,
            styles: None,
            wasm_main: None,
        };
        assert!(validate_no_build(tmp.path(), &m).is_ok());
    }

    #[test]
    fn read_optional_text_is_case_insensitive() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("README.md"), "# Hello").unwrap();
        std::fs::write(tmp.path().join("LICENSE"), "MIT").unwrap();
        assert_eq!(
            read_optional_text(tmp.path(), README_NAMES).as_deref(),
            Some("# Hello")
        );
        assert_eq!(
            read_optional_text(tmp.path(), LICENSE_NAMES).as_deref(),
            Some("MIT")
        );
        let empty = tempfile::tempdir().unwrap();
        assert!(read_optional_text(empty.path(), README_NAMES).is_none());
    }

    #[test]
    fn copy_plugin_tree_skips_dev_dirs() {
        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("plugin.json"), "{}").unwrap();
        std::fs::create_dir_all(src.path().join("node_modules/foo")).unwrap();
        std::fs::write(src.path().join("node_modules/foo/x.js"), "x").unwrap();
        std::fs::create_dir_all(src.path().join(".git")).unwrap();
        std::fs::write(src.path().join(".git/config"), "x").unwrap();
        std::fs::create_dir_all(src.path().join("assets")).unwrap();
        std::fs::write(src.path().join("assets/icon.svg"), "<svg/>").unwrap();

        let dst = tempfile::tempdir().unwrap();
        copy_plugin_tree(src.path(), dst.path()).unwrap();
        assert!(dst.path().join("plugin.json").exists());
        assert!(dst.path().join("assets/icon.svg").exists());
        assert!(!dst.path().join("node_modules").exists());
        assert!(!dst.path().join(".git").exists());
    }
}
