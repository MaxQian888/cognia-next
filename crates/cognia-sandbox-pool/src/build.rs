//! Owned, bounded Dev Containers builds over immutable Git snapshots.
//!
//! The official CLI implements Dockerfile and Feature semantics. This service
//! owns admission inputs, cancellation, process lifetime and local image identity.
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cognia_environment::store::EnvironmentBuildRecord;
use cognia_external_agent::proc_group::{apply_process_group, kill_process_group};
use parking_lot::Mutex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{watch, Semaphore};

const MAX_OUTPUT: usize = 1024 * 1024;
const MAX_SNAPSHOT: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildRequest {
    pub project_id: String,
    pub cwd: PathBuf,
    pub declaration_path: String,
    pub declaration_digest: String,
    pub declaration_bytes_sha256: String,
    pub commit_sha: String,
    pub platform: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BuildStatus {
    pub job_id: String,
    pub project_id: String,
    pub status: BuildPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<EnvironmentBuildRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BuildPhase {
    Queued,
    Building,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct BuildConfig {
    pub cli: PathBuf,
    pub cli_version: String,
    pub docker: PathBuf,
    pub max_concurrent: usize,
    pub timeout: Duration,
}

impl BuildConfig {
    pub fn from_env() -> Result<Self, String> {
        let cli = std::env::var_os("COGNIA_DEVCONTAINER_CLI")
            .map(PathBuf::from)
            .ok_or("COGNIA_DEVCONTAINER_CLI must name the installed official Dev Containers CLI")?;
        if !cli.is_absolute() {
            return Err("COGNIA_DEVCONTAINER_CLI must be absolute".into());
        }
        let cli_version = std::env::var("COGNIA_DEVCONTAINER_CLI_VERSION")
            .map_err(|_| "COGNIA_DEVCONTAINER_CLI_VERSION must pin its exact version")?;
        if cli_version.trim().is_empty() {
            return Err("Dev Containers CLI version cannot be empty".into());
        }
        let parse = |key: &str, default: u64| -> Result<u64, String> {
            std::env::var(key)
                .ok()
                .map(|value| value.parse().map_err(|_| format!("invalid {key}")))
                .unwrap_or(Ok(default))
        };
        let max_concurrent = parse("COGNIA_ENVIRONMENT_BUILD_CONCURRENCY", 2)?;
        let timeout = parse("COGNIA_ENVIRONMENT_BUILD_TIMEOUT_SECS", 1800)?;
        if !(1..=16).contains(&max_concurrent) || !(1..=7200).contains(&timeout) {
            return Err("build concurrency/timeout is outside supported bounds".into());
        }
        Ok(Self {
            cli,
            cli_version,
            docker: std::env::var_os("COGNIA_DOCKER_CLI")
                .map(PathBuf::from)
                .unwrap_or_else(|| "docker".into()),
            max_concurrent: max_concurrent as usize,
            timeout: Duration::from_secs(timeout),
        })
    }
}

struct Job {
    key: String,
    state: BuildStatus,
    cancel: watch::Sender<bool>,
}

struct BuildTarget<'a> {
    config: &'a Path,
    tag: &'a str,
    platform: &'a str,
    frozen: bool,
    docker: &'a Path,
}

fn split_build_configuration(
    original: &serde_json::Map<String, serde_json::Value>,
    base_tag: &str,
) -> (serde_json::Value, serde_json::Value) {
    let base = original
        .iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "image" | "build" | "dockerFile" | "context" | "workspaceFolder"
            )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    let mut features = original.clone();
    for key in ["build", "dockerFile", "context"] {
        features.remove(key);
    }
    features.insert("image".into(), serde_json::Value::String(base_tag.into()));
    features
        .entry("workspaceFolder")
        .or_insert_with(|| serde_json::Value::String("/workspace".into()));
    (
        serde_json::Value::Object(base),
        serde_json::Value::Object(features),
    )
}

/// Only the official CLI's generated Feature Dockerfile passes through this
/// delegate. It contains decoded raw metadata, so reject host substitutions
/// before Docker receives the Feature context and its substituted builtin.env.
/// Project Dockerfiles are built separately and are never parsed by this guard.
fn write_docker_guard(directory: &Path) -> Result<PathBuf, String> {
    let script = directory.join("feature-docker-guard.cjs");
    std::fs::write(&script, r#"#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const build = args[0] === 'build' || (args[0] === 'buildx' && args[1] === 'build');
if (build) {
  let filename;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '--file') filename = args[++i];
    else if (args[i].startsWith('--file=')) filename = args[i].slice(7);
    else if (args[i].startsWith('-f') && args[i].length > 2) filename = args[i].slice(2);
  }
  try {
    if (!filename || fs.statSync(filename).size > 1048576) throw new Error();
    const source = fs.readFileSync(filename, 'utf8');
    if (source.includes('${localEnv:') || source.includes('${env:')) throw new Error();
  } catch {
    process.stderr.write('Feature metadata contains a forbidden host substitution or invalid generated Dockerfile\n');
    process.exit(78);
  }
}
const result = cp.spawnSync(process.env.COGNIA_BUILD_REAL_DOCKER || 'docker', args, {stdio: 'inherit', shell: false});
if (result.error) { process.stderr.write('Could not start configured Docker executable\n'); process.exit(127); }
process.exit(result.status === null ? 1 : result.status);
"#).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        Ok(script)
    }
    #[cfg(windows)]
    {
        let command = directory.join("feature-docker-guard.cmd");
        std::fs::write(&command, "@node \"%~dp0feature-docker-guard.cjs\" %*\r\n")
            .map_err(|error| error.to_string())?;
        Ok(command)
    }
}
pub type RecordOutput = Arc<dyn Fn(&EnvironmentBuildRecord) -> Result<(), String> + Send + Sync>;

pub struct BuildService {
    config: BuildConfig,
    permits: Arc<Semaphore>,
    jobs: Mutex<HashMap<String, Job>>,
}

