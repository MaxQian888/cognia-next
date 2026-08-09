//! Conflict-safe installation of the embedded `cognia host` Agent Skills bundle.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use crate::cli::HostSkillScope;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[cfg(test)]
use super::embedded_skill_description;
use super::{EmbeddedSkill, HostFailure, EMBEDDED_SKILLS};

const MANIFEST_FILE: &str = ".cognia-host-manifest.json";
const MANIFEST_OWNER: &str = "cognia-host";
const MANIFEST_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedManifest {
    schema_version: u32,
    owner: String,
    bundle_version: String,
    files: BTreeMap<String, String>,
}

#[derive(Debug)]
struct InstallPlan {
    installed: Vec<String>,
    updated: Vec<String>,
    unchanged: Vec<String>,
    removed: Vec<String>,
    interrupted_temporaries: Vec<PathBuf>,
}

pub(super) fn install_embedded_skills(
    scope: HostSkillScope,
) -> std::result::Result<Value, HostFailure> {
    let cwd = std::env::current_dir().map_err(|error| {
        HostFailure::configuration(
            "skill_install_cwd_unavailable",
            format!("cannot resolve the current directory: {error}"),
        )
    })?;
    let home = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
    let root = resolve_skills_root(scope, &cwd, home.as_deref())?;
    install_at_root(scope, &root)
}

pub(super) fn skill_content_hash(skill: &EmbeddedSkill) -> String {
    let mut hasher = Sha256::new();
    hash_named_content(&mut hasher, "SKILL.md", skill.content.as_bytes());
    for (path, content) in skill.references {
        hash_named_content(&mut hasher, path, content.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn hash_named_content(hasher: &mut Sha256, path: &str, content: &[u8]) {
    hasher.update((path.len() as u64).to_le_bytes());
    hasher.update(path.as_bytes());
    hasher.update((content.len() as u64).to_le_bytes());
    hasher.update(content);
}

fn scope_name(scope: HostSkillScope) -> &'static str {
    match scope {
        HostSkillScope::User => "user",
        HostSkillScope::Project => "project",
    }
}

fn resolve_skills_root(
    scope: HostSkillScope,
    cwd: &Path,
    home: Option<&Path>,
) -> std::result::Result<PathBuf, HostFailure> {
    match scope {
        HostSkillScope::User => home.map(|home| home.join(".agents/skills")).ok_or_else(|| {
            HostFailure::configuration(
                "skill_install_home_unavailable",
                "cannot resolve the user home directory",
            )
        }),
        HostSkillScope::Project => {
            let project_root = git_worktree_root(cwd)?.unwrap_or_else(|| cwd.to_path_buf());
            Ok(project_root.join(".agents/skills"))
        }
    }
}

fn git_worktree_root(cwd: &Path) -> std::result::Result<Option<PathBuf>, HostFailure> {
    let output = Command::new("git")
        .args(["-C"])
        .arg(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .map_err(|error| {
            HostFailure::configuration(
                "skill_install_git_unavailable",
                format!("cannot run Git to resolve the project skill scope: {error}"),
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.starts_with("fatal: not a git repository") {
            return Ok(None);
        }
        return Err(HostFailure::configuration(
            "skill_install_git_discovery_failed",
            format!(
                "Git could not resolve the project skill scope from {}: {}",
                cwd.display(),
                stderr.trim()
            ),
        ));
    }
    let stdout = String::from_utf8(output.stdout).map_err(|_| {
        HostFailure::configuration(
            "skill_install_git_discovery_failed",
            "Git returned a non-UTF-8 worktree path",
        )
    })?;
    let path = PathBuf::from(stdout.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err(HostFailure::configuration(
            "skill_install_git_discovery_failed",
            format!("Git returned an invalid worktree root: {}", path.display()),
        ));
    }
    Ok(Some(path))
}

fn validate_install_root(root: &Path) -> std::result::Result<(), HostFailure> {
    let mut conflicts = BTreeSet::new();
    for path in root.parent().into_iter().chain(std::iter::once(root)) {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                conflicts.insert(path.display().to_string());
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(install_io_error(
                    "inspect Agent Skills destination",
                    path,
                    error,
                ))
            }
        }
    }
    if conflicts.is_empty() {
        Ok(())
    } else {
        Err(conflict_failure(conflicts))
    }
}

fn install_at_root(scope: HostSkillScope, root: &Path) -> std::result::Result<Value, HostFailure> {
    validate_install_root(root)?;
    let desired = desired_files();
    let manifest_bytes = serialize_manifest(&desired)?;
    let manifest_temporary = inspect_interrupted_temporary(
        &temporary_path(&root.join(MANIFEST_FILE))?,
        &sha256(&manifest_bytes),
    )?;
    let previous = read_manifest(root)?;
    let plan = build_install_plan(root, &desired, previous.as_ref())?;

    for temporary in plan
        .interrupted_temporaries
        .iter()
        .chain(manifest_temporary.iter())
    {
        fs::remove_file(temporary).map_err(|error| {
            install_io_error("remove interrupted skill temporary", temporary, error)
        })?;
    }
    fs::create_dir_all(root)
        .map_err(|error| install_io_error("create skills root", root, error))?;

    for relative in &plan.installed {
        write_desired_file(root, relative, &desired)?;
    }
    for relative in &plan.updated {
        write_desired_file(root, relative, &desired)?;
    }
    for relative in &plan.removed {
        let path = root.join(relative);
        match fs::remove_file(&path) {
            Ok(()) => prune_empty_managed_directories(root, path.parent()),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(install_io_error(
                    "remove stale managed skill file",
                    &path,
                    error,
                ))
            }
        }
    }

    atomic_write(&root.join(MANIFEST_FILE), &manifest_bytes)?;

    Ok(json!({
        "schemaVersion": 1,
        "ok": true,
        "action": "skills_install",
        "scope": scope_name(scope),
        "root": root.display().to_string(),
        "bundleVersion": env!("CARGO_PKG_VERSION"),
        "installed": plan.installed,
        "updated": plan.updated,
        "unchanged": plan.unchanged,
        "removed": plan.removed,
    }))
}

fn serialize_manifest(
    desired: &BTreeMap<String, &'static str>,
) -> std::result::Result<Vec<u8>, HostFailure> {
    let manifest = ManagedManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        owner: MANIFEST_OWNER.to_string(),
        bundle_version: env!("CARGO_PKG_VERSION").to_string(),
        files: desired
            .iter()
            .map(|(path, content)| (path.clone(), sha256(content.as_bytes())))
            .collect(),
    };
    let mut manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| {
        HostFailure::configuration(
            "skill_manifest_serialize_failed",
            format!("cannot serialize the managed skill manifest: {error}"),
        )
    })?;
    manifest_bytes.push(b'\n');
    Ok(manifest_bytes)
}

