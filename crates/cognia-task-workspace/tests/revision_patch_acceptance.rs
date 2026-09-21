//! Acceptance-level proofs for the delegate's workspace contract
//! (ADR-0188 B4), driven through the crate's public API rather than its
//! internals, and over a **real Git worktree** — the shape every delegate
//! delivery actually meets, and the one where a revision is a Git blob id
//! rather than a SHA-256 of the bytes.
//!
//! * [ACC:DEL-04] a patch whose `base_revision` does not match the target is
//!   a compare-and-swap conflict, and every file is byte-identical after it.
//! * [ACC:DEL-05] `..`, absolute paths and symlinks are refused for both the
//!   apply and the read, and the host file behind a link keeps its bytes.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use cognia_task_workspace::{
    apply_revision_patch, list_revision_files, read_confined_text, read_report_file,
    workspace_revision, ConfinedReadStatus, RevisionApplyStatus, RevisionPatch,
    RevisionPatchAction, RevisionPatchFile, WorkspaceRefusalCode, REVISION_PATCH_FORMAT,
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn git_workspace() -> TempDir {
    use git2::{IndexAddOption, Repository, Signature};

    let dir = TempDir::new().expect("a temporary directory");
    let root = dir.path();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/a.ts"), "export const a = 1\n").unwrap();
    fs::write(root.join("src/b.ts"), "export const b = 2\n").unwrap();
    fs::write(root.join("README.md"), "# fixture\n").unwrap();
    fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
    fs::create_dir_all(root.join("ignored")).unwrap();
    fs::write(root.join("ignored/cache.bin"), "cache").unwrap();

    let repository = Repository::init(root).unwrap();
    let mut index = repository.index().unwrap();
    index.add_all(["."], IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
    let signature = Signature::now("Delegate Test", "delegate@example.com").unwrap();
    repository
        .commit(Some("HEAD"), &signature, &signature, "seed", &tree, &[])
        .unwrap();
    dir
}

fn write(path: &str, content: &str) -> RevisionPatchFile {
    RevisionPatchFile {
        path: path.to_string(),
        action: RevisionPatchAction::Write,
        content: Some(content.to_string()),
        content_sha256: Some(hex::encode(Sha256::digest(content.as_bytes()))),
    }
}

fn delete(path: &str) -> RevisionPatchFile {
    RevisionPatchFile {
        path: path.to_string(),
        action: RevisionPatchAction::Delete,
        content: None,
        content_sha256: None,
    }
}

fn patch(base: &str, files: Vec<RevisionPatchFile>) -> RevisionPatch {
    RevisionPatch {
        format: REVISION_PATCH_FORMAT.to_string(),
        base_revision: base.to_string(),
        files,
    }
}

/// Every file under the root, including the ignored ones this fixture keeps
/// deliberately: an apply that touched one would be invisible to the
/// revision, so the byte-for-byte assertion has to see them.
fn tree(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory).unwrap().flatten() {
            let path = entry.path();
            if path.file_name().is_some_and(|name| name == ".git") {
                continue;
            }
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                stack.push(path);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                let content = if kind.is_symlink() {
                    format!("symlink:{}", fs::read_link(&path).unwrap().display())
                } else {
                    fs::read_to_string(&path).unwrap_or_default()
                };
                out.insert(relative, content);
            }
        }
    }
    out
}

#[test]
fn a_git_workspace_has_a_revision_that_tracks_its_content() {
    let dir = git_workspace();
    let first = workspace_revision(dir.path()).unwrap();
    assert!(first.revision.starts_with("wsrev1:"));
    // `.gitignore`, README and the two sources; the ignored file is not
    // covered, which is exactly why a patch may not overwrite one.
    assert_eq!(first.file_count, 4);

    fs::write(dir.path().join("ignored/cache.bin"), "different").unwrap();
    assert_eq!(
        workspace_revision(dir.path()).unwrap().revision,
        first.revision,
        "an ignored file is not part of the revision"
    );

    fs::write(dir.path().join("src/a.ts"), "export const a = 99\n").unwrap();
    assert_ne!(
        workspace_revision(dir.path()).unwrap().revision,
        first.revision
    );
}

#[test]
fn an_uncommitted_edit_and_its_commit_are_the_same_revision() {
    use git2::{IndexAddOption, Repository, Signature};

    let dir = git_workspace();
    fs::write(dir.path().join("src/a.ts"), "export const a = 3\n").unwrap();
    let dirty = workspace_revision(dir.path()).unwrap().revision;

    let repository = Repository::open(dir.path()).unwrap();
    let mut index = repository.index().unwrap();
    index.add_all(["."], IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repository.find_tree(tree_id).unwrap();
    let signature = Signature::now("Delegate Test", "delegate@example.com").unwrap();
    let parent = repository.head().unwrap().peel_to_commit().unwrap();
    repository
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            "edit",
            &tree,
            &[&parent],
        )
        .unwrap();

    assert_eq!(
        workspace_revision(dir.path()).unwrap().revision,
        dirty,
        "committing bytes that did not change must not move the revision"
    );
}