impl BuildService {
    pub fn new(config: BuildConfig) -> Result<Arc<Self>, String> {
        if config.max_concurrent == 0 || config.timeout.is_zero() {
            return Err("build bounds must be positive".into());
        }
        Ok(Arc::new(Self {
            permits: Arc::new(Semaphore::new(config.max_concurrent)),
            config,
            jobs: Mutex::new(HashMap::new()),
        }))
    }

    pub fn start(
        self: &Arc<Self>,
        request: BuildRequest,
        record: RecordOutput,
    ) -> Result<BuildStatus, String> {
        validate_request(&request)?;
        let key = hash(&serde_json::to_vec(&request).map_err(|error| error.to_string())?);
        let mut jobs = self.jobs.lock();
        if let Some(job) = jobs.values().find(|job| {
            job.key == key
                && matches!(job.state.status, BuildPhase::Queued | BuildPhase::Building)
                && !*job.cancel.borrow()
        }) {
            return Ok(job.state.clone());
        }
        // Retain a bounded recent history. Active jobs are never evicted.
        if jobs.len() >= 128 {
            let finished = jobs
                .iter()
                .find(|(_, job)| {
                    !matches!(job.state.status, BuildPhase::Queued | BuildPhase::Building)
                })
                .map(|(id, _)| id.clone());
            if let Some(id) = finished {
                jobs.remove(&id);
            } else {
                return Err("environment build queue is full".into());
            }
        }
        let job_id = uuid::Uuid::new_v4().to_string();
        let state = BuildStatus {
            job_id: job_id.clone(),
            project_id: request.project_id.clone(),
            status: BuildPhase::Queued,
            record: None,
            error: None,
        };
        let (cancel, cancelled) = watch::channel(false);
        jobs.insert(
            job_id.clone(),
            Job {
                key,
                state: state.clone(),
                cancel,
            },
        );
        let service = Arc::clone(self);
        tokio::spawn(async move {
            service.work(job_id, request, cancelled, record).await;
        });
        Ok(state)
    }

    pub fn get(&self, project_id: &str, job_id: &str) -> Result<BuildStatus, String> {
        self.jobs
            .lock()
            .get(job_id)
            .filter(|job| job.state.project_id == project_id)
            .map(|job| job.state.clone())
            .ok_or_else(|| "environment build not found for this project".into())
    }

    pub fn cancel(&self, project_id: &str, job_id: &str) -> Result<BuildStatus, String> {
        let jobs = self.jobs.lock();
        let job = jobs
            .get(job_id)
            .filter(|job| job.state.project_id == project_id)
            .ok_or("environment build not found for this project")?;
        job.cancel.send_replace(true);
        Ok(job.state.clone())
    }

    async fn work(
        self: Arc<Self>,
        job_id: String,
        request: BuildRequest,
        mut cancelled: watch::Receiver<bool>,
        record: RecordOutput,
    ) {
        let permit = tokio::select! {
            biased;
            _ = cancellation(&mut cancelled) => { self.finish(&job_id, Err("build cancelled".into()), true); return; }
            permit = self.permits.clone().acquire_owned() => match permit { Ok(permit) => permit, Err(_) => { self.finish(&job_id, Err("build service closed".into()), false); return; } }
        };
        if let Some(job) = self.jobs.lock().get_mut(&job_id) {
            job.state.status = BuildPhase::Building;
        }
        let deadline = tokio::time::Instant::now() + self.config.timeout;
        let tag = format!("cognia-environment-build:{job_id}");
        let result = self
            .build(&request, &tag, &mut cancelled, deadline)
            .await
            .and_then(|output| {
                if *cancelled.borrow() {
                    return Err("build cancelled".into());
                }
                record(&output)?;
                Ok(output)
            });
        let base_tag = format!("{tag}-base");
        for remove in
            std::iter::once(base_tag.as_str()).chain(result.is_err().then_some(tag.as_str()))
        {
            // The tag belongs only to this attempt. Never remove an image ID
            // shared with another successful build or an executing container.
            let mut cleanup = self.command(&self.config.docker);
            cleanup.args(["image", "rm", remove]);
            let (_, mut never_cancelled) = watch::channel(false);
            let _ = run(
                cleanup,
                &mut never_cancelled,
                tokio::time::Instant::now() + Duration::from_secs(30),
            )
            .await;
        }
        self.finish(&job_id, result, *cancelled.borrow());
        drop(permit); // cleanup still owns admission capacity
    }

    fn finish(
        &self,
        job_id: &str,
        result: Result<EnvironmentBuildRecord, String>,
        cancelled: bool,
    ) {
        if let Some(job) = self.jobs.lock().get_mut(job_id) {
            match result {
                Ok(record) => {
                    job.state.status = BuildPhase::Succeeded;
                    job.state.record = Some(record);
                }
                Err(error) => {
                    job.state.status = if cancelled {
                        BuildPhase::Cancelled
                    } else {
                        BuildPhase::Failed
                    };
                    job.state.error = Some(error);
                }
            }
        }
    }

