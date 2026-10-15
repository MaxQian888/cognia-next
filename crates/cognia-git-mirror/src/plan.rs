//! One bare, blobless mirror per remote, shared by every clone this app makes.
//!
//! # What it is for
//!
//! A repository the app clones on the user's behalf — an issue loop firing
//! again on the same project, a plugin workspace, a sandbox — pays a full
//! network clone every time. The mirror pays it once: the first call clones
//! `--bare --filter=blob:none`, and every later one clones from the local
//! directory and re-points `origin` at the real remote.
//!
//! # What it is NOT for
//!
//! It does not speed up the local per-task workspace. `create_execution` runs
//! `git worktree add` directly against the user's own repository, so that path
//! never cloned in the first place — measuring before optimising is what said
//! so, and the number that mattered there was the snapshot, not the clone.
//!
//! # Why not `--reference`
//!
//! Alternates make the borrower depend on the lender staying intact, and git's
//! own documentation is blunt about it: gc in the reference repository can
//! leave the clone corrupt. A mirror we refresh on a schedule is exactly the
//! repository that would be gc'd. Cloning from it copies what is needed and
//! then the two are independent.
//!
//! # Why `--no-hardlinks`
//!
//! A local clone hardlinks pack files by default, which is faster still and
//! shares inodes between the mirror and the clone. Several of these clones are
//! handed to an agent with shell access, on a path whose instructions come from
//! an issue body anyone can file. One `>` into a shared pack file would corrupt
//! the mirror for every other repository user. The copy is the price of not
//! sharing a mutable inode with an untrusted process.
//!
//! # Maintenance without touching the user's git
//!
//! `git maintenance register` writes the repository into the user's GLOBAL
//! config and schedules background jobs against it. These are our directories,
//! not the user's, and a cache should not install itself into a machine-wide
//! schedule. The commit-graph and multi-pack-index are written directly
//! instead — same benefit for `merge-base` and ancestry walks, no global state.
//!
//! # A blobless mirror serves file contents only once asked for them
//!
//! The mirror holds commits and trees, and file contents only for what someone
//! has already asked for. A checkout derived from it is a partial clone whose
//! promisor is the mirror, so it fetches contents from the mirror on demand,
//! and the mirror can only answer with contents it holds: it does not reach its
//! own remote on another clone's behalf (git refuses lazy fetches inside
//! `upload-pack`, and the credential is never stored anyway).
//!
//! So before a checkout of a commit, [`materialize_args`] has the mirror fetch
//! that commit's file contents from the real remote, with the credential, in
//! one batch. Two more things make the hand-over work, both learned against
//! GitHub rather than a local test remote, which serves every blob:
//!
//! - The derive goes through a `file://` URL ([`file_url`]). Git ignores
//!   `--filter` for a plain path, copies the objects it finds, and leaves a
//!   checkout that is missing contents without knowing it is partial.
//! - The mirror allows filters and requests by object id
//!   ([`serve_config_commands`]), which is how a partial clone asks for the
//!   contents it lacks.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

/// How long a mirror's fetch is considered fresh.
///
/// A clone from a mirror last fetched inside this window skips the network
/// entirely. Chosen for the shape of the work: an issue loop dispatching four
/// issues against one repository within a minute should fetch once.
pub const DEFAULT_MIRROR_TTL: Duration = Duration::from_secs(300);

/// Marker holding the last successful fetch time, beside the bare repository.
const FETCH_STAMP: &str = "cognia-fetched-at";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MirrorError {
    /// The URL is not one this cache will key on.
    InvalidRemote(String),
    Io(String),
    Git(String),
}

impl std::fmt::Display for MirrorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MirrorError::InvalidRemote(detail) => write!(f, "invalid remote: {detail}"),
            MirrorError::Io(detail) => write!(f, "{detail}"),
            MirrorError::Git(detail) => write!(f, "{detail}"),
        }
    }
}