#[test]
fn an_approved_patch_applies_as_one_step_and_names_the_new_revision() {
    let dir = git_workspace();
    let base = workspace_revision(dir.path()).unwrap().revision;

    let outcome = apply_revision_patch(
        dir.path(),
        &patch(
            &base,
            vec![
                write("src/a.ts", "export const a = 42\n"),
                write("src/added/c.ts", "export const c = 3\n"),
                delete("src/b.ts"),
            ],
        ),
    )
    .unwrap();

    assert_eq!(outcome.status, RevisionApplyStatus::Applied);
    assert_eq!(outcome.base_revision, base);
    assert_eq!(outcome.written, vec!["src/a.ts", "src/added/c.ts"]);
    assert_eq!(outcome.deleted, vec!["src/b.ts"]);
    assert_eq!(
        outcome.current_revision,
        Some(workspace_revision(dir.path()).unwrap().revision)
    );
    assert_ne!(outcome.current_revision.as_deref(), Some(base.as_str()));
    assert_eq!(
        fs::read_to_string(dir.path().join("src/a.ts")).unwrap(),
        "export const a = 42\n"
    );
    assert!(!dir.path().join("src/b.ts").exists());
}

/// [ACC:DEL-04] The workspace moved after the patch was cut: the apply is a
/// CAS conflict, nothing is written, and every file — including the ones the
/// patch names — is byte-identical.
#[test]
fn a_patch_cut_from_another_revision_conflicts_and_writes_nothing() {
    let dir = git_workspace();
    let base = workspace_revision(dir.path()).unwrap().revision;
    fs::write(
        dir.path().join("README.md"),
        "# fixture, edited by a person\n",
    )
    .unwrap();
    let before = tree(dir.path());

    let outcome = apply_revision_patch(
        dir.path(),
        &patch(
            &base,
            vec![
                write("src/a.ts", "export const a = 42\n"),
                write("src/added/c.ts", "export const c = 3\n"),
                delete("src/b.ts"),
            ],
        ),
    )
    .unwrap();

    assert_eq!(outcome.status, RevisionApplyStatus::Conflict);
    assert_eq!(outcome.base_revision, base);
    assert_eq!(
        outcome.current_revision,
        Some(workspace_revision(dir.path()).unwrap().revision)
    );
    assert!(outcome.written.is_empty());
    assert!(outcome.deleted.is_empty());
    assert!(outcome.refusal.is_none());
    assert_eq!(tree(dir.path()), before, "the workspace must be untouched");
    assert!(!dir.path().join("src/added").exists());
}

/// [ACC:DEL-04] A second delivery of the same patch, after the first one
/// applied, is a conflict rather than a re-apply: the base it names is no
/// longer where the workspace is.
#[test]
fn replaying_an_applied_patch_conflicts_instead_of_applying_twice() {
    let dir = git_workspace();
    let base = workspace_revision(dir.path()).unwrap().revision;
    let delivery = patch(&base, vec![write("src/a.ts", "export const a = 42\n")]);

    assert_eq!(
        apply_revision_patch(dir.path(), &delivery).unwrap().status,
        RevisionApplyStatus::Applied
    );
    let after = tree(dir.path());

    let replay = apply_revision_patch(dir.path(), &delivery).unwrap();
    assert_eq!(replay.status, RevisionApplyStatus::Conflict);
    assert_eq!(tree(dir.path()), after);
}

/// [ACC:DEL-04] A file the revision does not cover cannot be
/// compare-and-swapped, so overwriting an existing ignored file is refused
/// rather than written under a guarantee that does not hold.
#[test]
fn an_ignored_file_is_refused_rather_than_silently_overwritten() {
    let dir = git_workspace();
    let base = workspace_revision(dir.path()).unwrap().revision;

    let outcome = apply_revision_patch(
        dir.path(),
        &patch(&base, vec![write("ignored/cache.bin", "owned")]),
    )
    .unwrap();

    assert_eq!(outcome.status, RevisionApplyStatus::Refused);
    assert_eq!(
        outcome.refusal.map(|refusal| refusal.code),
        Some(WorkspaceRefusalCode::PathNotCovered)
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("ignored/cache.bin")).unwrap(),
        "cache"
    );
}

