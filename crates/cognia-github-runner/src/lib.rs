//! Short-lived GitHub Actions hosts. The data plane remains Companion.
//! The local ledger is written before dispatch and retained after uncertain outcomes.
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use p256::{
    elliptic_curve::{sec1::ToSec1Point, Generate},
    SecretKey,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Mutex, Semaphore},
};

const WORKFLOW: &str = "cognia-runner.yml";
const TRUSTED_FILES: [(&str, &str); 5] = [
    (
        ".github/workflows/cognia-runner.yml",
        include_str!("../../../deploy/github-runner/cognia-runner.yml"),
    ),
    (
        ".github/cognia-runner/bootstrap.mjs",
        include_str!("../../../deploy/github-runner/bootstrap.mjs"),
    ),
    (
        ".github/cognia-runner/package.json",
        include_str!("../../../deploy/github-runner/package.json"),
    ),
    (
        ".github/cognia-runner/package-lock.json",
        include_str!("../../../deploy/github-runner/package-lock.json"),
    ),
    (
        ".github/cognia-runner/action.yml",
        include_str!("../../../deploy/github-runner/action.yml"),
    ),
];
const LIMIT: usize = 2 * 1024 * 1024;
const ARTIFACT_LIMIT: usize = 64 * 1024;
type LeaseLocks = std::sync::Mutex<BTreeMap<PathBuf, Weak<Mutex<()>>>>;
static LOCKS: OnceLock<LeaseLocks> = OnceLock::new();
static REQUESTS: Semaphore = Semaphore::const_new(4);
fn lease_lock(data: &Path, id: &str) -> Result<Arc<Mutex<()>>, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "invalid lease id")?;
    let key = root(data)?.canonicalize().map_err(error)?.join(id);
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Runner lease lock unavailable")?;
    locks.retain(|_, value| value.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRequest {
    pub repository: String,
    pub workflow_ref: String,
    pub host_image: String,
    pub agent_bundle_image: String,
    pub development_image: String,
    pub signaling_url: String,
    pub lifetime_minutes: u32,
    pub label: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightRequest {
    pub repository: String,
    pub workflow_ref: String,
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Passed,
    Failed,
    Skipped,
}
#[derive(Debug, Serialize)]
pub struct PreflightCheck {
    pub step: &'static str,
    pub status: CheckStatus,
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<&'static str>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub ready: bool,
    pub checks: Vec<PreflightCheck>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_login: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// Read-only setup evidence, not a dispatch authorization. Creation always
/// revalidates the workflow and its five trusted files at the selected commit.
pub async fn preflight(request: PreflightRequest) -> Preflight {
    preflight_with(request, &Gh).await
}

async fn preflight_with(request: PreflightRequest, g: &dyn Github) -> Preflight {
    let mut result = Preflight {
        ready: false,
        checks: [
            "cli",
            "account",
            "repository",
            "branch",
            "workflow",
            "templates",
        ]
        .into_iter()
        .map(|step| PreflightCheck {
            step,
            status: CheckStatus::Skipped,
            code: "not_checked",
            file: None,
        })
        .collect(),
        actor_login: None,
        commit: None,
    };
    if let Err(code) = validate_target(&request.repository, &request.workflow_ref) {
        let index = if code == "invalid_repository" { 2 } else { 3 };
        result.checks[index].status = CheckStatus::Failed;
        result.checks[index].code = code;
        return result;
    }
    let mut current = 0;
    fn passed(result: &mut Preflight, current: &mut usize) {
        result.checks[*current].status = CheckStatus::Passed;
        result.checks[*current].code = "ok";
        *current += 1;
    }
    // Includes the concurrency wait. Dropping a timed-out gh request kills
    // its subprocess; no credentials or CLI diagnostics enter this response.
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        let _permit = REQUESTS.acquire().await.map_err(|_| "cli_unavailable")?;
        g.request(vec!["--version".into()])
            .await
            .map_err(|_| "cli_unavailable")?;
        passed(&mut result, &mut current);
        let actor = api(g, "user").await.map_err(|_| "account_unavailable")?;
        if actor["id"].as_u64().is_none_or(|id| id == 0) {
            return Err("account_unavailable");
        }
        let login = actor["login"]
            .as_str()
            .filter(|login| {
                !login.is_empty()
                    && login.len() <= 100
                    && login
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-[]_".contains(&b))
            })
            .ok_or("account_unavailable")?;
        result.actor_login = Some(login.to_owned());
        passed(&mut result, &mut current);
        let repo = api(g, &format!("repos/{}", request.repository))
            .await
            .map_err(|_| "repository_unavailable")?;
        if repo["archived"] == true || repo["disabled"] == true {
            return Err("repository_inactive");
        }
        if !["push", "admin", "maintain"]
            .iter()
            .any(|permission| repo["permissions"][permission] == true)
        {
            return Err("repository_not_writable");
        }
        passed(&mut result, &mut current);
        let branch = api(
            g,
            &format!(
                "repos/{}/branches/{}",
                request.repository,
                segment(&request.workflow_ref)
            ),
        )
        .await
        .map_err(|_| "branch_unavailable")?;
        let commit = branch["commit"]["sha"]
            .as_str()
            .filter(|sha| sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("branch_unavailable")?
            .to_owned();
        result.commit = Some(commit.clone());
        passed(&mut result, &mut current);
        let workflow = api(
            g,
            &format!("repos/{}/actions/workflows/{WORKFLOW}", request.repository),
        )
        .await
        .map_err(|_| "workflow_unavailable")?;
        if workflow["path"] != TRUSTED_FILES[0].0
            || workflow["id"].as_u64().is_none_or(|id| id == 0)
        {
            return Err("workflow_unavailable");
        }
        if workflow["state"] != "active" {
            return Err("workflow_inactive");
        }
        passed(&mut result, &mut current);
        for (file, expected) in TRUSTED_FILES {
            result.checks[current].file = Some(file);
            let bytes = content(g, &request.repository, &commit, file)
                .await
                .map_err(|_| "templates_unavailable")?;
            if !matches_source(&bytes, expected) {
                return Err("templates_mismatch");
            }
        }
        result.checks[current].file = None;
        passed(&mut result, &mut current);
        Ok(())
    })
    .await;
    match outcome {
        Ok(Ok(())) => result.ready = true,
        other => {
            result.checks[current].status = CheckStatus::Failed;
            result.checks[current].code = match other {
                Ok(Err(code)) => code,
                _ => "timeout",
            };
        }
    }
    result
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Dispatching,
    Queued,
    Starting,
    Ready,
    Stopping,
    Stopped,
    Failed,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub id: String,
    pub repository: String,
    pub workflow_ref: String,
    pub label: String,
    pub state: State,
    pub run_id: Option<u64>,
    pub run_url: Option<String>,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub error: Option<String>,
    pub host_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    lease: Lease,
    commit: String,
    private_key: String,
    cancel_requested: bool,
    lifetime_minutes: u32,
    actor_id: u64,
    actor_login: String,
    workflow_id: u64,
}

#[async_trait]
trait Github: Send + Sync {
    async fn request(&self, args: Vec<String>) -> Result<Vec<u8>, String>;
}
struct Gh;
#[async_trait]
impl Github for Gh {
    async fn request(&self, mut args: Vec<String>) -> Result<Vec<u8>, String> {
        if args.first().is_some_and(|arg| arg == "api") {
            args.splice(1..1, ["--hostname".into(), "github.com".into()]);
        }
        let mut child = Command::new("gh")
            .args(args)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_HOST", "github.com")
            .env("GH_PAGER", "cat")
            .env("NO_COLOR", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("GitHub CLI unavailable: {e}"))?;
        let stdout = child.stdout.take().ok_or("GitHub CLI stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("GitHub CLI stderr unavailable")?;
        async fn bounded(reader: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>, String> {
            let mut bytes = Vec::new();
            reader
                .take((LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(error)?;
            if bytes.len() > LIMIT {
                return Err("GitHub CLI output exceeded limit".into());
            }
            Ok(bytes)
        }
        let result = tokio::time::timeout(Duration::from_secs(45), async {
            let (out, err, status) = tokio::try_join!(bounded(stdout), bounded(stderr), async {
                child.wait().await.map_err(error)
            })?;
            if !status.success() {
                // gh diagnostics may contain remote-controlled or credential-bearing text.
                let _ = err;
                return Err(format!(
                    "GitHub CLI request failed (exit {})",
                    status.code().unwrap_or(-1)
                ));
            }
            Ok(out)
        })
        .await;
        match result {
            Ok(Ok(out)) => Ok(out),
            other => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                match other {
                    Ok(Err(e)) => Err(e),
                    _ => Err("GitHub CLI request timed out; outcome is unknown".into()),
                }
            }
        }
    }
}
async fn api(g: &dyn Github, path: &str) -> Result<Value, String> {
    let bytes = g.request(vec!["api".into(), path.into()]).await?;
    serde_json::from_slice(&bytes).map_err(|_| "GitHub returned invalid JSON".into())
}
fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
fn validate_target(repository: &str, workflow_ref: &str) -> Result<(), &'static str> {
    let parts: Vec<_> = repository.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || p.len() > 100
                || *p == "."
                || *p == ".."
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
    {
        return Err("invalid_repository");
    }
    if workflow_ref.is_empty()
        || workflow_ref.len() > 200
        || workflow_ref.contains("..")
        || workflow_ref.starts_with('-')
        || !workflow_ref
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
    {
        return Err("invalid_ref");
    }
    Ok(())
}
fn validate(request: &CreateRequest) -> Result<(), String> {
    validate_target(&request.repository, &request.workflow_ref).map_err(|code| match code {
        "invalid_repository" => "repository must be owner/repo",
        _ => "invalid workflow branch",
    })?;
    for image in [
        &request.host_image,
        &request.agent_bundle_image,
        &request.development_image,
    ] {
        let (name, digest) = image
            .rsplit_once("@sha256:")
            .ok_or("images must be digest-pinned")?;
        if name.is_empty()
            || name.len() > 255
            || name.starts_with('-')
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._/-:".contains(&b))
            || digest.len() != 64
            || !digest.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("invalid pinned image".into());
        }
    }
    let url = url::Url::parse(&request.signaling_url).map_err(|_| "invalid signaling URL")?;
    if url.scheme() != "wss"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err("signaling URL must use wss without credentials, query or fragment".into());
    }
    if !(10..=330).contains(&request.lifetime_minutes) {
        return Err("lifetime must be 10..330 minutes".into());
    }
    if request.label.trim().is_empty()
        || request.label.len() > 120
        || request.label.chars().any(char::is_control)
    {
        return Err("invalid host label".into());
    }
    Ok(())
}
fn root(data: &Path) -> Result<PathBuf, String> {
    let path = data.join("github-runner-leases");
    std::fs::create_dir_all(&path).map_err(error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(error)?;
    }
    Ok(path)
}
fn path(data: &Path, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "invalid lease id")?;
    Ok(root(data)?.join(format!("{id}.json")))
}
fn save(data: &Path, record: &Record) -> Result<(), String> {
    let destination = path(data, &record.lease.id)?;
    let mut file = tempfile::NamedTempFile::new_in(root(data)?).map_err(error)?;
    serde_json::to_writer(&mut file, record).map_err(error)?;
    file.flush().map_err(error)?;
    file.as_file().sync_all().map_err(error)?;
    file.persist(destination).map_err(error)?;
    // Persist the rename as well as its contents before dispatching externally.
    #[cfg(unix)]
    std::fs::File::open(root(data)?)
        .map_err(error)?
        .sync_all()
        .map_err(error)?;
    Ok(())
}
fn load(data: &Path, id: &str) -> Result<Record, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path(data, id)?)
        .map_err(error)?
        .take(64 * 1024)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    let record: Record = serde_json::from_slice(&bytes).map_err(error)?;
    if record.lease.id != id {
        return Err("lease identity mismatch".into());
    }
    Ok(record)
}
async fn content(
    g: &dyn Github,
    repository: &str,
    commit: &str,
    file: &str,
) -> Result<Vec<u8>, String> {
    let response = api(
        g,
        &format!("repos/{repository}/contents/{file}?ref={commit}"),
    )
    .await?;
    if response["encoding"] != "base64" {
        return Err("workflow source is not a file".into());
    }
    STANDARD
        .decode(
            response["content"]
                .as_str()
                .ok_or("missing workflow source")?
                .replace(['\r', '\n'], ""),
        )
        .map_err(error)
}
fn matches_source(actual: &[u8], expected: &str) -> bool {
    std::str::from_utf8(actual)
        .is_ok_and(|v| v.replace("\r\n", "\n") == expected.replace("\r\n", "\n"))
}
async fn create_with(data: &Path, request: CreateRequest, g: &dyn Github) -> Result<Lease, String> {
    validate(&request)?;
    let _permit = REQUESTS.acquire().await.map_err(error)?;
    let actor = api(g, "user").await?;
    let actor_id = actor["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or("GitHub account identity unavailable")?;
    let actor_login = actor["login"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("GitHub account login unavailable")?
        .to_string();
    let workflow = api(
        g,
        &format!("repos/{}/actions/workflows/{WORKFLOW}", request.repository),
    )
    .await?;
    if workflow["path"] != ".github/workflows/cognia-runner.yml" || workflow["state"] != "active" {
        return Err("Cognia runner workflow is not active at its trusted path".into());
    }
    let workflow_id = workflow["id"]
        .as_u64()
        .ok_or("Workflow identity unavailable")?;
    let branch = api(
        g,
        &format!(
            "repos/{}/branches/{}",
            request.repository,
            segment(&request.workflow_ref)
        ),
    )
    .await?;
    let commit = branch["commit"]["sha"]
        .as_str()
        .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("branch has no valid commit")?
        .to_string();
    for (file, expected) in TRUSTED_FILES {
        if !matches_source(
            &content(g, &request.repository, &commit, file).await?,
            expected,
        ) {
            return Err(format!(
                "{file} differs from the trusted Cognia runner template"
            ));
        }
    }
    let key = SecretKey::generate();
    let id = uuid::Uuid::new_v4().to_string();
    let lock = lease_lock(data, &id)?;
    let _guard = lock.lock().await;
    let mut record = Record {
        lease: Lease {
            id: id.clone(),
            repository: request.repository.clone(),
            workflow_ref: request.workflow_ref.clone(),
            label: request.label,
            state: State::Dispatching,
            run_id: None,
            run_url: None,
            created_at: now(),
            expires_at: None,
            error: None,
            host_id: None,
        },
        commit,
        private_key: STANDARD.encode(key.to_bytes()),
        cancel_requested: false,
        lifetime_minutes: request.lifetime_minutes,
        actor_id,
        actor_login,
        workflow_id,
    };
    save(data, &record)?;
    let inputs = BTreeMap::from([
        ("lease_id", id),
        (
            "recipient_public_key",
            STANDARD.encode(key.public_key().to_sec1_point(false).as_bytes()),
        ),
        ("host_image", request.host_image),
        ("agent_bundle_image", request.agent_bundle_image),
        ("development_image", request.development_image),
        ("signaling_url", request.signaling_url),
        ("lifetime_minutes", request.lifetime_minutes.to_string()),
    ]);
    let mut args = vec![
        "workflow".into(),
        "run".into(),
        WORKFLOW.into(),
        "--repo".into(),
        format!("github.com/{}", request.repository),
        "--ref".into(),
        request.workflow_ref,
    ];
    for (key, value) in inputs {
        args.push("--raw-field".into());
        args.push(format!("{key}={value}"));
    }
    match g.request(args).await {
        Ok(_) => record.lease.state = State::Queued,
        Err(e) => {
            record.lease.state = State::Unknown;
            record.lease.error = Some(e);
        }
    }
    save(data, &record)?;
    Ok(record.lease)
}
pub async fn create(data: &Path, request: CreateRequest) -> Result<Lease, String> {
    create_with(data, request, &Gh).await
}
pub async fn list(data: &Path) -> Result<Vec<Lease>, String> {
    // Every ledger write is an atomic rename; listing never waits for network I/O.
    let mut leases = Vec::new();
    for (index, entry) in std::fs::read_dir(root(data)?).map_err(error)?.enumerate() {
        if index >= 10_000 {
            return Err("Runner lease ledger exceeds the 10000-entry inspection limit".into());
        }
        let path = entry.map_err(error)?.path();
        if path.extension().is_some_and(|v| v == "json") {
            let id = path
                .file_stem()
                .and_then(|v| v.to_str())
                .ok_or("invalid ledger name")?;
            leases.push(match load(data, id) {
                Ok(record) => record.lease,
                Err(_) => Lease {
                    id: id.into(), repository: String::new(), workflow_ref: String::new(),
                    label: "Unreadable runner lease".into(), state: State::Unknown,
                    run_id: None, run_url: None, created_at: 0, expires_at: None, host_id: None,
                    error: Some("The local lease record is unreadable. It has been preserved for recovery; inspect GitHub Actions before removing it.".into()),
                },
            });
        }
    }
    leases.sort_by_key(|v| std::cmp::Reverse(v.created_at));
    Ok(leases)
}
async fn discover(g: &dyn Github, record: &Record) -> Result<Option<Value>, String> {
    let expected = format!("cognia-runner-{}", record.lease.id);
    let mut found = None;
    // Paginate; never silently choose a run after a partial scan.
    for page in 1..=20 {
        let response=api(g,&format!("repos/{}/actions/workflows/{WORKFLOW}/runs?event=workflow_dispatch&branch={}&per_page=100&page={page}",record.lease.repository,segment(&record.lease.workflow_ref))).await?;
        let runs = response["workflow_runs"]
            .as_array()
            .ok_or("missing workflow runs")?;
        for run in runs
            .iter()
            .filter(|r| r["display_title"].as_str() == Some(expected.as_str()))
        {
            if found.is_some() {
                return Err(
                    "multiple runs matched this lease; refusing ambiguous cancellation".into(),
                );
            }
            found = Some(run.clone());
        }
        if runs.len() < 100 {
            return Ok(found);
        }
    }
    Err("GitHub run discovery exceeded pagination limit".into())
}
fn check_run(run: &Value, record: &Record) -> Result<u64, String> {
    if run["workflow_id"].as_u64() != Some(record.workflow_id)
        || run["run_attempt"].as_u64() != Some(1)
        || run["actor"]["id"].as_u64() != Some(record.actor_id)
        || run["triggering_actor"]["id"].as_u64() != Some(record.actor_id)
        || run["head_branch"].as_str() != Some(record.lease.workflow_ref.as_str())
        || run["head_sha"].as_str() != Some(record.commit.as_str())
        || run["event"] != "workflow_dispatch"
        || run["display_title"].as_str()
            != Some(format!("cognia-runner-{}", record.lease.id).as_str())
        || run["head_repository"]["full_name"]
            .as_str()
            .is_none_or(|s| !s.eq_ignore_ascii_case(&record.lease.repository))
    {
        return Err("workflow run provenance differs from the reviewed lease".into());
    }
    run["id"].as_u64().ok_or("run has no id".into())
}
async fn refresh_with(data: &Path, id: &str, g: &dyn Github) -> Result<Lease, String> {
    let lock = lease_lock(data, id)?;
    let _guard = lock.lock().await;
    let _permit = REQUESTS.acquire().await.map_err(error)?;
    refresh_record(data, id, g).await
}
async fn refresh_record(data: &Path, id: &str, g: &dyn Github) -> Result<Lease, String> {
    let mut record = load(data, id)?;
    let outcome: Result<(), String> = async {
        let actor = api(g, "user").await?;
        if actor["id"].as_u64() != Some(record.actor_id)
            || actor["login"].as_str() != Some(record.actor_login.as_str())
        {
            return Err(
                "GitHub account changed; switch back to the account that created this lease".into(),
            );
        }
        if record.lease.state == State::Stopped {
            return Ok(());
        }
        let run = match record.lease.run_id {
            Some(run) => Some(
                api(
                    g,
                    &format!("repos/{}/actions/runs/{run}", record.lease.repository),
                )
                .await?,
            ),
            None => match discover(g, &record).await? {
                Some(candidate) => {
                    let id = candidate["id"].as_u64().ok_or("discovered run has no id")?;
                    Some(
                        api(
                            g,
                            &format!("repos/{}/actions/runs/{id}", record.lease.repository),
                        )
                        .await?,
                    )
                }
                None => None,
            },
        };
        let Some(run) = run else {
            record.lease.state = State::Unknown;
            record.lease.error = Some(
                "No matching run is visible yet; dispatch is never retried automatically".into(),
            );
            return Ok(());
        };
        let run_id = check_run(&run, &record)?;
        record.lease.run_id = Some(run_id);
        record.lease.run_url = Some(format!(
            "https://github.com/{}/actions/runs/{run_id}",
            record.lease.repository
        ));
        record.lease.error = None;
        if let Some(start) = run["run_started_at"]
            .as_str()
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        {
            record.lease.expires_at = Some(
                start.timestamp_millis().max(0) as u64
                    + u64::from(record.lifetime_minutes) * 60_000,
            );
        }
        if run["status"] == "completed" {
            record.lease.state =
                if run["conclusion"] == "success" || run["conclusion"] == "cancelled" {
                    State::Stopped
                } else {
                    State::Failed
                };
            if record.lease.state == State::Failed {
                record.lease.error = Some(format!(
                    "Runner workflow completed: {}",
                    run["conclusion"].as_str().unwrap_or("unknown")
                ));
            }
            return Ok(());
        }
        if record.cancel_requested {
            record.lease.state = State::Stopping;
            g.request(vec![
                "api".into(),
                "--method".into(),
                "POST".into(),
                format!(
                    "repos/{}/actions/runs/{run_id}/cancel",
                    record.lease.repository
                ),
            ])
            .await?;
        } else if run["status"] == "in_progress" {
            record.lease.state = State::Starting;
            if let Some(payload) = read_pairing(g, &record).await? {
                record.lease.state = State::Ready;
                record.lease.host_id = Some(payload.host_id);
            }
        } else {
            record.lease.state = State::Queued;
        }
        Ok(())
    }
    .await;
    if let Err(e) = outcome {
        record.lease.state = if record.cancel_requested {
            State::Stopping
        } else {
            State::Unknown
        };
        record.lease.error = Some(e);
    }
    save(data, &record)?;
    Ok(record.lease)
}
pub async fn refresh(data: &Path, id: &str) -> Result<Lease, String> {
    refresh_with(data, id, &Gh).await
}
pub async fn cancel(data: &Path, id: &str) -> Result<Lease, String> {
    cancel_with(data, id, &Gh).await
}
async fn cancel_with(data: &Path, id: &str, g: &dyn Github) -> Result<Lease, String> {
    let lock = lease_lock(data, id)?;
    let _guard = lock.lock().await;
    let mut record = load(data, id)?;
    if record.lease.state == State::Stopped {
        return Ok(record.lease);
    }
    record.cancel_requested = true;
    record.lease.state = State::Stopping;
    save(data, &record)?;
    let _permit = REQUESTS.acquire().await.map_err(error)?;
    refresh_record(data, id, g).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    version: u32,
    lease_id: String,
    run_id: u64,
    ephemeral_public_key: String,
    nonce: String,
    ciphertext: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pairing {
    invitation: String,
    host_id: String,
    expires_at: u64,
}
fn decrypt(bytes: &[u8], record: &Record) -> Result<Pairing, String> {
    decrypt_at(bytes, record, now())
}
fn decrypt_at(bytes: &[u8], record: &Record, timestamp: u64) -> Result<Pairing, String> {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };
    let envelope: Envelope =
        serde_json::from_slice(bytes).map_err(|_| "Invalid encrypted pairing envelope")?;
    if envelope.version != 1
        || envelope.lease_id != record.lease.id
        || Some(envelope.run_id) != record.lease.run_id
    {
        return Err("Pairing envelope identity mismatch".into());
    }
    let private = SecretKey::from_slice(&STANDARD.decode(&record.private_key).map_err(error)?)
        .map_err(error)?;
    let peer = p256::PublicKey::from_sec1_bytes(
        &STANDARD
            .decode(envelope.ephemeral_public_key)
            .map_err(error)?,
    )
    .map_err(error)?;
    let shared = p256::ecdh::diffie_hellman(private.to_nonzero_scalar(), peer.as_affine());
    let mut key = [0u8; 32];
    hkdf::Hkdf::<sha2::Sha256>::new(Some(record.lease.id.as_bytes()), shared.raw_secret_bytes())
        .expand(b"cognia-github-runner-pairing-v1", &mut key)
        .map_err(error)?;
    let nonce = STANDARD.decode(envelope.nonce).map_err(error)?;
    let nonce = Nonce::try_from(nonce.as_slice()).map_err(|_| "Invalid pairing nonce")?;
    let ciphertext = STANDARD.decode(envelope.ciphertext).map_err(error)?;
    let aad = format!("{}:{}", record.lease.id, envelope.run_id);
    let plaintext = Aes256Gcm::new_from_slice(&key)
        .map_err(error)?
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "Pairing authentication failed")?;
    let pairing: Pairing =
        serde_json::from_slice(&plaintext).map_err(|_| "Invalid pairing payload")?;
    if !pairing.invitation.starts_with("cgnp4|")
        || pairing.invitation.len() > 32 * 1024
        || pairing.host_id.is_empty()
        || pairing.expires_at <= timestamp
        || pairing.expires_at > timestamp + 15 * 60 * 1000
    {
        return Err("Pairing invitation is expired or invalid".into());
    }
    Ok(pairing)
}
async fn read_pairing(g: &dyn Github, record: &Record) -> Result<Option<Pairing>, String> {
    let run_id = record.lease.run_id.ok_or("runner is not yet discovered")?;
    let response = api(
        g,
        &format!(
            "repos/{}/actions/runs/{run_id}/artifacts?per_page=100",
            record.lease.repository
        ),
    )
    .await?;
    if response["total_count"].as_u64().unwrap_or(0) > 100 {
        return Err("too many runner artifacts".into());
    }
    let name = format!("cognia-runner-{}", record.lease.id);
    let artifact = response["artifacts"]
        .as_array()
        .ok_or("missing artifacts")?
        .iter()
        .filter(|a| a["name"].as_str() == Some(name.as_str()) && a["expired"] == false)
        .max_by_key(|a| a["id"].as_u64().unwrap_or(0));
    let Some(artifact) = artifact else {
        return Ok(None);
    };
    if artifact["size_in_bytes"]
        .as_u64()
        .is_none_or(|v| v > ARTIFACT_LIMIT as u64)
    {
        return Err("pairing artifact is oversized".into());
    }
    let artifact_id = artifact["id"].as_u64().ok_or("invalid artifact id")?;
    let bytes = g
        .request(vec![
            "api".into(),
            format!(
                "repos/{}/actions/artifacts/{artifact_id}/zip",
                record.lease.repository
            ),
        ])
        .await?;
    if bytes.len() > ARTIFACT_LIMIT {
        return Err("pairing archive is oversized".into());
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(error)?;
    if archive.len() != 1 {
        return Err("pairing archive must contain exactly one file".into());
    }
    let mut file = archive.by_index(0).map_err(error)?;
    if file.name() != "pairing.json"
        || file.is_dir()
        || file.size() > ARTIFACT_LIMIT as u64
        || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
    {
        return Err("invalid pairing archive entry".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((ARTIFACT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() > ARTIFACT_LIMIT {
        return Err("pairing file is oversized".into());
    }
    match decrypt(&bytes, record) {
        Ok(value) => Ok(Some(value)),
        Err(e) if e == "Pairing invitation is expired or invalid" => Ok(None),
        Err(e) => Err(e),
    }
}
pub async fn pairing(data: &Path, id: &str) -> Result<String, String> {
    let lock = lease_lock(data, id)?;
    let _guard = lock.lock().await;
    let _permit = REQUESTS.acquire().await.map_err(error)?;
    let lease = refresh_record(data, id, &Gh).await?;
    if lease.state != State::Ready {
        return Err("runner is not ready for pairing".into());
    }
    let record = load(data, id)?;
    Ok(read_pairing(&Gh, &record)
        .await?
        .ok_or("pairing invitation expired; refresh the runner")?
        .invitation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{collections::VecDeque, sync::Mutex as StdMutex};
    struct Mock {
        responses: StdMutex<VecDeque<Result<Vec<u8>, String>>>,
        calls: StdMutex<Vec<Vec<String>>>,
    }
    impl Mock {
        fn new(values: Vec<Result<Vec<u8>, String>>) -> Self {
            Self {
                responses: StdMutex::new(values.into()),
                calls: StdMutex::new(Vec::new()),
            }
        }
    }
    #[async_trait]
    impl Github for Mock {
        async fn request(&self, args: Vec<String>) -> Result<Vec<u8>, String> {
            self.calls.lock().unwrap().push(args);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected GitHub request")
        }
    }
    fn reply(value: Value) -> Result<Vec<u8>, String> {
        Ok(serde_json::to_vec(&value).unwrap())
    }
    fn request() -> CreateRequest {
        CreateRequest {
            repository: "owner/repo".into(),
            workflow_ref: "runner".into(),
            host_image: format!("ghcr.io/acme/host@sha256:{}", "a".repeat(64)),
            agent_bundle_image: format!("ghcr.io/acme/bundle@sha256:{}", "b".repeat(64)),
            development_image: format!("ubuntu@sha256:{}", "c".repeat(64)),
            signaling_url: "wss://signal.example.com/ws".into(),
            lifetime_minutes: 60,
            label: "Build host".into(),
        }
    }
    fn record() -> Record {
        Record {
            lease: Lease {
                id: uuid::Uuid::new_v4().to_string(),
                repository: "owner/repo".into(),
                workflow_ref: "runner".into(),
                label: "host".into(),
                state: State::Starting,
                run_id: Some(42),
                run_url: None,
                created_at: now(),
                expires_at: None,
                error: None,
                host_id: None,
            },
            commit: "a".repeat(40),
            private_key: STANDARD.encode(SecretKey::generate().to_bytes()),
            cancel_requested: false,
            lifetime_minutes: 60,
            actor_id: 100,
            actor_login: "owner".into(),
            workflow_id: 12,
        }
    }
    #[tokio::test]
    async fn slow_lease_does_not_block_listing_or_other_leases_and_cancel_is_serialized() {
        struct Gate {
            inner: Mock,
            entered: tokio::sync::Notify,
            resume: tokio::sync::Notify,
            first: std::sync::atomic::AtomicBool,
        }
        #[async_trait]
        impl Github for Gate {
            async fn request(&self, args: Vec<String>) -> Result<Vec<u8>, String> {
                if !self.first.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    self.entered.notify_one();
                    self.resume.notified().await;
                }
                self.inner.request(args).await
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let first = record();
        let mut second = record();
        second.lease.id = uuid::Uuid::new_v4().to_string();
        save(dir.path(), &first).unwrap();
        save(dir.path(), &second).unwrap();
        let gate = Arc::new(Gate {
            inner: Mock::new(vec![
                reply(json!({"id":100,"login":"owner"})),
                reply(run(&first)),
                reply(json!({"total_count":0,"artifacts":[]})),
            ]),
            entered: Default::default(),
            resume: Default::default(),
            first: Default::default(),
        });
        let slow = {
            let path = dir.path().to_owned();
            let id = first.lease.id.clone();
            let gate = Arc::clone(&gate);
            tokio::spawn(async move { refresh_with(&path, &id, gate.as_ref()).await })
        };
        gate.entered.notified().await;
        let listed = tokio::time::timeout(Duration::from_secs(1), list(dir.path()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(listed.len(), 2);
        let mut completed = run(&second);
        completed["status"] = json!("completed");
        completed["conclusion"] = json!("success");
        let healthy = Mock::new(vec![
            reply(json!({"id":100,"login":"owner"})),
            reply(completed),
        ]);
        assert_eq!(
            tokio::time::timeout(
                Duration::from_secs(1),
                refresh_with(dir.path(), &second.lease.id, &healthy)
            )
            .await
            .unwrap()
            .unwrap()
            .state,
            State::Stopped
        );
        let cancel = Arc::new(Mock::new(vec![
            reply(json!({"id":100,"login":"owner"})),
            reply(run(&first)),
            Ok(vec![]),
        ]));
        let pending = {
            let path = dir.path().to_owned();
            let id = first.lease.id.clone();
            let cancel = Arc::clone(&cancel);
            tokio::spawn(async move { cancel_with(&path, &id, cancel.as_ref()).await })
        };
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        assert!(cancel.calls.lock().unwrap().is_empty());
        gate.resume.notify_one();
        slow.await.unwrap().unwrap();
        assert_eq!(pending.await.unwrap().unwrap().state, State::Stopping);
        assert!(load(dir.path(), &first.lease.id).unwrap().cancel_requested);
    }
    fn run(record: &Record) -> Value {
        json!({"id":42,"workflow_id":12,"run_attempt":1,"actor":{"id":100},"triggering_actor":{"id":100},"head_branch":"runner","head_sha":record.commit,"head_repository":{"full_name":"owner/repo"},"event":"workflow_dispatch","display_title":format!("cognia-runner-{}",record.lease.id),"status":"in_progress"})
    }
    #[test]
    fn validates_inputs_before_any_dispatch() {
        assert!(validate(&request()).is_ok());
        for bad in ["owner/repo/extra", "--help", "owner/..", "owner/repo?x=1"] {
            let mut r = request();
            r.repository = bad.into();
            assert!(validate(&r).is_err());
        }
        let mut r = request();
        r.host_image = "ubuntu:latest".into();
        assert!(validate(&r).is_err());
        let mut r = request();
        r.signaling_url = "wss://secret@signal.example.com/ws".into();
        assert!(validate(&r).is_err());
        let mut r = request();
        r.lifetime_minutes = 331;
        assert!(validate(&r).is_err());
    }
    #[tokio::test]
    async fn preflight_is_read_only_and_checks_every_trusted_file() {
        let mut responses = vec![
            Ok(b"gh version test".to_vec()),
            reply(json!({"id":100,"login":"owner"})),
            reply(json!({"permissions":{"push":true}})),
            reply(json!({"commit":{"sha":"a".repeat(40)}})),
            reply(json!({"id":12,"path":".github/workflows/cognia-runner.yml","state":"active"})),
        ];
        for (_, source) in TRUSTED_FILES {
            responses.push(reply(
                json!({"encoding":"base64","content":STANDARD.encode(source)}),
            ));
        }
        let gh = Mock::new(responses);
        let result = preflight_with(
            PreflightRequest {
                repository: "owner/repo".into(),
                workflow_ref: "main".into(),
            },
            &gh,
        )
        .await;
        assert!(result.ready);
        assert_eq!(result.checks.len(), 6);
        assert!(result
            .checks
            .iter()
            .all(|check| check.status == CheckStatus::Passed));
        assert_eq!(result.actor_login.as_deref(), Some("owner"));
        assert_eq!(gh.calls.lock().unwrap().len(), 10);
        assert!(gh
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|args| args == &["--version"] || (args[0] == "api" && args.len() == 2)));
    }
    #[tokio::test]
    async fn preflight_redacts_failures_and_never_checks_after_a_failed_dependency() {
        let gh = Mock::new(vec![
            Ok(vec![]),
            Err("SECRET remote-controlled diagnostics".into()),
        ]);
        let result = preflight_with(
            PreflightRequest {
                repository: "owner/repo".into(),
                workflow_ref: "main".into(),
            },
            &gh,
        )
        .await;
        assert!(!result.ready);
        assert_eq!(result.checks[1].code, "account_unavailable");
        assert_eq!(result.checks[2].status, CheckStatus::Skipped);
        assert!(!serde_json::to_string(&result).unwrap().contains("SECRET"));
        assert_eq!(gh.calls.lock().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn preflight_invalid_inputs_do_not_invoke_github() {
        for (repository, workflow_ref, index, code) in [
            (
                "https://github.com/owner/repo",
                "main",
                2,
                "invalid_repository",
            ),
            ("owner/repo", "--help", 3, "invalid_ref"),
        ] {
            let gh = Mock::new(vec![]);
            let result = preflight_with(
                PreflightRequest {
                    repository: repository.into(),
                    workflow_ref: workflow_ref.into(),
                },
                &gh,
            )
            .await;
            assert_eq!(result.checks[index].code, code);
            assert!(!result.ready);
            assert!(gh.calls.lock().unwrap().is_empty());
        }
    }
    #[tokio::test]
    async fn preflight_requires_an_active_workflow_and_repository_permission() {
        for (repository, workflow, index, code) in [
            (
                json!({"permissions":{"push":false}}),
                None,
                2,
                "repository_not_writable",
            ),
            (
                json!({"archived":true,"permissions":{"push":true}}),
                None,
                2,
                "repository_inactive",
            ),
            (
                json!({"permissions":{"push":true}}),
                Some(
                    json!({"id":12,"path":".github/workflows/cognia-runner.yml","state":"disabled_manually"}),
                ),
                4,
                "workflow_inactive",
            ),
        ] {
            let mut responses = vec![
                Ok(vec![]),
                reply(json!({"id":100,"login":"owner"})),
                reply(repository),
            ];
            if let Some(workflow) = workflow {
                responses.extend([
                    reply(json!({"commit":{"sha":"a".repeat(40)}})),
                    reply(workflow),
                ]);
            }
            let gh = Mock::new(responses);
            let result = preflight_with(
                PreflightRequest {
                    repository: "owner/repo".into(),
                    workflow_ref: "main".into(),
                },
                &gh,
            )
            .await;
            assert_eq!(result.checks[index].code, code);
            assert!(!result.ready);
            assert_eq!(result.checks[5].status, CheckStatus::Skipped);
        }
    }
    #[tokio::test]
    async fn preflight_reports_each_modified_template_at_the_resolved_commit() {
        for (broken, (broken_file, _)) in TRUSTED_FILES.iter().enumerate() {
            let mut responses = vec![
                Ok(vec![]),
                reply(json!({"id":100,"login":"owner"})),
                reply(json!({"permissions":{"push":true}})),
                reply(json!({"commit":{"sha":"b".repeat(40)}})),
                reply(
                    json!({"id":12,"path":".github/workflows/cognia-runner.yml","state":"active"}),
                ),
            ];
            for (index, (_, source)) in TRUSTED_FILES.iter().enumerate().take(broken + 1) {
                responses.push(reply(json!({"encoding":"base64","content":STANDARD.encode(if index == broken {"tampered"} else {source})})));
            }
            let gh = Mock::new(responses);
            let result = preflight_with(
                PreflightRequest {
                    repository: "owner/repo".into(),
                    workflow_ref: "feature/runner".into(),
                },
                &gh,
            )
            .await;
            assert!(!result.ready);
            assert_eq!(result.checks[5].code, "templates_mismatch");
            assert_eq!(result.checks[5].file, Some(*broken_file));
            let calls = gh.calls.lock().unwrap();
            assert!(calls[3][1].ends_with("feature%2Frunner"));
            assert!(calls
                .iter()
                .skip(5)
                .all(|call| call[1].ends_with(&format!("?ref={}", "b".repeat(40)))));
        }
    }
    #[tokio::test]
    async fn persists_unknown_dispatch_and_never_retries_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut responses = vec![
            reply(json!({"id":100,"login":"owner"})),
            reply(json!({"id":12,"path":".github/workflows/cognia-runner.yml","state":"active"})),
            reply(json!({"commit":{"sha":"a".repeat(40)}})),
        ];
        for source in [
            include_str!("../../../deploy/github-runner/cognia-runner.yml"),
            include_str!("../../../deploy/github-runner/bootstrap.mjs"),
            include_str!("../../../deploy/github-runner/package.json"),
            include_str!("../../../deploy/github-runner/package-lock.json"),
            include_str!("../../../deploy/github-runner/action.yml"),
        ] {
            responses.push(reply(
                json!({"encoding":"base64","content":STANDARD.encode(source)}),
            ));
        }
        responses.push(Err("timeout after dispatch".into()));
        let gh = Mock::new(responses);
        let lease = create_with(dir.path(), request(), &gh).await.unwrap();
        assert_eq!(lease.state, State::Unknown);
        let stored = load(dir.path(), &lease.id).unwrap();
        assert!(!stored.private_key.is_empty());
        let gh = Mock::new(vec![
            reply(json!({"id":100,"login":"owner"})),
            reply(json!({"workflow_runs":[]})),
        ]);
        let lease = refresh_with(dir.path(), &lease.id, &gh).await.unwrap();
        assert_eq!(lease.state, State::Unknown);
        assert!(gh.calls.lock().unwrap().iter().all(|call| call[0] == "api"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path(dir.path(), &lease.id).unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[tokio::test]
    async fn modified_workflow_refuses_before_creating_lease() {
        let dir = tempfile::tempdir().unwrap();
        let gh = Mock::new(vec![
            reply(json!({"id":100,"login":"owner"})),
            reply(json!({"id":12,"path":".github/workflows/cognia-runner.yml","state":"active"})),
            reply(json!({"commit":{"sha":"a".repeat(40)}})),
            reply(
                json!({"encoding":"base64","content":STANDARD.encode("# trusted actor guard in a comment")}),
            ),
        ]);
        assert!(create_with(dir.path(), request(), &gh)
            .await
            .unwrap_err()
            .contains("differs"));
        assert_eq!(
            std::fs::read_dir(root(dir.path()).unwrap())
                .unwrap()
                .count(),
            0
        );
    }
    #[tokio::test]
    async fn cancellation_failure_keeps_recoverable_lease() {
        let dir = tempfile::tempdir().unwrap();
        let mut record = record();
        record.cancel_requested = true;
        save(dir.path(), &record).unwrap();
        let gh = Mock::new(vec![
            reply(json!({"id":100,"login":"owner"})),
            reply(run(&record)),
            Err("cancel timeout".into()),
        ]);
        let lease = refresh_with(dir.path(), &record.lease.id, &gh)
            .await
            .unwrap();
        assert_eq!(lease.state, State::Stopping);
        assert!(lease.error.is_some());
        assert!(load(dir.path(), &lease.id).unwrap().cancel_requested);
        let mut finished = run(&record);
        finished["status"] = json!("completed");
        finished["conclusion"] = json!("cancelled");
        let gh = Mock::new(vec![
            reply(json!({"id":100,"login":"owner"})),
            reply(finished),
        ]);
        assert_eq!(
            refresh_with(dir.path(), &lease.id, &gh)
                .await
                .unwrap()
                .state,
            State::Stopped
        );
    }
    #[tokio::test]
    async fn refuses_branch_movement_and_wrong_repository_before_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let record = record();
        save(dir.path(), &record).unwrap();
        let mut wrong = run(&record);
        wrong["head_sha"] = json!("b".repeat(40));
        let gh = Mock::new(vec![reply(json!({"id":100,"login":"owner"})), reply(wrong)]);
        let result = refresh_with(dir.path(), &record.lease.id, &gh)
            .await
            .unwrap();
        assert_eq!(result.state, State::Unknown);
        assert!(result.error.unwrap().contains("provenance"));
    }
    fn encrypted(record: &Record, expires: u64) -> Vec<u8> {
        use aes_gcm::{
            aead::{Aead, KeyInit, Payload},
            Aes256Gcm, Nonce,
        };
        let recipient =
            SecretKey::from_slice(&STANDARD.decode(&record.private_key).unwrap()).unwrap();
        let ephemeral = SecretKey::generate();
        let shared = p256::ecdh::diffie_hellman(
            ephemeral.to_nonzero_scalar(),
            recipient.public_key().as_affine(),
        );
        let mut key = [0u8; 32];
        hkdf::Hkdf::<sha2::Sha256>::new(
            Some(record.lease.id.as_bytes()),
            shared.raw_secret_bytes(),
        )
        .expand(b"cognia-github-runner-pairing-v1", &mut key)
        .unwrap();
        let plaintext=serde_json::to_vec(&json!({"invitation":"cgnp4|encrypted-private-invitation","hostId":"host-1","expiresAt":expires})).unwrap();
        let aad = format!("{}:42", record.lease.id);
        let nonce = Nonce::from([7u8; 12]);
        let ciphertext = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .encrypt(
                &nonce,
                Payload {
                    msg: &plaintext,
                    aad: aad.as_bytes(),
                },
            )
            .unwrap();
        serde_json::to_vec(&json!({"version":1,"leaseId":record.lease.id,"runId":42,"ephemeralPublicKey":STANDARD.encode(ephemeral.public_key().to_sec1_point(false).as_bytes()),"nonce":STANDARD.encode([7u8;12]),"ciphertext":STANDARD.encode(ciphertext)})).unwrap()
    }
    #[test]
    fn pairing_authenticates_identity_and_expiry() {
        let record = record();
        let encrypted = encrypted(&record, now() + 60_000);
        assert_eq!(decrypt(&encrypted, &record).unwrap().host_id, "host-1");
        let mut tampered: Value = serde_json::from_slice(&encrypted).unwrap();
        tampered["runId"] = json!(43);
        assert!(decrypt(&serde_json::to_vec(&tampered).unwrap(), &record).is_err());
        let mut wrong = record;
        wrong.private_key = STANDARD.encode(SecretKey::generate().to_bytes());
        assert!(decrypt(&encrypted, &wrong).is_err());
        assert!(decrypt(&self::encrypted(&wrong, now() - 1), &wrong).is_err());
    }
    #[tokio::test]
    async fn ready_requires_valid_encrypted_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let record = record();
        save(dir.path(), &record).unwrap();
        let payload = encrypted(&record, now() + 60_000);
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("pairing.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&payload).unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let artifacts = json!({"total_count":1,"artifacts":[{"id":7,"name":format!("cognia-runner-{}",record.lease.id),"expired":false,"size_in_bytes":bytes.len()}]});
        let gh = Mock::new(vec![
            reply(json!({"id":100,"login":"owner"})),
            reply(run(&record)),
            reply(artifacts),
            Ok(bytes),
        ]);
        let lease = refresh_with(dir.path(), &record.lease.id, &gh)
            .await
            .unwrap();
        assert_eq!(lease.state, State::Ready);
        assert_eq!(lease.host_id.as_deref(), Some("host-1"));
        let persisted =
            std::fs::read_to_string(path(dir.path(), &record.lease.id).unwrap()).unwrap();
        assert!(!persisted.contains("encrypted-private-invitation"));
    }
    #[tokio::test]
    async fn account_switch_cannot_cancel_original_accounts_run() {
        let dir = tempfile::tempdir().unwrap();
        let mut record = record();
        record.cancel_requested = true;
        save(dir.path(), &record).unwrap();
        let gh = Mock::new(vec![reply(json!({"id":999,"login":"other"}))]);
        let lease = refresh_with(dir.path(), &record.lease.id, &gh)
            .await
            .unwrap();
        assert_eq!(lease.state, State::Stopping);
        assert!(lease.error.unwrap().contains("account changed"));
        assert_eq!(gh.calls.lock().unwrap().len(), 1);
        assert!(load(dir.path(), &record.lease.id).is_ok());
    }
    #[test]
    fn reruns_and_foreign_actors_are_not_trusted() {
        let record = record();
        let mut value = run(&record);
        value["run_attempt"] = json!(2);
        assert!(check_run(&value, &record).is_err());
        let mut value = run(&record);
        value["triggering_actor"]["id"] = json!(200);
        assert!(check_run(&value, &record).is_err());
        let mut value = run(&record);
        value["workflow_id"] = json!(20);
        assert!(check_run(&value, &record).is_err());
    }
    #[tokio::test]
    async fn duplicate_run_identity_is_not_selected_arbitrarily() {
        let record = record();
        let gh = Mock::new(vec![reply(
            json!({"workflow_runs":[run(&record),run(&record)]}),
        )]);
        assert!(discover(&gh, &record)
            .await
            .unwrap_err()
            .contains("multiple runs"));
    }
    #[test]
    fn decrypts_the_node_bootstrap_producers_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("node-pairing.fixture.json")).unwrap();
        let mut record = record();
        record.lease.id = fixture["envelope"]["leaseId"].as_str().unwrap().into();
        record.private_key = fixture["privateKey"].as_str().unwrap().into();
        let payload = decrypt_at(
            &serde_json::to_vec(&fixture["envelope"]).unwrap(),
            &record,
            fixture["now"].as_u64().unwrap(),
        )
        .unwrap();
        assert_eq!(payload.host_id, "cross-language-host");
        assert_eq!(payload.invitation, "cgnp4|node-produced-fixture");
    }
    #[tokio::test]
    async fn corrupt_row_does_not_hide_other_recoverable_leases() {
        let dir = tempfile::tempdir().unwrap();
        let record = record();
        save(dir.path(), &record).unwrap();
        let corrupt_id = uuid::Uuid::new_v4().to_string();
        let corrupt = path(dir.path(), &corrupt_id).unwrap();
        std::fs::write(&corrupt, "partial write").unwrap();
        let rows = list(dir.path()).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|row| row.id == record.lease.id && row.state == State::Starting));
        assert!(rows
            .iter()
            .any(|row| row.id == corrupt_id && row.state == State::Unknown && row.error.is_some()));
        assert_eq!(std::fs::read_to_string(corrupt).unwrap(), "partial write");
    }
}