/// A remote URL reduced to the identity two URLs share when they name one
/// repository.
///
/// `https://github.com/o/r`, `https://github.com/o/r.git`,
/// `git@github.com:o/r.git` and `ssh://git@github.com/o/r` are one repository
/// and must be one mirror; keying on the raw string would cache the same
/// repository up to four times and fetch each of them separately.
///
/// Any credential in the URL is dropped rather than hashed: two users of one
/// repository share a mirror, and a token must not become part of a cache key
/// that is then a directory name on disk.
pub fn normalize_remote_url(raw: &str) -> Result<String, MirrorError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(MirrorError::InvalidRemote("empty".into()));
    }
    if trimmed.starts_with('-') {
        return Err(MirrorError::InvalidRemote(
            "may not begin with '-'".to_string(),
        ));
    }

    // `file:///path/to/repo` — the host is empty and the path is the whole
    // identity. Kept because this is a keying function, not a policy: whether a
    // local remote is worth mirroring is the caller's judgement, and the
    // callers that matter only ever produce `https://` (see
    // `canonical_github_remote`). Refusing it here would only mean the flow
    // cannot be exercised without a network.
    if let Some(rest) = trimmed.strip_prefix("file://") {
        let path = rest.trim_end_matches('/').trim_end_matches(".git");
        if path.is_empty() || path == "/" {
            return Err(MirrorError::InvalidRemote(format!("no path in {trimmed}")));
        }
        // The `//` is load-bearing: a host-keyed identity is `host/path` and
        // can never contain one, so `file:///srv/x` cannot collide with a
        // repository served by a host literally called `file`.
        return Ok(format!("file://{}", path.trim_start_matches('/')));
    }

    // `git@host:owner/repo` — scp-like syntax, no scheme.
    let without_scheme = if let Some(rest) = trimmed.strip_prefix("https://") {
        rest.to_string()
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        rest.to_string()
    } else if let Some(rest) = trimmed.strip_prefix("ssh://") {
        rest.to_string()
    } else if let Some(rest) = trimmed.strip_prefix("git://") {
        rest.to_string()
    } else if trimmed.contains("://") {
        return Err(MirrorError::InvalidRemote(format!(
            "unsupported scheme in {trimmed}"
        )));
    } else {
        // scp-like: turn the single `:` after the host into a `/`.
        match trimmed.split_once(':') {
            Some((host, path)) if !path.starts_with('/') => format!("{host}/{path}"),
            _ => trimmed.to_string(),
        }
    };

    // Drop any `user[:token]@` — never part of the identity, never on disk.
    let without_credentials = match without_scheme.split_once('@') {
        Some((_, rest)) => rest.to_string(),
        None => without_scheme,
    };

    let (authority, path) = match without_credentials.split_once('/') {
        Some((authority, path)) => (authority, path),
        None => {
            return Err(MirrorError::InvalidRemote(format!(
                "no repository path in {trimmed}"
            )))
        }
    };
    // Host is case-insensitive; the path is not (GitHub folds it, most hosts
    // do not, and folding it here would merge two real repositories).
    let host = authority
        .split(':')
        .next()
        .unwrap_or(authority)
        .to_ascii_lowercase();
    if host.is_empty() {
        return Err(MirrorError::InvalidRemote(format!("no host in {trimmed}")));
    }
    let path = path
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches('/');
    if path.is_empty() {
        return Err(MirrorError::InvalidRemote(format!(
            "no repository path in {trimmed}"
        )));
    }
    Ok(format!("{host}/{path}"))
}

/// A readable, filesystem-safe fragment of the repository path.
///
/// Only for a human reading `ls`: the hash below is what makes the directory
/// unique, so this may collide freely.
fn slug(normalized: &str) -> String {
    let tail: String = normalized
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = tail.trim_matches('-');
    let short: String = trimmed
        .chars()
        .rev()
        .take(40)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if short.is_empty() {
        "repo".to_string()
    } else {
        short
    }
}

/// Where a remote's mirror lives under `root`.
///
/// The hash is the identity; the slug is only there so the directory listing
/// is readable. A raw path fragment as the directory name would let a
/// repository called `../../etc` escape the cache root.
pub fn mirror_path(root: &Path, remote_url: &str) -> Result<PathBuf, MirrorError> {
    Ok(root.join(format!("{}.git", dir_stem(remote_url)?)))
}