    fn command(&self, binary: &Path) -> Command {
        let mut command = Command::new(binary);
        command.env_clear();
        // Explicit CLI/daemon credentials and transport settings are retained;
        // arbitrary app/provider secrets cannot become ${localEnv:...} inputs.
        for key in [
            "PATH",
            "HOME",
            "USERPROFILE",
            "SYSTEMROOT",
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "DOCKER_CONFIG",
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.env("GIT_TERMINAL_PROMPT", "0");
        command
    }

    fn cli_command(&self, workspace: &Path) -> Command {
        let mut command = self.command(&self.config.cli);
        let scratch = workspace.parent().unwrap_or(workspace);
        command
            .env("TMPDIR", scratch)
            .env("TMP", scratch)
            .env("TEMP", scratch)
            .env("COGNIA_BUILD_REAL_DOCKER", &self.config.docker);
        command
    }

    async fn build_image(
        &self,
        workspace: &Path,
        target: BuildTarget<'_>,
        cancelled: &mut watch::Receiver<bool>,
        deadline: tokio::time::Instant,
    ) -> Result<(), String> {
        let mut build = self.cli_command(workspace);
        build
            .args(["build", "--workspace-folder"])
            .arg(workspace)
            .arg("--config")
            .arg(target.config)
            .arg("--docker-path")
            .arg(target.docker)
            .args([
                "--image-name",
                target.tag,
                "--platform",
                target.platform,
                "--no-cache",
                "--log-format",
                "json",
                "--log-level",
                "info",
            ]);
        if target.frozen {
            build.arg("--frozen-lockfile");
        }
        let output: serde_json::Value =
            serde_json::from_str(&run(build, cancelled, deadline).await?)
                .map_err(|error| format!("Dev Containers build response: {error}"))?;
        if output["outcome"] != "success" {
            return Err(format!(
                "Dev Containers build failed: {}",
                output["message"].as_str().unwrap_or("unknown failure")
            ));
        }
        Ok(())
    }

    async fn check_image_metadata(
        &self,
        tag: &str,
        cancelled: &mut watch::Receiver<bool>,
        deadline: tokio::time::Instant,
    ) -> Result<(), String> {
        let mut inspect = self.command(&self.config.docker);
        inspect.args([
            "image",
            "inspect",
            "--format",
            "{{json .Config.Labels}}",
            tag,
        ]);
        let labels: serde_json::Value =
            serde_json::from_str(&run(inspect, cancelled, deadline).await?)
                .map_err(|error| format!("image labels are unreadable: {error}"))?;
        if let Some(raw) = labels["devcontainer.metadata"].as_str() {
            let metadata: serde_json::Value = serde_json::from_str(raw)
                .map_err(|error| format!("image runtime metadata is invalid: {error}"))?;
            validate_host_substitutions(&metadata)?;
        }
        Ok(())
    }

    async fn build(
        &self,
        request: &BuildRequest,
        tag: &str,
        cancelled: &mut watch::Receiver<bool>,
        deadline: tokio::time::Instant,
    ) -> Result<EnvironmentBuildRecord, String> {
        let mut version = self.command(&self.config.cli);
        version.arg("--version");
        let version = run(version, cancelled, deadline).await?;
        if version.trim() != self.config.cli_version {
            return Err(format!(
                "Dev Containers CLI version mismatch: expected {}, received {}",
                self.config.cli_version,
                version.trim()
            ));
        }
        let platform = request.platform.clone().unwrap_or_else(|| {
            format!(
                "linux/{}",
                if std::env::consts::ARCH == "aarch64" {
                    "arm64"
                } else {
                    "amd64"
                }
            )
        });
        let snapshot = tempfile::tempdir().map_err(|error| error.to_string())?;
        let workspace = snapshot.path().join("workspace");
        std::fs::create_dir(&workspace).map_err(|error| error.to_string())?;
        // Keep CLI workspace and config paths in the same canonical namespace
        // (macOS /var and /private/var aliases otherwise break local Features).
        let workspace = workspace
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut archives = Vec::new();
        let mut pending = vec![(
            request.cwd.clone(),
            request.commit_sha.clone(),
            String::new(),
        )];
        let mut total_bytes = 0u64;
        while let Some((repo, commit, prefix)) = pending.pop() {
            if archives.len() >= 128 {
                return Err("build snapshot has more than 128 submodules".into());
            }
            let archive = snapshot
                .path()
                .join(format!("source-{}.tar", archives.len()));
            let mut git = self.command(Path::new("git"));
            git.arg("-C")
                .arg(&repo)
                .args(["archive", "--format=tar", "--output"])
                .arg(&archive)
                .arg(format!("--prefix={prefix}"))
                .arg(&commit);
            run(git, cancelled, deadline).await?;
            total_bytes += std::fs::metadata(&archive)
                .map_err(|error| error.to_string())?
                .len();
            if total_bytes > MAX_SNAPSHOT {
                return Err("committed build snapshot exceeds 1 GiB".into());
            }
            let input = std::fs::File::open(&archive).map_err(|error| error.to_string())?;
            let destination = workspace.clone();
            let extract_cancelled = cancelled.clone();
            tokio::task::spawn_blocking(move || {
                extract_snapshot(input, &destination, &extract_cancelled, deadline)
            })
            .await
            .map_err(|error| error.to_string())??;
            archives.push(archive);
            let mut tree = self.command(Path::new("git"));
            tree.arg("-C")
                .arg(&repo)
                .args(["ls-tree", "-r", "-z", &commit]);
            for entry in run(tree, cancelled, deadline)
                .await?
                .split('\0')
                .filter(|entry| !entry.is_empty())
            {
                let (head, path) = entry
                    .split_once('\t')
                    .ok_or("unreadable Git snapshot tree")?;
                let fields: Vec<_> = head.split_whitespace().collect();
                if fields.get(1) == Some(&"commit") {
                    let child = contained(&repo, path).map_err(|_| {
                        format!(
                            "initialize submodule {path} at its recorded commit before building"
                        )
                    })?;
                    pending.push((
                        child,
                        fields.get(2).ok_or("missing submodule commit")?.to_string(),
                        format!("{prefix}{path}/"),
                    ));
                }
            }
        }
        let declaration = contained(&workspace, &request.declaration_path)?;
        let declaration_bytes = read_declaration(&declaration)
            .map_err(|error| format!("read snapshotted declaration: {error}"))?;
        if hash(&declaration_bytes) != request.declaration_bytes_sha256 {
            return Err("declaration changed or is not present at the requested commit; review and commit it before building".into());
        }
        let live = contained(&request.cwd, &request.declaration_path)?;
        if hash(&read_declaration(&live)?) != request.declaration_bytes_sha256 {
            return Err("declaration changed since review".into());
        }
        validate_declaration(&declaration_bytes)?;
        let digest_cancelled = cancelled.clone();
        let mut source_digest = tokio::task::spawn_blocking(move || -> Result<Sha256, String> {
            let mut digest = Sha256::new();
            for archive in &archives {
                let mut input = std::fs::File::open(archive).map_err(|error| error.to_string())?;
                let mut buffer = [0; 65536];
                loop {
                    check_operation(&digest_cancelled, deadline)?;
                    let count = std::io::Read::read(&mut input, &mut buffer)
                        .map_err(|error| error.to_string())?;
                    if count == 0 {
                        break;
                    }
                    digest.update(&buffer[..count]);
                }
            }
            Ok(digest)
        })
        .await
        .map_err(|error| error.to_string())??;
        source_digest.update(serde_json::to_vec(request).map_err(|error| error.to_string())?);
        source_digest.update(self.config.cli_version.as_bytes());
        source_digest.update(platform.as_bytes());
        let mut read = self.cli_command(&workspace);
        read.args(["read-configuration", "--workspace-folder"])
            .arg(&workspace)
            .arg("--config")
            .arg(&declaration)
            .args(["--log-level", "info"]);
        let configuration: serde_json::Value =
            serde_json::from_str(&run(read, cancelled, deadline).await?)
                .map_err(|error| format!("Dev Containers configuration response: {error}"))?;
        validate_configuration(&workspace, &declaration, &configuration["configuration"])?;
        if let Some(image) = configuration["configuration"]["image"].as_str() {
            let reference = cognia_environment::image::ImageReference::parse(image)
                .map_err(|error| error.to_string())?;
            if !reference.is_pinned() {
                let mut pull = self.command(&self.config.docker);
                pull.args(["pull", "--platform", &platform, image]);
                run(pull, cancelled, deadline).await?;
            }
        }
        let raw = cognia_external_agent::devin_mcp_config::parse_jsonc(
            std::str::from_utf8(&declaration_bytes).map_err(|error| error.to_string())?,
        )?;
        let base_tag = format!("{tag}-base");
        let (base_config, feature_config) = split_build_configuration(&raw, &base_tag);
        let folder = declaration.parent().ok_or("config parent missing")?;
        let base_path = folder.join(".cognia-base.devcontainer.json");
        let feature_path = folder.join(".cognia-features.devcontainer.json");
        for (path, config) in [(&base_path, &base_config), (&feature_path, &feature_config)] {
            std::fs::write(
                path,
                serde_json::to_vec(config).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        }
        self.build_image(
            &workspace,
            BuildTarget {
                config: &base_path,
                tag: &base_tag,
                platform: &platform,
                frozen: false,
                docker: &self.config.docker,
            },
            cancelled,
            deadline,
        )
        .await?;
        self.check_image_metadata(&base_tag, cancelled, deadline)
            .await?;
        let has_features = feature_config["features"]
            .as_object()
            .is_some_and(|features| !features.is_empty());
        if has_features {
            let lock = folder.join(".devcontainer-lock.json");
            let original_lock = folder.join(
                if declaration
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with('.'))
                {
                    ".devcontainer-lock.json"
                } else {
                    "devcontainer-lock.json"
                },
            );
            if original_lock != lock && original_lock.is_file() {
                std::fs::copy(original_lock, &lock).map_err(|error| error.to_string())?;
            }
            if !lock.is_file() {
                let mut resolve = self.cli_command(&workspace);
                resolve
                    .args(["upgrade", "--workspace-folder"])
                    .arg(&workspace)
                    .arg("--config")
                    .arg(&feature_path)
                    .arg("--docker-path")
                    .arg(&self.config.docker)
                    .args(["--log-level", "info"]);
                run(resolve, cancelled, deadline).await?;
            }
        }
        let guarded_docker = write_docker_guard(snapshot.path())?;
        self.build_image(
            &workspace,
            BuildTarget {
                config: &feature_path,
                tag,
                platform: &platform,
                frozen: has_features,
                docker: &guarded_docker,
            },
            cancelled,
            deadline,
        )
        .await?;
        self.check_image_metadata(tag, cancelled, deadline).await?;
        let mut inspect = self.command(&self.config.docker);
        inspect.args([
            "image",
            "inspect",
            "--format",
            "{{.Id}} {{.Os}}/{{.Architecture}}",
            tag,
        ]);
        let inspected = run(inspect, cancelled, deadline).await?;
        let mut identity = inspected.split_whitespace();
        let image_id = identity
            .next()
            .ok_or("Docker image identity missing")?
            .to_string();
        let actual_platform = identity.next().ok_or("Docker image platform missing")?;
        if actual_platform != platform.trim_end_matches("/v8") {
            return Err(format!(
                "built image platform {actual_platform} does not match {platform}"
            ));
        }
        cognia_environment::image::validate_digest(&image_id).map_err(|error| error.to_string())?;
        // The CLI authored image metadata includes Feature-contributed runtime
        // settings. Ask the same implementation to merge them, without replaying
        // the source declaration and duplicating lifecycle hooks.
        let effective_config = workspace.join(".cognia-effective.devcontainer.json");
        std::fs::write(
            &effective_config,
            serde_json::to_vec(&serde_json::json!({"image":tag,"workspaceFolder":configuration["configuration"]["workspaceFolder"].as_str().unwrap_or("/workspace")}))
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let mut effective = self.cli_command(&workspace);
        effective
            .args(["read-configuration", "--workspace-folder"])
            .arg(&workspace)
            .arg("--config")
            .arg(&effective_config)
            .arg("--docker-path")
            .arg(&self.config.docker)
            .arg("--include-merged-configuration")
            .args(["--log-level", "info"]);
        let effective: serde_json::Value =
            serde_json::from_str(&run(effective, cancelled, deadline).await?)
                .map_err(|error| format!("merged Feature metadata: {error}"))?;
        let mut runtime_configuration = effective
            .get("mergedConfiguration")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or("official CLI did not return merged runtime configuration")?;
        if let Some(runtime) = runtime_configuration.as_object_mut() {
            // CLI transport locations and attempt tags are not runtime policy.
            // Removing them keeps the attested record stable for identical output.
            runtime.remove("configFilePath");
            runtime.remove("image");
        }

        for filename in ["devcontainer-lock.json", ".devcontainer-lock.json"] {
            let lock = declaration
                .parent()
                .ok_or("config parent missing")?
                .join(filename);
            if lock.is_file() {
                source_digest.update(std::fs::read(lock).map_err(|error| error.to_string())?);
            }
        }
        let source_hash = hex::encode(source_digest.finalize());
        let build_key = hash(&[source_hash.as_bytes(), image_id.as_bytes()].concat());
        Ok(EnvironmentBuildRecord {
            build_key,
            image_id,
            project_id: request.project_id.clone(),
            commit_sha: request.commit_sha.clone(),
            declaration_path: request.declaration_path.clone(),
            declaration_digest: request.declaration_digest.clone(),
            declaration_bytes_sha256: request.declaration_bytes_sha256.clone(),
            source_hash,
            runtime_configuration,
            cli_version: self.config.cli_version.clone(),
            platform,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64,
        })
    }
}

fn read_declaration(path: &Path) -> Result<Vec<u8>, String> {
    let input = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bounded = std::io::Read::take(input, 512 * 1024 + 1);
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut bounded, &mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() > 512 * 1024 {
        return Err("build declaration exceeds 512 KiB".into());
    }
    Ok(bytes)
}

fn validate_declaration(bytes: &[u8]) -> Result<(), String> {
    let raw = std::str::from_utf8(bytes).map_err(|_| "build declaration is not UTF-8")?;
    let object = cognia_external_agent::devin_mcp_config::parse_jsonc(raw)
        .map_err(|_| "build declaration is not a valid bounded JSONC object")?;
    let root = serde_json::Value::Object(object);
    validate_host_substitutions(&root)
}

fn validate_host_substitutions(root: &serde_json::Value) -> Result<(), String> {
    let mut pending = vec![root];
    while let Some(value) = pending.pop() {
        let strings = match value {
            serde_json::Value::String(value) => vec![value.as_str()],
            serde_json::Value::Array(values) => {
                pending.extend(values);
                Vec::new()
            }
            serde_json::Value::Object(values) => {
                pending.extend(values.values());
                values.keys().map(String::as_str).collect()
            }
            _ => Vec::new(),
        };
        if strings
            .iter()
            .any(|value| value.contains("${localEnv:") || value.contains("${env:"))
        {
            return Err(
                "host environment substitutions are not permitted in a build declaration".into(),
            );
        }
    }
    Ok(())
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn validate_request(request: &BuildRequest) -> Result<(), String> {
    let hex = |value: &str, length| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    };
    if request.project_id.trim().is_empty()
        || !request.cwd.is_absolute()
        || (!hex(&request.commit_sha, 40) && !hex(&request.commit_sha, 64))
        || !hex(&request.declaration_digest, 64)
        || !hex(&request.declaration_bytes_sha256, 64)
    {
        return Err("invalid environment build identity".into());
    }
    if !matches!(
        request.declaration_path.as_str(),
        ".devcontainer/devcontainer.json" | ".devcontainer.json"
    ) {
        return Err("build declaration must name a Dev Container config".into());
    }
    if request.platform.as_deref().is_some_and(|platform| {
        !matches!(platform, "linux/amd64" | "linux/arm64" | "linux/arm64/v8")
    }) {
        return Err("build platform must be linux/amd64 or linux/arm64".into());
    }
    Ok(())
}

fn contained(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let candidate = root
        .join(relative)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !candidate.starts_with(root) {
        return Err("build path escapes the immutable workspace snapshot".into());
    }
    Ok(candidate)
}

fn validate_configuration(
    workspace: &Path,
    declaration: &Path,
    config: &serde_json::Value,
) -> Result<(), String> {
    let workspace = workspace
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let config = config
        .as_object()
        .ok_or("Dev Containers configuration is not an object")?;
    if config
        .get("build")
        .is_some_and(|build| build.get("options").is_some())
    {
        return Err("arbitrary Docker build options are not permitted".into());
    }
    if config.contains_key("initializeCommand") {
        return Err(
            "initializeCommand cannot run on the Host; move setup into Dockerfile or Features"
                .into(),
        );
    }
    if config.contains_key("dockerComposeFile") {
        return Err("multi-service Docker Compose is not a single sandbox build".into());
    }
    let folder = declaration.parent().ok_or("declaration has no parent")?;
    for value in [
        config.get("dockerFile"),
        config.get("context"),
        config
            .get("build")
            .and_then(|build| build.get("dockerfile")),
        config.get("build").and_then(|build| build.get("context")),
    ]
    .into_iter()
    .flatten()
    {
        let relative = value.as_str().ok_or("build path must be a string")?;
        let resolved = folder
            .join(relative)
            .canonicalize()
            .map_err(|error| format!("build path: {error}"))?;
        if !resolved.starts_with(&workspace) {
            return Err("build context or Dockerfile escapes the immutable snapshot".into());
        }
    }
    if let Some(features) = config
        .get("features")
        .and_then(serde_json::Value::as_object)
    {
        for feature in features.keys().filter(|feature| feature.starts_with('.')) {
            let resolved = folder
                .join(feature)
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !resolved.starts_with(&workspace) {
                return Err("local Feature escapes the immutable snapshot".into());
            }
        }
    }
    Ok(())
}

fn check_operation(
    cancelled: &watch::Receiver<bool>,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    if *cancelled.borrow() {
        return Err("build cancelled".into());
    }
    if tokio::time::Instant::now() >= deadline {
        return Err("environment build timed out".into());
    }
    Ok(())
}

fn extract_snapshot(
    file: std::fs::File,
    workspace: &Path,
    cancelled: &watch::Receiver<bool>,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(file);
    for (index, entry) in archive
        .entries()
        .map_err(|error| error.to_string())?
        .enumerate()
    {
        check_operation(cancelled, deadline)?;
        if index >= MAX_ENTRIES {
            return Err("build snapshot has too many entries".into());
        }
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .into_owned();
        if path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("invalid path in Git build snapshot".into());
        }
        if let Some(link) = entry.link_name().map_err(|error| error.to_string())? {
            let mut depth = path
                .parent()
                .map(|parent| parent.components().count())
                .unwrap_or(0);
            for part in link.components() {
                match part {
                    Component::ParentDir if depth == 0 => {
                        return Err("build snapshot symlink escapes workspace".into())
                    }
                    Component::ParentDir => depth -= 1,
                    Component::Normal(_) => depth += 1,
                    Component::CurDir => {}
                    _ => return Err("absolute link in build snapshot".into()),
                }
            }
        }
        if !entry
            .unpack_in(workspace)
            .map_err(|error| error.to_string())?
        {
            return Err("snapshot entry escapes workspace".into());
        }
    }
    Ok(())
}

async fn cancellation(cancelled: &mut watch::Receiver<bool>) {
    loop {
        if *cancelled.borrow() {
            return;
        }
        if cancelled.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

async fn capture(
    mut stream: impl AsyncRead + Unpin,
    machine_output: bool,
) -> Result<Vec<u8>, String> {
    let mut overflow = false;
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        let keep = count.min(MAX_OUTPUT.saturating_sub(result.len()));
        overflow |= keep != count;
        result.extend_from_slice(&buffer[..keep]);
    }
    if overflow && machine_output {
        return Err("build tool machine output exceeds 1 MiB; refusing incomplete output".into());
    }
    Ok(result)
}

async fn run(
    mut command: Command,
    cancelled: &mut watch::Receiver<bool>,
    deadline: tokio::time::Instant,
) -> Result<String, String> {
    if *cancelled.borrow() {
        return Err("build cancelled".into());
    }
    if tokio::time::Instant::now() >= deadline {
        return Err("environment build timed out".into());
    }
    apply_process_group(&mut command);
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("start build tool: {error}"))?;
    let pid = child.id();
    let stdout = tokio::spawn(capture(
        child.stdout.take().ok_or("missing build stdout")?,
        true,
    ));
    let stderr = tokio::spawn(capture(
        child.stderr.take().ok_or("missing build stderr")?,
        false,
    ));
    let status = tokio::select! {
        biased;
        _=cancellation(cancelled)=>Err("build cancelled".to_string()),
        _=tokio::time::sleep_until(deadline)=>Err("environment build timed out".to_string()),
        status=child.wait()=>status.map_err(|error| error.to_string()),
    };
    kill_process_group(pid);
    if status.is_err() {
        #[cfg(windows)]
        if let Some(pid) = pid {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output()
                .await;
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let out = stdout.await.map_err(|error| error.to_string())??;
    let err = stderr.await.map_err(|error| error.to_string())??;
    let status = status?;
    if !status.success() {
        let mut diagnostic = String::from_utf8_lossy(&err).into_owned();
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "HOME",
            "USERPROFILE",
            "DOCKER_HOST",
            "DOCKER_CONFIG",
            "DOCKER_CERT_PATH",
        ] {
            if let Ok(value) = std::env::var(key) {
                if !value.is_empty() {
                    diagnostic = diagnostic.replace(&value, "[Host environment redacted]");
                }
            }
        }
        return Err(format!("build tool exited {status}: {}", diagnostic));
    }
    String::from_utf8(out).map_err(|error| format!("build tool output is not UTF-8: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn base_build_does_not_publish_project_runtime_metadata_before_features() {
        let original = serde_json::json!({"build":{"dockerfile":"Dockerfile"}, "features":{"./feature":{}}, "containerEnv":{"ORDER":"project"}, "postCreateCommand":"project hook", "remoteUser":"vscode"});
        let (base, feature) =
            split_build_configuration(original.as_object().unwrap(), "owned-base");
        assert_eq!(
            base,
            serde_json::json!({"build":{"dockerfile":"Dockerfile"}})
        );
        assert_eq!(feature["postCreateCommand"], "project hook");
        assert_eq!(feature["containerEnv"]["ORDER"], "project");
        assert_eq!(feature["remoteUser"], "vscode");
        assert!(feature.get("build").is_none());
        assert_eq!(feature["image"], "owned-base");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn actual_feature_dockerfile_guard_refuses_before_docker_receives_context() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let guard = write_docker_guard(root.path()).unwrap();
        let marker = root.path().join("delegated");
        let docker = root.path().join("docker");
        std::fs::write(
            &docker,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o700)).unwrap();
        let generated = root.path().join("Dockerfile-with-features");
        for raw in [
            r#"{"remoteUser":"\u0024{localEnv:HTTPS_PROXY}"}"#,
            r#"{"remoteEnv":{"TOKEN":"${env:HTTPS_PROXY}"}}"#,
        ] {
            let decoded: serde_json::Value = serde_json::from_str(raw).unwrap();
            std::fs::write(
                &generated,
                format!(
                    "FROM owned-base\nLABEL devcontainer.metadata={}\n",
                    serde_json::to_string(&decoded).unwrap()
                ),
            )
            .unwrap();
            let mut command = Command::new(&guard);
            command
                .env("COGNIA_BUILD_REAL_DOCKER", &docker)
                .args(["buildx", "build", "-f"])
                .arg(&generated)
                .arg(".");
            let (_cancel, mut cancelled) = watch::channel(false);
            assert!(run(
                command,
                &mut cancelled,
                tokio::time::Instant::now() + Duration::from_secs(5)
            )
            .await
            .unwrap_err()
            .contains("forbidden host substitution"));
            assert!(!marker.exists());
        }
        std::fs::write(
            &generated,
            "FROM owned-base\nLABEL devcontainer.metadata=\"[]\"\n",
        )
        .unwrap();
        let mut command = Command::new(&guard);
        command
            .env("COGNIA_BUILD_REAL_DOCKER", &docker)
            .args(["buildx", "build", "--file"])
            .arg(&generated)
            .arg(".");
        let (_cancel, mut cancelled) = watch::channel(false);
        run(
            command,
            &mut cancelled,
            tokio::time::Instant::now() + Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert!(marker.exists());
    }

    #[test]
    fn escaped_host_environment_references_are_refused_before_cli_resolution() {
        for bytes in [
            br#"{"build":{"args":{"TOKEN":"\u0024{localEnv:HTTPS_PROXY}"}}}"#.as_slice(),
            br#"{/*comment*/"features":{"./local":{"option":"$\u007blocalEnv:HOME}"}},}"#
                .as_slice(),
        ] {
            assert!(validate_declaration(bytes).is_err());
        }
        assert!(validate_declaration(
            br#"{// valid comment
            "build":{"args":{"PATH":"${containerEnv:PATH}"}},}"#
        )
        .is_ok());
    }

    #[tokio::test]
    async fn machine_output_overflow_cannot_silently_drop_snapshot_entries() {
        let bytes = vec![b'x'; MAX_OUTPUT + 1];
        assert!(capture(bytes.as_slice(), true).await.is_err());
        assert_eq!(
            capture(bytes.as_slice(), false).await.unwrap().len(),
            MAX_OUTPUT
        );
    }

    #[tokio::test]
    #[ignore = "requires explicit Dev Containers CLI and scoped Docker daemon"]
    async fn official_cli_builds_dockerfile_and_local_feature() {
        let root = PathBuf::from(
            std::env::var("COGNIA_TEST_BUILD_WORKSPACE").expect("explicit committed fixture"),
        );
        let commit = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let bytes = std::fs::read(root.join(".devcontainer/devcontainer.json")).unwrap();
        let request = BuildRequest {
            project_id: "live-feature-test".into(),
            cwd: root,
            declaration_path: ".devcontainer/devcontainer.json".into(),
            declaration_digest: hash(&bytes),
            declaration_bytes_sha256: hash(&bytes),
            commit_sha: String::from_utf8(commit.stdout).unwrap().trim().into(),
            platform: None,
        };
        let service = BuildService::new(BuildConfig::from_env().unwrap()).unwrap();
        let tag = format!("cognia-environment-build:live-{}", uuid::Uuid::new_v4());
        let (_cancel, mut cancelled) = watch::channel(false);
        let result = service
            .build(
                &request,
                &tag,
                &mut cancelled,
                tokio::time::Instant::now() + Duration::from_secs(120),
            )
            .await;
        let expected_refusal = std::env::var("COGNIA_TEST_EXPECT_REFUSAL").ok();
        if let Some(record) = result.as_ref().ok().filter(|_| expected_refusal.is_none()) {
            let mut verify = service.command(&service.config.docker);
            verify.args([
                "run",
                "--rm",
                "--network",
                "none",
                &record.image_id,
                "/bin/sh",
                "-c",
                "test -f /cognia-feature-complete && test -f /cognia-dockerfile-complete && test \"$COGNIA_FEATURE_SMOKE\" = yes && test \"$ORDER\" = project",
            ]);
            run(
                verify,
                &mut cancelled,
                tokio::time::Instant::now() + Duration::from_secs(30),
            )
            .await
            .unwrap();
            assert_eq!(
                record.runtime_configuration["postCreateCommands"],
                serde_json::json!([
                    "touch /cognia-feature-runtime",
                    "touch /cognia-project-runtime"
                ])
            );
            println!(
                "official CLI {} built and verified {} with Feature environment and lifecycle metadata",
                record.cli_version, record.image_id
            );
        }
        let mut cleanup = service.command(&service.config.docker);
        cleanup.args(["image", "rm", "-f", &tag, &format!("{tag}-base")]);
        let _ = run(
            cleanup,
            &mut cancelled,
            tokio::time::Instant::now() + Duration::from_secs(30),
        )
        .await;
        match expected_refusal {
            Some(expected) => {
                let error = result.unwrap_err();
                assert!(error.contains(&expected), "{error}");
                if let Ok(forbidden) = std::env::var("COGNIA_TEST_FORBIDDEN_DIAGNOSTIC") {
                    assert!(!error.contains(&forbidden));
                }
                println!(
                    "official CLI refused untrusted metadata before Feature submission: {expected}"
                );
            }
            None => {
                result.unwrap();
            }
        }
    }

    #[cfg(unix)]
    fn fixture() -> (tempfile::TempDir, BuildConfig, BuildRequest) {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".devcontainer")).unwrap();
        let contents=br#"{"build":{"dockerfile":"Dockerfile","context":".."},"features":{"ghcr.io/devcontainers/features/node:1":{"version":"22"}}}"#;
        std::fs::write(
            root.path().join(".devcontainer/devcontainer.json"),
            contents,
        )
        .unwrap();
        std::fs::write(
            root.path().join(".devcontainer/Dockerfile"),
            b"FROM scratch\n",
        )
        .unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["add", "."],
            vec![
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "fixture",
            ],
        ] {
            assert!(std::process::Command::new("git")
                .arg("-C")
                .arg(root.path())
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        let commit = std::process::Command::new("git")
            .arg("-C")
            .arg(root.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let cli = root.path().join("devcontainer");
        std::fs::write(&cli,"#!/bin/sh\ncase \"$1\" in\n--version) echo 0.89.0;;\nread-configuration) echo '{\"mergedConfiguration\":{\"configFilePath\":{\"path\":\"/temporary/attempt\"},\"image\":\"attempt-tag\",\"containerEnv\":{\"FEATURE\":\"yes\"}},\"configuration\":{\"build\":{\"dockerfile\":\"Dockerfile\",\"context\":\"..\"},\"features\":{\"ghcr.io/devcontainers/features/node:1\":{\"version\":\"22\"}}}}';;\nupgrade) :;;\nbuild) echo '{\"outcome\":\"success\"}';;\n*) exit 2;;\nesac\n").unwrap();
        let docker = root.path().join("docker");
        std::fs::write(
            &docker,
            format!(
                "#!/bin/sh\nif [ \"$2\" = inspect ]; then case \"$4\" in *Labels*) echo null;; *) echo sha256:{} linux/arm64;; esac; fi\n",
                "a".repeat(64)
            ),
        )
        .unwrap();
        for executable in [&cli, &docker] {
            std::fs::set_permissions(executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let config = BuildConfig {
            cli,
            cli_version: "0.89.0".into(),
            docker,
            max_concurrent: 1,
            timeout: Duration::from_secs(5),
        };
        let request = BuildRequest {
            project_id: "project".into(),
            cwd: root.path().to_path_buf(),
            declaration_path: ".devcontainer/devcontainer.json".into(),
            declaration_digest: "d".repeat(64),
            declaration_bytes_sha256: hash(contents),
            commit_sha: String::from_utf8(commit.stdout).unwrap().trim().into(),
            platform: Some("linux/arm64".into()),
        };
        (root, config, request)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn committed_feature_lock_is_preserved_and_build_requires_it_frozen() {
        let (root, config, mut request) = fixture();
        let lock = br#"{"features":{"ghcr.io/devcontainers/features/node:1":{"version":"1.0.0","resolved":"ghcr.io/devcontainers/features/node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","integrity":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}"#;
        std::fs::write(
            root.path().join(".devcontainer/devcontainer-lock.json"),
            lock,
        )
        .unwrap();
        for args in [
            vec!["add", ".devcontainer/devcontainer-lock.json"],
            vec![
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "locked feature",
            ],
        ] {
            assert!(std::process::Command::new("git")
                .arg("-C")
                .arg(root.path())
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        request.commit_sha = String::from_utf8(
            std::process::Command::new("git")
                .arg("-C")
                .arg(root.path())
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .into();
        let script = std::fs::read_to_string(&config.cli)
            .unwrap()
            .replace("upgrade) :;;", "upgrade) exit 88;;");
        let script = script.replace("build) echo", "build) case \"$*\" in *.cognia-features.devcontainer.json*) case \"$*\" in *--frozen-lockfile*) :;; *) exit 89;; esac;; esac; echo");
        std::fs::write(&config.cli, script).unwrap();
        let service = BuildService::new(config).unwrap();
        let (_cancel, mut cancelled) = watch::channel(false);
        service
            .build(
                &request,
                "test",
                &mut cancelled,
                tokio::time::Instant::now() + Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(root.path().join(".devcontainer/devcontainer-lock.json")).unwrap(),
            lock
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn builds_coalesce_then_record_real_local_identity_without_reusing_mutable_inputs() {
        let (_root, config, request) = fixture();
        let cli = config.cli.clone();
        let service = BuildService::new(config).unwrap();
        let records = Arc::new(Mutex::new(Vec::new()));
        let capture = records.clone();
        let store =
            Mutex::new(cognia_environment::store::EnvironmentStore::open_in_memory().unwrap());
        let record: RecordOutput = Arc::new(move |record| {
            store
                .lock()
                .record_build(record)
                .map_err(|error| error.to_string())?;
            capture.lock().push(record.clone());
            Ok(())
        });
        let first = service.start(request.clone(), record.clone()).unwrap();
        let second = service.start(request.clone(), record.clone()).unwrap();
        assert_eq!(first.job_id, second.job_id);
        let ready = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = service.get("project", &first.job_id).unwrap();
                if !matches!(state.status, BuildPhase::Queued | BuildPhase::Building) {
                    break state;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(ready.status, BuildPhase::Succeeded, "{:?}", ready.error);
        assert_eq!(
            ready.record.unwrap().image_id,
            format!("sha256:{}", "a".repeat(64))
        );
        assert_eq!(records.lock().len(), 1);
        assert!(records.lock()[0]
            .runtime_configuration
            .get("configFilePath")
            .is_none());
        assert!(records.lock()[0]
            .runtime_configuration
            .get("image")
            .is_none());
        assert_eq!(
            records.lock()[0].runtime_configuration["containerEnv"]["FEATURE"],
            "yes"
        );
        assert!(service.get("another-project", &first.job_id).is_err());
        let script = std::fs::read_to_string(&cli)
            .unwrap()
            .replace("/temporary/attempt", "/another/attempt")
            .replace("attempt-tag", "new-attempt-tag");
        std::fs::write(cli, script).unwrap();
        let third = service.start(request.clone(), record.clone()).unwrap();
        assert_ne!(first.job_id, third.job_id);
        let repeated = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = service.get("project", &third.job_id).unwrap();
                if !matches!(state.status, BuildPhase::Queued | BuildPhase::Building) {
                    break state;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            repeated.status,
            BuildPhase::Succeeded,
            "{:?}",
            repeated.error
        );
        let entries = records.lock();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].build_key, entries[1].build_key);
        assert_eq!(
            entries[0].runtime_configuration,
            entries[1].runtime_configuration
        );
        drop(entries);
        let fourth = service.start(request, record).unwrap();
        service.cancel("project", &fourth.job_id).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn source_changes_after_review_refuse_before_building() {
        let (root, config, request) = fixture();
        std::fs::write(root.path().join(".devcontainer/devcontainer.json"), b"{}").unwrap();
        let service = BuildService::new(config).unwrap();
        let (_cancel, mut cancelled) = watch::channel(false);
        let error = service
            .build(
                &request,
                "unused",
                &mut cancelled,
                tokio::time::Instant::now() + Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(error.contains("changed since review"), "{error}");
    }

    #[tokio::test]
    async fn cancellation_reaps_owned_process_and_returns_promptly() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & wait"]);
        let (cancel, mut cancelled) = watch::channel(false);
        let task = tokio::spawn(async move {
            run(
                command,
                &mut cancelled,
                tokio::time::Instant::now() + Duration::from_secs(10),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancel.send_replace(true);
        assert!(tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .contains("cancelled"));
    }
    #[tokio::test]
    async fn timeout_reaps_a_build_process() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let (_cancel, mut cancelled) = watch::channel(false);
        assert!(run(
            command,
            &mut cancelled,
            tokio::time::Instant::now() + Duration::from_millis(30)
        )
        .await
        .unwrap_err()
        .contains("timed out"));
    }
    #[test]
    fn contexts_and_host_initializers_cannot_escape_the_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(workspace.join(".devcontainer")).unwrap();
        let declaration = workspace.join(".devcontainer/devcontainer.json");
        assert!(validate_configuration(
            &workspace,
            &declaration,
            &serde_json::json!({"build":{"context":"../../"}})
        )
        .is_err());
        assert!(validate_configuration(
            &workspace,
            &declaration,
            &serde_json::json!({"initializeCommand":"touch /tmp/host"})
        )
        .is_err());
        assert!(validate_configuration(&workspace,&declaration,&serde_json::json!({"build":{"context":"../"},"features":{"ghcr.io/devcontainers/features/node:1":{"version":"22"}}})).is_ok());
    }
}