fn desired_files() -> BTreeMap<String, &'static str> {
    let mut files = BTreeMap::new();
    for skill in EMBEDDED_SKILLS {
        files.insert(format!("{}/SKILL.md", skill.name), skill.content);
        for (path, content) in skill.references {
            files.insert(format!("{}/{}", skill.name, path), *content);
        }
    }
    files
}

fn read_manifest(root: &Path) -> std::result::Result<Option<ManagedManifest>, HostFailure> {
    let path = root.join(MANIFEST_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(install_io_error("inspect skill manifest", &path, error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(conflict_failure([MANIFEST_FILE.to_string()]));
    }
    let bytes =
        fs::read(&path).map_err(|error| install_io_error("read skill manifest", &path, error))?;
    let manifest: ManagedManifest = serde_json::from_slice(&bytes)
        .map_err(|_| conflict_failure([MANIFEST_FILE.to_string()]))?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.owner != MANIFEST_OWNER
        || manifest.bundle_version.is_empty()
        || manifest
            .files
            .iter()
            .any(|(path, hash)| !is_managed_relative_path(path) || !is_sha256(hash))
    {
        return Err(conflict_failure([MANIFEST_FILE.to_string()]));
    }
    Ok(Some(manifest))
}

fn build_install_plan(
    root: &Path,
    desired: &BTreeMap<String, &'static str>,
    previous: Option<&ManagedManifest>,
) -> std::result::Result<InstallPlan, HostFailure> {
    let previous_files = previous.map(|manifest| &manifest.files);
    let empty = BTreeMap::new();
    let previous_files = previous_files.unwrap_or(&empty);
    let desired_hashes: BTreeMap<_, _> = desired
        .iter()
        .map(|(path, content)| (path.clone(), sha256(content.as_bytes())))
        .collect();
    let mut conflicts = BTreeSet::new();

    let known_paths: BTreeSet<_> = desired
        .keys()
        .chain(previous_files.keys())
        .cloned()
        .collect();
    let mut ignored_temporaries = BTreeSet::new();
    let mut interrupted_temporaries = Vec::new();
    for relative in desired.keys() {
        let temporary = temporary_path(&root.join(relative))?;
        if let Some(temporary) =
            inspect_interrupted_temporary(&temporary, &desired_hashes[relative])?
        {
            ignored_temporaries.insert(relative_path(root, &temporary));
            interrupted_temporaries.push(temporary);
        }
    }
    for existing in
        collect_existing_managed_files(root, &known_paths, &ignored_temporaries, &mut conflicts)?
    {
        if !known_paths.contains(&existing) {
            conflicts.insert(existing);
        }
    }

    let mut installed = Vec::new();
    let mut updated = Vec::new();
    let mut unchanged = Vec::new();
    let mut removed = Vec::new();

    for (relative, desired_hash) in &desired_hashes {
        let path = root.join(relative);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                let current = fs::read(&path)
                    .map_err(|error| install_io_error("read installed skill file", &path, error))?;
                let current_hash = sha256(&current);
                if &current_hash == desired_hash {
                    unchanged.push(relative.clone());
                } else if previous_files.get(relative) == Some(&current_hash) {
                    updated.push(relative.clone());
                } else {
                    conflicts.insert(relative.clone());
                }
            }
            Ok(_) => {
                conflicts.insert(relative.clone());
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if previous_files.contains_key(relative) {
                    conflicts.insert(relative.clone());
                } else {
                    installed.push(relative.clone());
                }
            }
            Err(error) => {
                return Err(install_io_error(
                    "inspect installed skill file",
                    &path,
                    error,
                ))
            }
        }
    }

    for (relative, previous_hash) in previous_files {
        if desired.contains_key(relative) {
            continue;
        }
        let path = root.join(relative);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                let current = fs::read(&path).map_err(|error| {
                    install_io_error("read stale managed skill file", &path, error)
                })?;
                if sha256(&current) == *previous_hash {
                    removed.push(relative.clone());
                } else {
                    conflicts.insert(relative.clone());
                }
            }
            Ok(_) => {
                conflicts.insert(relative.clone());
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                removed.push(relative.clone());
            }
            Err(error) => {
                return Err(install_io_error(
                    "inspect stale managed skill file",
                    &path,
                    error,
                ))
            }
        }
    }

    if !conflicts.is_empty() {
        return Err(conflict_failure(conflicts));
    }

    Ok(InstallPlan {
        installed,
        updated,
        unchanged,
        removed,
        interrupted_temporaries,
    })
}