/// Where a *derived checkout* for `remote_url` lives under `root`.
///
/// The same stem as [`mirror_path`] without the bare-repository `.git` suffix,
/// so one repository is one directory name in both trees and a person reading
/// `sources/` and `mirrors/` can pair them by eye. Two spellings of one remote
/// share a checkout for the same reason they share a mirror: the stem is
/// derived from the normalised URL, not from what the caller typed.
pub fn checkout_path(root: &Path, remote_url: &str) -> Result<PathBuf, MirrorError> {
    Ok(root.join(dir_stem(remote_url)?))
}

/// `<slug>-<digest>` for a remote. The digest is what keeps two repositories
/// whose names end the same from colliding once the slug has been truncated.
fn dir_stem(remote_url: &str) -> Result<String, MirrorError> {
    let normalized = normalize_remote_url(remote_url)?;
    let digest = Sha256::digest(normalized.as_bytes());
    let hash = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{}-{hash}", slug(&normalized)))
}

/// Whether a mirror's last fetch is still inside `ttl`.
///
/// A missing or unreadable stamp means "fetch": treating an unknown age as
/// fresh is how a cache serves a week-old branch list.
pub fn is_fresh(mirror: &Path, ttl: Duration, now: SystemTime) -> bool {
    let stamp = mirror.join(FETCH_STAMP);
    let Ok(metadata) = std::fs::metadata(&stamp) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    match now.duration_since(modified) {
        Ok(age) => age < ttl,
        // Stamped in the future — a clock change, not freshness.
        Err(_) => false,
    }
}

/// Record a successful fetch.
pub fn stamp_fetch(mirror: &Path) -> Result<(), MirrorError> {
    std::fs::write(mirror.join(FETCH_STAMP), b"")
        .map_err(|error| MirrorError::Io(format!("stamp mirror fetch: {error}")))
}

/// Whether `dir` holds a usable bare repository.
pub fn is_mirror(dir: &Path) -> bool {
    dir.join("HEAD").is_file() && dir.join("objects").is_dir()
}

/// `git clone` arguments that create the mirror.
///
/// `--mirror` rather than `--bare`: it maps every remote ref into the clone and
/// configures the refspec so a later `git fetch` keeps them all, which is what
/// makes one directory serve every branch anyone asks for. Blobless because
/// nothing reads historical file contents through this cache, and because a
/// blobless mirror of a large repository is a fraction of the size — while
/// keeping the full commit graph, which is what ancestry checks walk.
pub fn clone_args(remote_url: &str, destination: &Path) -> Vec<String> {
    vec![
        "clone".to_string(),
        "--mirror".to_string(),
        "--filter=blob:none".to_string(),
        "--".to_string(),
        remote_url.to_string(),
        destination.to_string_lossy().into_owned(),
    ]
}

/// `git fetch` arguments that refresh it.
///
/// `extra_refspecs` exists because a `--mirror` clone copies the remote's
/// advertised refs, and GitHub does not advertise `refs/pull/*`. A caller that
/// needs to resolve a pull-request base has to name the refspec itself
/// (`refs/pull/<n>/head:refs/pull/<n>/head`); asking for it here, on the
/// mirror, is what lets the derived checkout resolve it without reaching the
/// network a second time. An empty slice is the ordinary refresh.
pub fn fetch_args(extra_refspecs: &[String]) -> Vec<String> {
    let mut args = vec![
        "fetch".to_string(),
        "--prune".to_string(),
        // A branch deleted upstream and recreated at an unrelated commit
        // otherwise fails to update; the mirror then serves a ref the remote
        // no longer has.
        "--prune-tags".to_string(),
        "--filter=blob:none".to_string(),
        "origin".to_string(),
    ];
    args.extend(extra_refspecs.iter().cloned());
    args
}