/// [ACC:DEL-05] Directory traversal and host paths are refused by the apply,
/// and nothing is written anywhere.
#[test]
fn traversal_and_absolute_paths_are_refused_by_the_apply() {
    let dir = git_workspace();
    let outside = TempDir::new().unwrap();
    let secret = outside.path().join("credentials");
    fs::write(&secret, "host secret").unwrap();
    let base = workspace_revision(dir.path()).unwrap().revision;
    let before = tree(dir.path());

    let escapes = format!(
        "../{}/credentials",
        outside.path().file_name().unwrap().to_string_lossy()
    );
    for (file, code) in [
        (
            write(&escapes, "owned"),
            WorkspaceRefusalCode::PathTraversal,
        ),
        (
            write(&secret.to_string_lossy(), "owned"),
            WorkspaceRefusalCode::PathAbsolute,
        ),
        (
            write("src/../../escaped.txt", "owned"),
            WorkspaceRefusalCode::PathTraversal,
        ),
    ] {
        let outcome = apply_revision_patch(dir.path(), &patch(&base, vec![file.clone()])).unwrap();
        assert_eq!(
            outcome.status,
            RevisionApplyStatus::Refused,
            "{}",
            file.path
        );
        assert_eq!(
            outcome.refusal.as_ref().map(|refusal| refusal.code),
            Some(code),
            "{}",
            file.path
        );
    }

    assert_eq!(fs::read_to_string(&secret).unwrap(), "host secret");
    assert_eq!(tree(dir.path()), before);
}

/// [ACC:DEL-05] A symlink planted in the worktree — the shape a sandboxed
/// command can leave behind — is refused for the apply, for a read, and for
/// the acceptance report, and the host file keeps its bytes.
#[cfg(unix)]
#[test]
fn a_planted_symlink_is_refused_for_apply_read_and_report() {
    let dir = git_workspace();
    let outside = TempDir::new().unwrap();
    let secret = outside.path().join("credentials");
    fs::write(&secret, "host secret").unwrap();
    std::os::unix::fs::symlink(&secret, dir.path().join("report.xml")).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("out")).unwrap();
    let base = format!("wsrev1:{}", "0".repeat(64));

    let applied =
        apply_revision_patch(dir.path(), &patch(&base, vec![write("out/planted", "x")])).unwrap();
    assert_eq!(
        applied.refusal.map(|refusal| refusal.code),
        Some(WorkspaceRefusalCode::PathSymlink)
    );

    let read = read_confined_text(dir.path(), "report.xml", None).unwrap();
    assert_eq!(read.status, ConfinedReadStatus::Refused);
    assert_eq!(
        read.refusal.map(|refusal| refusal.code),
        Some(WorkspaceRefusalCode::PathSymlink)
    );

    let report = read_report_file(dir.path(), "report.xml", None).unwrap();
    assert_eq!(report.status, ConfinedReadStatus::Refused);
    assert_eq!(report.content, None);

    let through_link = read_confined_text(dir.path(), "out/credentials", None).unwrap();
    assert_eq!(through_link.status, ConfinedReadStatus::Refused);

    assert_eq!(fs::read_to_string(&secret).unwrap(), "host secret");
    assert!(!outside.path().join("planted").exists());
}

/// The report extraction a sandboxed acceptance run depends on: the declared
/// file is copied out of the worktree, bounded, and a run that wrote none is
/// `missing` rather than an error.
#[test]
fn an_acceptance_report_is_copied_out_of_the_worktree_within_its_cap() {
    let dir = git_workspace();
    fs::create_dir_all(dir.path().join("reports")).unwrap();
    let junit = "<testsuite tests=\"2\" failures=\"0\"/>";
    fs::write(dir.path().join("reports/junit.xml"), junit).unwrap();

    let report = read_report_file(dir.path(), "reports/junit.xml", None).unwrap();
    assert_eq!(report.status, ConfinedReadStatus::Ok);
    assert_eq!(report.content.as_deref(), Some(junit));
    assert_eq!(
        report.content_sha256,
        Some(hex::encode(Sha256::digest(junit.as_bytes())))
    );

    let capped = read_report_file(dir.path(), "reports/junit.xml", Some(8)).unwrap();
    assert_eq!(capped.status, ConfinedReadStatus::TooLarge);
    assert_eq!(capped.content, None);

    let absent = read_report_file(dir.path(), "reports/none.json", None).unwrap();
    assert_eq!(absent.status, ConfinedReadStatus::Missing);
}

#[test]
fn a_listing_answers_with_the_revision_it_was_taken_at() {
    let dir = git_workspace();
    let listing = list_revision_files(dir.path(), "src", None).unwrap();
    assert_eq!(
        listing
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec!["src/a.ts", "src/b.ts"]
    );
    assert_eq!(
        listing.revision,
        workspace_revision(dir.path()).unwrap().revision
    );
}