fn collect_existing_managed_files(
    root: &Path,
    known_paths: &BTreeSet<String>,
    ignored_paths: &BTreeSet<String>,
    conflicts: &mut BTreeSet<String>,
) -> std::result::Result<BTreeSet<String>, HostFailure> {
    let mut skill_directories = BTreeSet::new();
    for path in known_paths {
        if let Some(directory) = path.split('/').next() {
            skill_directories.insert(directory.to_string());
        }
    }
    let mut files = BTreeSet::new();
    for directory in skill_directories {
        let absolute = root.join(&directory);
        let metadata = match fs::symlink_metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(install_io_error(
                    "inspect managed skill directory",
                    &absolute,
                    error,
                ))
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            conflicts.insert(directory);
            continue;
        }
        collect_directory_files(root, &absolute, ignored_paths, &mut files, conflicts)?;
    }
    Ok(files)
}

fn collect_directory_files(
    root: &Path,
    directory: &Path,
    ignored_paths: &BTreeSet<String>,
    files: &mut BTreeSet<String>,
    conflicts: &mut BTreeSet<String>,
) -> std::result::Result<(), HostFailure> {
    let entries = fs::read_dir(directory)
        .map_err(|error| install_io_error("read managed skill directory", directory, error))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| install_io_error("read managed skill entry", directory, error))?;
        let path = entry.path();
        let relative = relative_path(root, &path);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| install_io_error("inspect managed skill entry", &path, error))?;
        if ignored_paths.contains(&relative) {
            continue;
        } else if metadata.file_type().is_symlink() {
            conflicts.insert(relative);
        } else if metadata.is_dir() {
            collect_directory_files(root, &path, ignored_paths, files, conflicts)?;
        } else if metadata.is_file() {
            files.insert(relative);
        } else {
            conflicts.insert(relative);
        }
    }
    Ok(())
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn is_managed_relative_path(path: &str) -> bool {
    let path = Path::new(path);
    let components: Vec<_> = path.components().collect();
    if components.len() < 2
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return false;
    }
    let Some(directory) = components[0].as_os_str().to_str() else {
        return false;
    };
    directory == "cognia-host"
        || directory
            .strip_prefix("cognia-host-")
            .is_some_and(is_kebab_name)
}