/// `git clone` arguments that derive a working checkout from the mirror.
///
/// `--no-hardlinks` is not an optimisation left on the table — see the module
/// header. `--reference` is not used for the same reason the mirror is not an
/// alternate: this directory is one we gc. The mirror is named by a `file://`
/// URL so `--filter` holds and the checkout knows it is a partial clone of the
/// mirror (see the module header).
pub fn derive_args(mirror: &Path, destination: &Path, branch: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "clone".to_string(),
        "--no-hardlinks".to_string(),
        "--filter=blob:none".to_string(),
    ];
    if let Some(branch) = branch {
        args.push("--branch".to_string());
        args.push(branch.to_string());
        args.push("--single-branch".to_string());
    }
    args.push("--".to_string());
    args.push(file_url(mirror));
    args.push(destination.to_string_lossy().into_owned());
    args
}

/// A `file://` URL for a local repository. Git percent-decodes these, so every
/// byte outside the unreserved set and `/` is encoded: a literal `%` in a path
/// would otherwise be read as an escape.
pub fn file_url(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut url = String::with_capacity(raw.len() + 8);
    url.push_str("file://");
    if !raw.starts_with('/') {
        url.push('/');
    }
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                url.push(byte as char)
            }
            _ => url.push_str(&format!("%{byte:02X}")),
        }
    }
    url
}

/// `git config` arguments that let a mirror answer a partial clone: filtered
/// fetches, and requests for one object by id (how a partial clone asks for
/// contents it lacks). Local settings on our own cache directory only.
pub fn serve_config_commands() -> Vec<Vec<String>> {
    [
        ("uploadpack.allowFilter", "true"),
        ("uploadpack.allowAnySHA1InWant", "true"),
    ]
    .into_iter()
    .map(|(key, value)| vec!["config".to_string(), key.to_string(), value.to_string()])
    .collect()
}

/// `git` arguments that write `commit`'s tree into `work_tree` from the mirror
/// at `mirror`, which makes the mirror fetch every file content of that commit
/// it lacks, in one batch. Run with `GIT_INDEX_FILE` pointing outside the
/// mirror: a bare repository has no index of its own to disturb. `read-tree`
/// rather than `checkout`, because it also takes a commit with an empty tree.
pub fn materialize_args(mirror: &Path, work_tree: &Path, commit: &str) -> Vec<String> {
    vec![
        format!("--git-dir={}", mirror.to_string_lossy()),
        format!("--work-tree={}", work_tree.to_string_lossy()),
        "read-tree".to_string(),
        "--reset".to_string(),
        "-u".to_string(),
        commit.to_string(),
    ]
}

/// Commands that keep a mirror cheap to read, in order.
///
/// The commit-graph is the one that matters for stacks: `merge-base
/// --is-ancestor`, which every layer of every validate runs, walks the graph
/// and a written graph turns that walk into a lookup. The multi-pack-index
/// keeps object lookup one step after many incremental fetches.
///
/// Deliberately NOT `git maintenance register` — see the module header.
pub fn maintenance_commands() -> Vec<Vec<String>> {
    vec![
        vec![
            "commit-graph".to_string(),
            "write".to_string(),
            "--reachable".to_string(),
            "--split".to_string(),
        ],
        vec!["multi-pack-index".to_string(), "write".to_string()],
    ]
}

/// Commands that keep a SOURCE repository cheap to query (ADR-0227 §6).
///
/// The repositories agents work in are the user's, not ours, so this is the
/// smallest write that pays: a split commit-graph with changed-path Bloom
/// filters, which turns `log -- <path>`, merge-base and ancestry walks into
/// lookups. It is a cache file under `objects/info/` that `git gc` writes
/// itself (`gc.writeCommitGraph` defaults on); no config is touched, no
/// multi-pack-index is added, no schedule is registered.
pub fn source_maintenance_commands() -> Vec<Vec<String>> {
    vec![vec![
        "commit-graph".to_string(),
        "write".to_string(),
        "--reachable".to_string(),
        "--split".to_string(),
        "--changed-paths".to_string(),
    ]]
}

/// Mirrors under `root` whose last fetch is older than `max_age`, oldest first.
///
/// Age, not size: a mirror nobody has asked for in a month is the one to drop,
/// and dropping the biggest instead evicts the repository someone is most
/// likely working in. A mirror with no stamp at all is treated as ancient —
/// it is either a failed first clone or a directory from an older layout, and
/// both are garbage.
pub fn reclaim_candidates(root: &Path, max_age: Duration, now: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut aged: Vec<(Duration, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !is_mirror(&path) {
            continue;
        }
        let age = std::fs::metadata(path.join(FETCH_STAMP))
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .unwrap_or(Duration::MAX);
        if age >= max_age {
            aged.push((age, path));
        }
    }
    aged.sort_by_key(|(age, _)| std::cmp::Reverse(*age));
    aged.into_iter().map(|(_, path)| path).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn one_repository_is_one_mirror_however_it_is_spelled() {
        // Keying on the raw string caches the same repository up to four times
        // and fetches each of them separately.
        let canonical = normalize_remote_url("https://github.com/Owner/Repo.git").unwrap();
        for spelling in [
            "https://github.com/Owner/Repo",
            "https://github.com/Owner/Repo/",
            "https://GITHUB.com/Owner/Repo.git",
            "git@github.com:Owner/Repo.git",
            "ssh://git@github.com/Owner/Repo.git",
            "  https://github.com/Owner/Repo.git  ",
        ] {
            assert_eq!(
                normalize_remote_url(spelling).unwrap(),
                canonical,
                "spelling: {spelling}"
            );
        }
    }

    #[test]
    fn a_local_remote_keys_on_its_path() {
        // Keying, not policy: the callers that matter only produce https URLs,
        // and refusing this would mean the flow cannot be tested offline.
        assert_eq!(
            normalize_remote_url("file:///srv/git/repo.git").unwrap(),
            "file://srv/git/repo"
        );
        assert_eq!(
            normalize_remote_url("file:///srv/git/repo").unwrap(),
            normalize_remote_url("file:///srv/git/repo.git/").unwrap()
        );
        // …and never collides with a host called `file`.
        assert_ne!(
            normalize_remote_url("file:///srv/git/repo").unwrap(),
            normalize_remote_url("https://file/srv/git/repo").unwrap()
        );
    }

    #[test]
    fn the_path_is_case_sensitive_even_though_the_host_is_not() {
        // GitHub folds owner/name; most hosts do not, and folding here would
        // merge two real repositories into one cache entry.
        assert_ne!(
            normalize_remote_url("https://example.com/a/b").unwrap(),
            normalize_remote_url("https://example.com/A/B").unwrap()
        );
    }

    #[test]
    fn credentials_never_reach_the_cache_key() {
        // The key becomes a directory name on disk, and two users of one
        // repository share the mirror.
        let normalized =
            normalize_remote_url("https://user:ghp_secret@github.com/o/r.git").unwrap();
        assert_eq!(normalized, "github.com/o/r");
        assert!(!normalized.contains("ghp_secret"));
    }

    #[test]
    fn refuses_urls_it_cannot_key_on() {
        for bad in [
            "",
            "   ",
            "--upload-pack=touch",
            "ftp://h/r",
            "https://github.com",
            "https://",
            "file://",
            "file:///",
        ] {
            assert!(
                normalize_remote_url(bad).is_err(),
                "expected a refusal for {bad:?}"
            );
        }
    }

    /// One repository is one directory name in both trees. The checkout and
    /// the mirror differ only by the bare-repository suffix, so `sources/` and
    /// `mirrors/` can be paired by eye, and a caller cannot accidentally
    /// derive two checkouts for one repository by spelling the remote
    /// differently.
    #[test]
    fn a_checkout_shares_the_mirror_stem_without_the_bare_suffix() {
        let root = Path::new("/cache");
        let mirror = mirror_path(root, "https://github.com/o/r.git").unwrap();
        let checkout = checkout_path(root, "https://github.com/o/r.git").unwrap();

        assert_eq!(
            format!("{}.git", checkout.file_name().unwrap().to_string_lossy()),
            mirror.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(
            checkout,
            checkout_path(root, "git@github.com:o/r.git").unwrap(),
            "one repository, however it is spelled, is one checkout"
        );
        assert_ne!(
            checkout,
            checkout_path(root, "https://github.com/o/other").unwrap()
        );
    }

    #[test]
    fn the_directory_name_cannot_escape_the_cache_root() {
        let root = Path::new("/cache");
        let path = mirror_path(root, "https://github.com/../../etc/passwd").unwrap();
        assert!(path.starts_with(root));
        assert_eq!(path.parent(), Some(root));
        assert!(!path.to_string_lossy().contains(".."));
    }

    #[test]
    fn two_repositories_never_share_a_directory() {
        let root = Path::new("/cache");
        let a = mirror_path(root, "https://github.com/o/a").unwrap();
        let b = mirror_path(root, "https://github.com/o/b").unwrap();
        assert_ne!(a, b);
        // …and one repository always gets the same one.
        assert_eq!(a, mirror_path(root, "git@github.com:o/a.git").unwrap());
    }

    #[test]
    fn freshness_needs_a_stamp() {
        let tmp = TempDir::new().unwrap();
        let mirror = tmp.path();
        // No stamp at all: an unknown age is not freshness.
        assert!(!is_fresh(
            mirror,
            Duration::from_secs(300),
            SystemTime::now()
        ));

        stamp_fetch(mirror).unwrap();
        assert!(is_fresh(
            mirror,
            Duration::from_secs(300),
            SystemTime::now()
        ));
        assert!(!is_fresh(mirror, Duration::from_secs(0), SystemTime::now()));
    }

    #[test]
    fn a_stamp_from_the_future_is_not_fresh() {
        // A clock change, not freshness.
        let tmp = TempDir::new().unwrap();
        stamp_fetch(tmp.path()).unwrap();
        let past = SystemTime::now() - Duration::from_secs(3600);
        assert!(!is_fresh(tmp.path(), Duration::from_secs(300), past));
    }

    #[test]
    fn a_mirror_is_a_bare_repository_shaped_directory() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("m.git");
        fs::create_dir_all(dir.join("objects")).unwrap();
        assert!(!is_mirror(&dir), "no HEAD yet");
        fs::write(dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        assert!(is_mirror(&dir));
    }

    #[test]
    fn clone_args_are_blobless_and_mirror_every_ref() {
        let args = clone_args("https://github.com/o/r.git", Path::new("/cache/r.git"));
        assert!(args.contains(&"--mirror".to_string()));
        assert!(args.contains(&"--filter=blob:none".to_string()));
        // `--` before the URL, or a remote beginning with `-` is read as a flag.
        let separator = args.iter().position(|arg| arg == "--").unwrap();
        let url = args
            .iter()
            .position(|arg| arg.contains("github.com"))
            .unwrap();
        assert!(separator < url);
    }

    #[test]
    fn fetch_args_can_request_refs_the_remote_does_not_advertise() {
        // A `--mirror` clone copies what the remote advertises, and GitHub does
        // not advertise `refs/pull/*`. Without an explicit refspec the mirror
        // simply does not have the PR head, and a base that resolves against it
        // is unresolvable no matter how fresh the fetch was.
        let plain = fetch_args(&[]);
        assert_eq!(plain.last().map(String::as_str), Some("origin"));

        let pr = "refs/pull/42/head:refs/pull/42/head".to_string();
        let asked = fetch_args(std::slice::from_ref(&pr));
        assert_eq!(asked.last(), Some(&pr));
        // The refspec is appended, never a replacement for the ordinary refresh.
        assert_eq!(&asked[..plain.len()], &plain[..]);
    }

    #[test]
    fn derived_clones_never_share_an_inode_with_the_mirror() {
        // Several of these are handed to an agent with shell access on a path
        // whose instructions come from an issue body anyone can file.
        let args = derive_args(
            Path::new("/cache/r.git"),
            Path::new("/work/r"),
            Some("main"),
        );
        assert!(args.contains(&"--no-hardlinks".to_string()));
        assert!(args.contains(&"--single-branch".to_string()));
        assert!(args.contains(&"main".to_string()));

        let all_branches = derive_args(Path::new("/cache/r.git"), Path::new("/work/r"), None);
        assert!(!all_branches.contains(&"--single-branch".to_string()));
        // A plain path would make git ignore `--filter`.
        assert!(all_branches.contains(&"file:///cache/r.git".to_string()));
    }

    #[test]
    fn a_file_url_encodes_what_git_would_decode() {
        assert_eq!(file_url(Path::new("/srv/m/r.git")), "file:///srv/m/r.git");
        assert_eq!(
            file_url(Path::new("/Users/a b/100%/r.git")),
            "file:///Users/a%20b/100%25/r.git"
        );
        assert_eq!(file_url(Path::new("C:/m/r.git")), "file:///C%3A/m/r.git");
    }

    #[test]
    fn a_mirror_is_configured_to_answer_a_partial_clone() {
        let commands = serve_config_commands();
        assert!(commands.contains(&vec![
            "config".to_string(),
            "uploadpack.allowFilter".to_string(),
            "true".to_string()
        ]));
        assert!(commands
            .iter()
            .all(|command| !command.contains(&"--global".to_string())));
    }

    #[test]
    fn materializing_reads_one_tree_into_a_scratch_work_tree() {
        let args = materialize_args(Path::new("/m/r.git"), Path::new("/tmp/w"), "abc123");
        assert_eq!(args[0], "--git-dir=/m/r.git");
        assert_eq!(args[1], "--work-tree=/tmp/w");
        assert_eq!(&args[2..], ["read-tree", "--reset", "-u", "abc123"]);
    }

    #[test]
    fn maintenance_never_touches_the_users_global_config() {
        // `git maintenance register` writes the repository into the user's
        // global config and schedules background jobs against it. These are our
        // directories, not theirs.
        let commands = maintenance_commands();
        assert!(!commands.is_empty());
        for command in &commands {
            assert_ne!(command.first().map(String::as_str), Some("maintenance"));
            assert!(!command.iter().any(|arg| arg == "--global"));
        }
        assert_eq!(
            commands[0][..2],
            ["commit-graph".to_string(), "write".to_string()]
        );
    }

    #[test]
    fn source_maintenance_writes_only_a_commit_graph_and_no_config() {
        let commands = source_maintenance_commands();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0][..2], ["commit-graph".to_string(), "write".to_string()]);
        assert!(commands[0].iter().any(|arg| arg == "--changed-paths"));
        for command in &commands {
            assert_ne!(command.first().map(String::as_str), Some("maintenance"));
            assert_ne!(command.first().map(String::as_str), Some("config"));
            assert_ne!(command.first().map(String::as_str), Some("multi-pack-index"));
        }
    }

    #[test]
    fn reclaims_by_age_oldest_first_and_ignores_non_mirrors() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let make = |name: &str, stamped: bool| {
            let dir = root.join(name);
            fs::create_dir_all(dir.join("objects")).unwrap();
            fs::write(dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
            if stamped {
                stamp_fetch(&dir).unwrap();
            }
            dir
        };
        let fresh = make("fresh.git", true);
        let unstamped = make("unstamped.git", true);
        // Backdate the stamp by rewriting it with an old mtime is not portable;
        // instead ask with a `now` far in the future.
        fs::create_dir_all(root.join("not-a-mirror")).unwrap();

        let now = SystemTime::now();
        // Nothing is old enough yet.
        assert!(reclaim_candidates(root, Duration::from_secs(3600), now).is_empty());

        // Everything is, an hour later.
        let later = now + Duration::from_secs(7200);
        let candidates = reclaim_candidates(root, Duration::from_secs(3600), later);
        assert_eq!(candidates.len(), 2);
        assert!(candidates.contains(&fresh));
        assert!(candidates.contains(&unstamped));
        assert!(!candidates.iter().any(|path| path.ends_with("not-a-mirror")));
    }

    #[test]
    fn a_mirror_with_no_stamp_is_ancient_rather_than_immortal() {
        // A failed first clone, or a directory from an older layout. Treating
        // an unknown age as young would keep it forever.
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("stale.git");
        fs::create_dir_all(dir.join("objects")).unwrap();
        fs::write(dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let candidates = reclaim_candidates(tmp.path(), Duration::from_secs(1), SystemTime::now());
        assert_eq!(candidates, vec![dir]);
    }
}