fn is_kebab_name(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256(content: &[u8]) -> String {
    hex::encode(Sha256::digest(content))
}

fn write_desired_file(
    root: &Path,
    relative: &str,
    desired: &BTreeMap<String, &'static str>,
) -> std::result::Result<(), HostFailure> {
    let content = desired.get(relative).ok_or_else(|| {
        HostFailure::configuration(
            "skill_install_plan_invalid",
            "the skill install plan referenced a missing embedded file",
        )
    })?;
    atomic_write(&root.join(relative), content.as_bytes())
}

fn atomic_write(path: &Path, content: &[u8]) -> std::result::Result<(), HostFailure> {
    let parent = path.parent().ok_or_else(|| {
        HostFailure::configuration(
            "skill_install_path_invalid",
            format!("skill destination has no parent: {}", path.display()),
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| install_io_error("create skill directory", parent, error))?;
    let temporary = temporary_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| install_io_error("create temporary skill file", &temporary, error))?;
        file.write_all(content)
            .map_err(|error| install_io_error("write temporary skill file", &temporary, error))?;
        file.sync_all()
            .map_err(|error| install_io_error("sync temporary skill file", &temporary, error))?;
        drop(file);
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn replace_file(temporary: &Path, destination: &Path) -> std::result::Result<(), HostFailure> {
    replace_file_platform(temporary, destination)
        .map_err(|error| install_io_error("replace managed skill file", destination, error))
}

#[cfg(not(windows))]
fn replace_file_platform(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_file_platform(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        #[link_name = "MoveFileExW"]
        fn move_file_ex_w(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let temporary: Vec<u16> = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        move_file_ex_w(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn temporary_path(destination: &Path) -> std::result::Result<PathBuf, HostFailure> {
    let parent = destination.parent().ok_or_else(|| {
        HostFailure::configuration(
            "skill_install_path_invalid",
            format!("skill destination has no parent: {}", destination.display()),
        )
    })?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            HostFailure::configuration(
                "skill_install_path_invalid",
                format!(
                    "skill destination has no UTF-8 file name: {}",
                    destination.display()
                ),
            )
        })?;
    Ok(parent.join(format!(".{file_name}.cognia-tmp")))
}

fn inspect_interrupted_temporary(
    temporary: &Path,
    expected_hash: &str,
) -> std::result::Result<Option<PathBuf>, HostFailure> {
    match fs::symlink_metadata(temporary) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            let content = fs::read(temporary).map_err(|error| {
                install_io_error("read interrupted skill temporary", temporary, error)
            })?;
            if sha256(&content) == expected_hash {
                Ok(Some(temporary.to_path_buf()))
            } else {
                Err(conflict_failure([temporary.display().to_string()]))
            }
        }
        Ok(_) => Err(conflict_failure([temporary.display().to_string()])),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(install_io_error(
            "inspect interrupted skill temporary",
            temporary,
            error,
        )),
    }
}

fn prune_empty_managed_directories(root: &Path, mut directory: Option<&Path>) {
    while let Some(path) = directory {
        if path == root || fs::remove_dir(path).is_err() {
            break;
        }
        directory = path.parent();
    }
}

fn install_io_error(operation: &str, path: &Path, error: std::io::Error) -> HostFailure {
    HostFailure::configuration(
        "skill_install_io_failed",
        format!("{operation} at {} failed: {error}", path.display()),
    )
}

fn conflict_failure(conflicts: impl IntoIterator<Item = String>) -> HostFailure {
    let conflicts: Vec<_> = conflicts.into_iter().collect();
    HostFailure::validation(
        "skill_install_conflict",
        "managed Cognia skills differ from the last installed content; no files were written",
    )
    .with_details(json!({ "conflicts": conflicts }))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn write_manifest(root: &Path, files: BTreeMap<String, String>) {
        fs::create_dir_all(root).expect("skills root");
        let manifest = ManagedManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            owner: MANIFEST_OWNER.to_string(),
            bundle_version: "0.0.0-test".to_string(),
            files,
        };
        let content = serde_json::to_vec_pretty(&manifest).expect("manifest JSON");
        fs::write(root.join(MANIFEST_FILE), content).expect("manifest");
    }

    fn frontmatter_value<'a>(content: &'a str, key: &str) -> Option<&'a str> {
        let frontmatter = content.strip_prefix("---\n")?.split_once("\n---\n")?.0;
        frontmatter.lines().find_map(|line| {
            line.split_once(": ")
                .and_then(|(candidate, value)| (candidate == key).then_some(value))
        })
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn user_and_project_scopes_resolve_standard_agent_directories() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let repo = temp.path().join("repo");
        let nested = repo.join("packages/app");
        fs::create_dir_all(&repo).expect("repository");
        run_git(&repo, &["init", "--quiet"]);
        fs::create_dir_all(&nested).expect("nested cwd");

        assert_eq!(
            resolve_skills_root(HostSkillScope::User, &nested, Some(&home)).unwrap(),
            home.join(".agents/skills")
        );
        assert_eq!(
            resolve_skills_root(HostSkillScope::Project, &nested, Some(&home)).unwrap(),
            repo.canonicalize().unwrap().join(".agents/skills")
        );

        let worktree = temp.path().join("worktree");
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Cognia Test",
                "-c",
                "user.email=cognia@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "initial",
            ],
        );
        let worktree_path = worktree.to_string_lossy().into_owned();
        run_git(
            &repo,
            &["worktree", "add", "--quiet", "--detach", &worktree_path],
        );
        let worktree_nested = worktree.join("crates/cli");
        fs::create_dir_all(&worktree_nested).expect("worktree cwd");
        assert_eq!(
            resolve_skills_root(HostSkillScope::Project, &worktree_nested, Some(&home)).unwrap(),
            worktree.canonicalize().unwrap().join(".agents/skills")
        );

        let non_git = temp.path().join("scratch");
        fs::create_dir_all(&non_git).expect("non-git cwd");
        assert_eq!(
            resolve_skills_root(HostSkillScope::Project, &non_git, Some(&home)).unwrap(),
            non_git.join(".agents/skills")
        );
        let missing = temp.path().join("missing");
        let error =
            resolve_skills_root(HostSkillScope::Project, &missing, Some(&home)).unwrap_err();
        assert_eq!(error.code, "skill_install_git_discovery_failed");
        assert!(resolve_skills_root(HostSkillScope::User, &nested, None).is_err());
    }

    #[test]
    fn fresh_install_and_identical_reinstall_are_classified() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("skills");

        let fresh = install_at_root(HostSkillScope::Project, &root).expect("fresh install");
        assert_eq!(fresh["installed"].as_array().unwrap().len(), 17);
        assert_eq!(fresh["unchanged"].as_array().unwrap().len(), 0);

        let identical =
            install_at_root(HostSkillScope::Project, &root).expect("identical reinstall");
        assert_eq!(identical["installed"].as_array().unwrap().len(), 0);
        assert_eq!(identical["updated"].as_array().unwrap().len(), 0);
        assert_eq!(identical["unchanged"].as_array().unwrap().len(), 17);
        assert_eq!(identical["removed"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn managed_files_upgrade_and_retired_files_are_removed() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("skills");
        let old_core = root.join("cognia-host/SKILL.md");
        let retired = root.join("cognia-host-retired/SKILL.md");
        fs::create_dir_all(old_core.parent().unwrap()).expect("core dir");
        fs::create_dir_all(retired.parent().unwrap()).expect("retired dir");
        fs::write(&old_core, "old core\n").expect("old core");
        fs::write(&retired, "retired\n").expect("retired skill");
        write_manifest(
            &root,
            BTreeMap::from([
                ("cognia-host/SKILL.md".to_string(), sha256(b"old core\n")),
                (
                    "cognia-host-retired/SKILL.md".to_string(),
                    sha256(b"retired\n"),
                ),
            ]),
        );

        let output = install_at_root(HostSkillScope::Project, &root).expect("managed upgrade");
        assert!(output["updated"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path == "cognia-host/SKILL.md"));
        assert_eq!(output["removed"], json!(["cognia-host-retired/SKILL.md"]));
        assert_eq!(
            fs::read_to_string(old_core).unwrap(),
            EMBEDDED_SKILLS[0].content
        );
        assert!(!retired.exists());
    }

    #[test]
    fn unmanifested_matching_file_recovers_an_interrupted_install() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("skills");
        let core = root.join("cognia-host/SKILL.md");
        fs::create_dir_all(core.parent().unwrap()).expect("core dir");
        fs::write(&core, EMBEDDED_SKILLS[0].content).expect("partial install");

        let output = install_at_root(HostSkillScope::Project, &root).expect("recover install");
        assert!(output["unchanged"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path == "cognia-host/SKILL.md"));
        assert!(root.join(MANIFEST_FILE).is_file());
    }

    #[test]
    fn verified_interrupted_temporary_is_removed_only_after_successful_preflight() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("skills");
        install_at_root(HostSkillScope::Project, &root).expect("initial install");
        let temporary = temporary_path(&root.join("cognia-host/SKILL.md")).unwrap();
        fs::write(&temporary, EMBEDDED_SKILLS[0].content).expect("interrupted temporary");

        install_at_root(HostSkillScope::Project, &root).expect("recover temporary");
        assert!(!temporary.exists());

        fs::write(&temporary, EMBEDDED_SKILLS[0].content).expect("interrupted temporary");
        fs::write(root.join("cognia-host-agents/SKILL.md"), "user edit\n").expect("user edit");
        let error = install_at_root(HostSkillScope::Project, &root).unwrap_err();
        assert_eq!(error.code, "skill_install_conflict");
        assert!(temporary.is_file(), "conflict preflight must write nothing");

        fs::write(
            root.join("cognia-host-agents/SKILL.md"),
            EMBEDDED_SKILLS
                .iter()
                .find(|skill| skill.name == "cognia-host-agents")
                .unwrap()
                .content,
        )
        .expect("restore managed skill");
        fs::write(&temporary, "user-owned untracked file\n").expect("untracked temporary name");
        let error = install_at_root(HostSkillScope::Project, &root).unwrap_err();
        assert_eq!(error.code, "skill_install_conflict");
        assert_eq!(
            fs::read_to_string(&temporary).unwrap(),
            "user-owned untracked file\n"
        );
    }

    #[test]
    fn corrupt_manifest_and_user_changes_are_conflicts() {
        let temp = tempfile::tempdir().expect("temp dir");
        let corrupt_root = temp.path().join("corrupt");
        fs::create_dir_all(&corrupt_root).expect("corrupt root");
        fs::write(corrupt_root.join(MANIFEST_FILE), b"not-json").expect("corrupt manifest");
        let error = install_at_root(HostSkillScope::Project, &corrupt_root).unwrap_err();
        assert_eq!(error.code, "skill_install_conflict");

        let modified_root = temp.path().join("modified");
        install_at_root(HostSkillScope::Project, &modified_root).expect("initial install");
        fs::write(modified_root.join("cognia-host/SKILL.md"), "user edit\n").expect("user edit");
        let error = install_at_root(HostSkillScope::Project, &modified_root).unwrap_err();
        assert_eq!(error.code, "skill_install_conflict");
        assert_eq!(error.details["conflicts"], json!(["cognia-host/SKILL.md"]));
    }

    #[test]
    fn untracked_file_inside_a_managed_skill_is_a_conflict() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("skills");
        install_at_root(HostSkillScope::Project, &root).expect("initial install");
        let untracked = root.join("cognia-host/references/local-notes.md");
        fs::write(&untracked, "user notes\n").expect("untracked file");

        let error = install_at_root(HostSkillScope::Project, &root).unwrap_err();
        assert_eq!(error.code, "skill_install_conflict");
        assert_eq!(
            error.details["conflicts"],
            json!(["cognia-host/references/local-notes.md"])
        );
        assert_eq!(fs::read_to_string(untracked).unwrap(), "user notes\n");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_managed_directory_is_a_conflict() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("skills");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).expect("skills root");
        fs::create_dir_all(&outside).expect("outside dir");
        symlink(&outside, root.join("cognia-host")).expect("managed symlink");

        let error = install_at_root(HostSkillScope::Project, &root).unwrap_err();
        assert_eq!(error.code, "skill_install_conflict");
        assert!(outside.read_dir().unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_skills_root_or_agents_parent_is_a_conflict() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let outside_root = temp.path().join("outside-root");
        let root_link = temp.path().join("skills-link");
        fs::create_dir_all(&outside_root).expect("outside root");
        symlink(&outside_root, &root_link).expect("root symlink");
        let error = install_at_root(HostSkillScope::Project, &root_link).unwrap_err();
        assert_eq!(error.code, "skill_install_conflict");
        assert!(outside_root.read_dir().unwrap().next().is_none());

        let scope = temp.path().join("scope");
        let outside_agents = temp.path().join("outside-agents");
        fs::create_dir_all(&scope).expect("scope");
        fs::create_dir_all(&outside_agents).expect("outside agents");
        symlink(&outside_agents, scope.join(".agents")).expect("agents symlink");
        let error =
            install_at_root(HostSkillScope::Project, &scope.join(".agents/skills")).unwrap_err();
        assert_eq!(error.code, "skill_install_conflict");
        assert!(outside_agents.read_dir().unwrap().next().is_none());
    }

    #[test]
    fn embedded_skills_have_standard_metadata_and_routing_boundaries() {
        let mut names = HashSet::new();
        let desired = desired_files();
        for skill in EMBEDDED_SKILLS {
            assert!(names.insert(skill.name), "duplicate skill: {}", skill.name);
            assert!(
                is_kebab_name(skill.name),
                "invalid skill name: {}",
                skill.name
            );
            assert_eq!(frontmatter_value(skill.content, "name"), Some(skill.name));
            assert!(
                desired.contains_key(&format!("{}/SKILL.md", skill.name)),
                "directory/name parity: {}",
                skill.name
            );
            let description = frontmatter_value(skill.content, "description")
                .unwrap_or_else(|| panic!("description: {}", skill.name));
            assert_eq!(
                embedded_skill_description(skill).unwrap(),
                description,
                "list metadata drift: {}",
                skill.name
            );
            assert_eq!(
                frontmatter_value(skill.content, "license"),
                Some("AGPL-3.0-or-later"),
                "license: {}",
                skill.name
            );
            assert_eq!(
                frontmatter_value(skill.content, "compatibility"),
                Some("Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint."),
                "compatibility: {}",
                skill.name
            );
            assert!((1..=1024).contains(&description.len()));
            let first_sentence = description
                .split_once('.')
                .map_or(description, |(sentence, _)| sentence);
            assert!(
                first_sentence.starts_with("Use when"),
                "first-sentence positive trigger: {}",
                skill.name
            );
            assert!(
                first_sentence.contains("; do not use when"),
                "first-sentence negative trigger: {}",
                skill.name
            );
            if skill.kind != "core" {
                assert!(
                    skill
                        .content
                        .contains("`cognia host skills read cognia-host`"),
                    "core prerequisite: {}",
                    skill.name
                );
            }
            let references: BTreeSet<_> = skill.references.iter().map(|(path, _)| *path).collect();
            if skill.name == "cognia-host" {
                assert_eq!(
                    references,
                    BTreeSet::from(["references/output-contract.md"])
                );
            } else {
                assert!(
                    references.is_empty(),
                    "unexpected reference: {}",
                    skill.name
                );
            }
            assert!(!skill.content.contains("allowed-tools:"));
            assert!(!skill.content.contains("agents/openai.yaml"));
        }
        assert_eq!(names.len(), 16);
    }
}
