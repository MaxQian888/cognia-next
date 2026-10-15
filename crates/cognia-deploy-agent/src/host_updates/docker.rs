//! The Compose stack, as the agent drives it through the Docker CLI.
//!
//! The agent does not keep its own copy of the operator's Compose setup. It
//! finds the running server container by its Compose labels and reads back
//! how the operator started it (project, working directory, config files, env
//! files), then runs `docker compose` with exactly those, so a recreated
//! server keeps every overlay and setting it had. The commands run with a
//! cleared environment: only Docker's own variables pass through, so nothing
//! in the agent's environment can leak into Compose's interpolation.

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::process::Command;

use super::env_file::SERVER_IMAGE_VAR;

const PROJECT_LABEL: &str = "com.docker.compose.project";
const SERVICE_LABEL: &str = "com.docker.compose.service";
const WORKING_DIR_LABEL: &str = "com.docker.compose.project.working_dir";
const CONFIG_FILES_LABEL: &str = "com.docker.compose.project.config_files";
const ENV_FILES_LABEL: &str = "com.docker.compose.project.environment_file";
const ONE_OFF_LABEL: &str = "com.docker.compose.oneoff";
/// The server image names its platform (`Dockerfile.cognia-server`).
const HOST_TARGET_ENV: &str = "COGNIA_HOST_TARGET";
/// Variables Docker itself reads; nothing else reaches the CLI.
const DOCKER_ENV: [&str; 8] = [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "XDG_RUNTIME_DIR",
];

/// The server container, and how Compose started it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerContainer {
    pub id: String,
    pub running: bool,
    pub project: String,
    pub service: String,
    pub working_dir: PathBuf,
    pub config_files: Vec<PathBuf>,
    pub env_files: Vec<PathBuf>,
    /// The image as configured (`ghcr.io/x/cognia-server:latest-full`, or a
    /// `repository@digest` once pinned).
    pub configured_image: String,
    /// The local image id it runs.
    pub image_id: String,
    /// `repository@digest` names of that image, from `docker image inspect`.
    pub repo_digests: Vec<String>,
    /// `oci-full-amd64`, … from the image's environment.
    pub target: Option<String>,
}

impl ServerContainer {
    /// The registry name of what it runs, preferring its own repository.
    pub fn pinned_reference(&self) -> Option<String> {
        let repository = repository_of(&self.configured_image);
        self.repo_digests
            .iter()
            .find(|reference| repository_of(reference) == repository)
            .or_else(|| self.repo_digests.first())
            .cloned()
    }

    /// Whether it runs the image `repository@digest` names.
    pub fn runs(&self, reference: &str) -> bool {
        let Some((_, digest)) = reference.rsplit_once('@') else {
            return false;
        };
        self.repo_digests
            .iter()
            .any(|known| known.rsplit_once('@').map(|(_, d)| d) == Some(digest))
    }

    /// The env file the agent pins the image in: the last one that sets it,
    /// else the last one Compose reads (`<working dir>/.env` by default).
    pub fn image_env_file(&self) -> PathBuf {
        let files: Vec<PathBuf> = if self.env_files.is_empty() {
            vec![self.working_dir.join(".env")]
        } else {
            self.env_files.clone()
        };
        files
            .iter()
            .rev()
            .find(|path| {
                std::fs::read_to_string(path).is_ok_and(|content| {
                    super::env_file::read_var(&content, SERVER_IMAGE_VAR).is_some()
                })
            })
            .or_else(|| files.last())
            .cloned()
            .unwrap_or_else(|| self.working_dir.join(".env"))
    }
}

/// `ghcr.io/x/cognia-server:tag` / `…@sha256:…` → `ghcr.io/x/cognia-server`.
pub fn repository_of(reference: &str) -> &str {
    let without_digest = reference.split('@').next().unwrap_or(reference);
    match without_digest.rfind(':') {
        Some(colon) if !without_digest[colon..].contains('/') => &without_digest[..colon],
        _ => without_digest,
    }
}

/// What the server's `/readyz` says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Readiness {
    Ready,
    /// A modern response separates runtime failures from all other checks.
    RuntimeHealth {
        failed_required: Vec<String>,
        otherwise_ready: bool,
        baseline_ready: bool,
    },
    /// Its brain was refused: a server and brain from different builds,
    /// which waiting will not fix (ADR-0224 A10a).
    Refused(String),
    /// A valid response says the server is not ready yet.
    NotReady(String),
    /// No trustworthy status was received; never assume its failure baseline is empty.
    Unavailable(String),
}

impl Readiness {
    pub fn failed_required(&self) -> Result<Vec<String>, String> {
        match self {
            Self::RuntimeHealth { failed_required, baseline_ready: true, .. } => Ok(failed_required.clone()),
            Self::RuntimeHealth { .. } => Err("cannot record runtime failures until the brain is connected, bootstrapped and required restarts complete".into()),
            Self::Unavailable(reason) => Err(format!(
                "could not record required runtime failures before update: {reason}"
            )),
            _ => Ok(Vec::new()),
        }
    }

    /// Exempt only the named failures observed before the update. Bootstrap,
    /// restart, storage, drain, bridge and every other readiness check still apply.
    pub fn for_trial(self, baseline: &[String]) -> Self {
        match self {
            Self::RuntimeHealth {
                failed_required,
                otherwise_ready,
                ..
            } if otherwise_ready && failed_required.iter().all(|name| baseline.contains(name)) => {
                Self::Ready
            }
            Self::RuntimeHealth { .. } => {
                Self::NotReady("required runtime or host checks are not ready".into())
            }
            other => other,
        }
    }
}

/// Read `/readyz`'s JSON body.
pub fn readiness_of(body: &Value) -> Readiness {
    if let Some(refusal) = body.get("brainRefusal") {
        let reason = refusal
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("refused");
        return Readiness::Refused(reason.to_owned());
    }
    if !matches!(
        body.get("status").and_then(Value::as_str),
        Some("ready" | "not_ready")
    ) {
        return Readiness::Unavailable("readyz answered without a recognized status".into());
    }
    if let Some(checks) = body.get("checks").and_then(Value::as_object) {
        if [
            "bootstrapped",
            "requiredRuntimes",
            "failedRequiredRuntimes",
            "restartingRequiredRuntimes",
        ]
        .iter()
        .any(|name| checks.contains_key(*name))
        {
            let Some(failed_required) = checks
                .get("failedRequiredRuntimes")
                .and_then(Value::as_array)
                .and_then(|names| {
                    names
                        .iter()
                        .map(|name| name.as_str().map(str::to_owned))
                        .collect::<Option<Vec<_>>>()
                })
            else {
                return Readiness::Unavailable(
                    "readyz answered with invalid required failures".into(),
                );
            };
            if checks
                .get("bootstrapped")
                .and_then(Value::as_bool)
                .is_none()
                || checks
                    .get("requiredRuntimes")
                    .and_then(Value::as_bool)
                    .is_none()
                || !checks
                    .get("restartingRequiredRuntimes")
                    .and_then(Value::as_array)
                    .is_some_and(|names| names.iter().all(Value::is_string))
            {
                return Readiness::Unavailable(
                    "readyz answered with incomplete runtime health".into(),
                );
            }
            // Require the entire known check set and validate future checks too:
            // a baseline must never mask a different reason for not being ready.
            let otherwise_ready = [
                "acceptingWrites",
                "storage",
                "brain",
                "sidecar",
                "gateway",
                "configRevision",
                "headlessContract",
                "bootstrapped",
            ]
            .iter()
            .all(|name| checks.get(*name).and_then(Value::as_bool) == Some(true))
                && checks.get("draining").and_then(Value::as_bool) == Some(false)
                && checks.get("requiredRuntimes").and_then(Value::as_bool)
                    == Some(failed_required.is_empty())
                && checks.iter().all(|(name, value)| match name.as_str() {
                    "failedRequiredRuntimes" | "requiredRuntimes" => true,
                    "restartingRequiredRuntimes" => value.as_array().is_some_and(Vec::is_empty),
                    "draining" => value.as_bool() == Some(false),
                    _ => value.as_bool() == Some(true),
                })
                && checks
                    .get("restartingRequiredRuntimes")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty);
            return Readiness::RuntimeHealth {
                failed_required,
                otherwise_ready,
                baseline_ready: checks.get("brain").and_then(Value::as_bool) == Some(true)
                    && checks.get("bootstrapped").and_then(Value::as_bool) == Some(true)
                    && checks
                        .get("restartingRequiredRuntimes")
                        .and_then(Value::as_array)
                        .is_some_and(Vec::is_empty),
            };
        }
    }
    match body.get("status").and_then(Value::as_str) {
        Some("ready") => Readiness::Ready,
        Some("not_ready") => Readiness::NotReady("not_ready".into()),
        Some(other) => Readiness::Unavailable(format!("unknown readyz status: {other}")),
        None => Readiness::Unavailable("readyz answered without a status".into()),
    }
}

/// Parse `docker inspect <container>` (one element) and the image's repo
/// digests into a [`ServerContainer`].
pub fn parse_container(
    inspect: &Value,
    repo_digests: Vec<String>,
) -> Result<ServerContainer, String> {
    let container = inspect
        .as_array()
        .and_then(|items| items.first())
        .unwrap_or(inspect);
    let labels = &container["Config"]["Labels"];
    let label = |name: &str| labels.get(name).and_then(Value::as_str).map(str::to_owned);
    let split = |raw: Option<String>| -> Vec<PathBuf> {
        raw.map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
    };
    let working_dir = label(WORKING_DIR_LABEL)
        .map(PathBuf::from)
        .ok_or("the server container carries no Compose working directory label")?;
    let config_files = split(label(CONFIG_FILES_LABEL));
    if config_files.is_empty() {
        return Err("the server container carries no Compose config files label".into());
    }
    let target = container["Config"]["Env"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find_map(|entry| entry.strip_prefix(&format!("{HOST_TARGET_ENV}=")))
        .map(str::to_owned);
    Ok(ServerContainer {
        id: container["Id"]
            .as_str()
            .ok_or("docker inspect gave no container id")?
            .to_owned(),
        running: container["State"]["Running"].as_bool().unwrap_or(false),
        project: label(PROJECT_LABEL).ok_or("the server container has no Compose project")?,
        service: label(SERVICE_LABEL).ok_or("the server container has no Compose service")?,
        working_dir,
        config_files,
        env_files: split(label(ENV_FILES_LABEL)),
        configured_image: container["Config"]["Image"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        image_id: container["Image"].as_str().unwrap_or_default().to_owned(),
        repo_digests,
        target,
    })
}

/// The Compose stack's server, as the agent acts on it.
#[async_trait]
pub trait ComposeHost: Send + Sync {
    /// The server container as it runs now.
    async fn locate(&self) -> Result<ServerContainer, String>;
    /// The image Compose would run for the server with `image` pinned.
    async fn resolved_image(&self, at: &ServerContainer, image: &str) -> Result<String, String>;
    async fn pull(&self, at: &ServerContainer, image: &str) -> Result<(), String>;
    /// Recreate only the server, with `image` pinned (or the env file's own
    /// value when `None`). The trial supervisor owns readiness and its deadline.
    async fn recreate(&self, at: &ServerContainer, image: Option<&str>) -> Result<(), String>;
    /// Ask the running server's `/readyz` from inside its container.
    async fn readiness(&self, at: &ServerContainer) -> Readiness;
}

/// The real stack, through `docker` and `docker compose`.
pub struct DockerCli {
    docker: PathBuf,
    project: String,
    service: String,
    ready_url: String,
}

impl DockerCli {
    pub fn new(docker: PathBuf, project: String, service: String, ready_url: String) -> Self {
        Self {
            docker,
            project,
            service,
            ready_url,
        }
    }

    fn docker(&self) -> Command {
        let mut command = Command::new(&self.docker);
        command.env_clear();
        for name in DOCKER_ENV {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.kill_on_drop(true);
        command
    }

    fn compose(&self, at: &ServerContainer, image: Option<&str>) -> Command {
        let mut command = self.docker();
        command
            .current_dir(&at.working_dir)
            .arg("compose")
            .arg("--project-name")
            .arg(&at.project)
            .arg("--project-directory")
            .arg(&at.working_dir);
        for file in &at.config_files {
            command.arg("-f").arg(file);
        }
        for file in &at.env_files {
            command.arg("--env-file").arg(file);
        }
        if let Some(image) = image {
            command.env(SERVER_IMAGE_VAR, image);
        }
        command
    }

    /// `compose config` for the server alone. The service is named because
    /// Compose drops a service whose profile is not active, and the stack's
    /// server sits behind `profiles: [server]`: untargeted, the config has no
    /// such service and `adopt` refused every real deployment.
    fn config_command(&self, at: &ServerContainer, image: &str) -> Command {
        let mut command = self.compose(at, Some(image));
        command
            .args(["config", "--format", "json"])
            .arg(&at.service);
        command
    }

    async fn image_digests(&self, image_id: &str) -> Result<Vec<String>, String> {
        let mut command = self.docker();
        command
            .args(["image", "inspect", "--format", "{{json .RepoDigests}}"])
            .arg(image_id);
        let output = run(command, Duration::from_secs(60)).await?;
        let digests: Vec<String> = serde_json::from_str(output.trim()).unwrap_or_default();
        Ok(digests)
    }
}

async fn run(mut command: Command, timeout: Duration) -> Result<String, String> {
    let shown = format!("{:?}", command.as_std().get_args().collect::<Vec<_>>());
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| format!("docker {shown} did not finish in time"))?
        .map_err(|error| format!("docker {shown}: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr
            .lines()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("docker {shown} failed: {tail}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[async_trait]
impl ComposeHost for DockerCli {
    async fn locate(&self) -> Result<ServerContainer, String> {
        let mut list = self.docker();
        list.args(["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.State}}"])
            .arg("--filter")
            .arg(format!("label={PROJECT_LABEL}={}", self.project))
            .arg("--filter")
            .arg(format!("label={SERVICE_LABEL}={}", self.service))
            .arg("--filter")
            .arg(format!("label={ONE_OFF_LABEL}=False"));
        let listed = run(list, Duration::from_secs(30)).await?;
        let mut ids: Vec<(&str, bool)> = listed
            .lines()
            .filter_map(|line| {
                let (id, state) = line.split_once(' ')?;
                Some((id, state.trim() == "running"))
            })
            .collect();
        // A running one first; `docker ps` lists newest first otherwise.
        ids.sort_by_key(|(_, running)| !*running);
        let (id, _) = ids.first().copied().ok_or_else(|| {
            format!(
                "no {} container in Compose project {}; start the stack first",
                self.service, self.project
            )
        })?;
        let mut inspect = self.docker();
        inspect.arg("inspect").arg(id);
        let raw = run(inspect, Duration::from_secs(30)).await?;
        let value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let image_id = value[0]["Image"].as_str().unwrap_or_default().to_owned();
        let digests = if image_id.is_empty() {
            Vec::new()
        } else {
            self.image_digests(&image_id).await?
        };
        parse_container(&value, digests)
    }

    async fn resolved_image(&self, at: &ServerContainer, image: &str) -> Result<String, String> {
        let command = self.config_command(at, image);
        let raw = run(command, Duration::from_secs(60)).await?;
        let config: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        config["services"][&at.service]["image"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("the Compose config has no {} image", at.service))
    }

    async fn pull(&self, at: &ServerContainer, image: &str) -> Result<(), String> {
        let mut command = self.compose(at, Some(image));
        command.args(["pull", "--quiet"]).arg(&at.service);
        run(command, Duration::from_secs(30 * 60)).await.map(|_| ())
    }

    async fn recreate(&self, at: &ServerContainer, image: Option<&str>) -> Result<(), String> {
        let mut command = self.compose(at, image);
        // Waiting on Compose health here would reject a pre-existing required
        // failure before the baseline-aware trial gets a chance to assess it.
        command
            .args(["up", "-d", "--no-deps", "--no-build"])
            .arg(&at.service);
        run(command, Duration::from_secs(10 * 60)).await.map(|_| ())
    }

    async fn readiness(&self, at: &ServerContainer) -> Readiness {
        // The same curl the image's health check uses; the server's TLS
        // certificate is its own, so `-k` inside its own container only.
        let mut command = self.docker();
        command
            .args(["exec", &at.id, "curl", "-ksS", "--max-time", "5"])
            .arg(&self.ready_url);
        match run(command, Duration::from_secs(20)).await {
            Ok(body) => match serde_json::from_str::<Value>(&body) {
                Ok(body) => readiness_of(&body),
                Err(_) => Readiness::Unavailable("readyz did not answer JSON".into()),
            },
            Err(error) => Readiness::Unavailable(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inspect() -> Value {
        json!([{
            "Id": "c0ffee",
            "Image": "sha256:1111",
            "State": { "Running": true },
            "Config": {
                "Image": "ghcr.io/x/cognia-server:latest-full",
                "Env": ["PATH=/usr/bin", "COGNIA_HOST_TARGET=oci-full-amd64"],
                "Labels": {
                    "com.docker.compose.project": "cognia",
                    "com.docker.compose.service": "cognia-server",
                    "com.docker.compose.project.working_dir": "/srv/cognia/deploy/compose",
                    "com.docker.compose.project.config_files": "/srv/cognia/deploy/compose/docker-compose.yml,/srv/cognia/deploy/compose/docker-compose.t2.yml",
                    "com.docker.compose.project.environment_file": "/srv/cognia/deploy/compose/.env"
                }
            }
        }])
    }

    #[test]
    fn reads_how_compose_started_the_server() {
        let digest = format!("ghcr.io/x/cognia-server@sha256:{}", "a".repeat(64));
        let container = parse_container(
            &inspect(),
            vec!["mirror.test/cognia@sha256:bb".into(), digest.clone()],
        )
        .unwrap();
        assert_eq!(container.id, "c0ffee");
        assert!(container.running);
        assert_eq!(container.project, "cognia");
        assert_eq!(container.config_files.len(), 2);
        assert_eq!(
            container.env_files,
            vec![PathBuf::from("/srv/cognia/deploy/compose/.env")]
        );
        assert_eq!(container.target.as_deref(), Some("oci-full-amd64"));
        assert_eq!(container.pinned_reference(), Some(digest.clone()));
        assert!(container.runs(&digest));
        assert!(!container.runs("ghcr.io/x/cognia-server@sha256:cc"));
        assert!(!container.runs("ghcr.io/x/cognia-server:latest"));
    }

    #[test]
    fn config_targets_the_server_so_its_profile_applies() {
        let container = parse_container(&inspect(), Vec::new()).unwrap();
        let cli = DockerCli::new(
            PathBuf::from("docker"),
            "cognia".into(),
            "cognia-server".into(),
            "https://127.0.0.1:27890/readyz".into(),
        );
        let command = cli.config_command(&container, "ghcr.io/x/cognia-server@sha256:aa");
        let args: Vec<String> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let config = args.iter().position(|arg| arg == "config").unwrap();
        assert_eq!(
            &args[config..],
            ["config", "--format", "json", "cognia-server"]
        );
    }

    #[test]
    fn a_container_compose_did_not_start_is_refused() {
        let mut value = inspect();
        value[0]["Config"]["Labels"]
            .as_object_mut()
            .unwrap()
            .remove("com.docker.compose.project.config_files");
        assert!(parse_container(&value, Vec::new())
            .unwrap_err()
            .contains("config files"));
    }

    #[test]
    fn a_repository_is_the_reference_without_tag_or_digest() {
        assert_eq!(repository_of("ghcr.io/x/s:tag"), "ghcr.io/x/s");
        assert_eq!(repository_of("ghcr.io/x/s@sha256:aa"), "ghcr.io/x/s");
        assert_eq!(repository_of("localhost:5000/s"), "localhost:5000/s");
        assert_eq!(repository_of("localhost:5000/s:1"), "localhost:5000/s");
    }

    #[test]
    fn readyz_says_ready_refused_or_not_yet() {
        assert_eq!(readiness_of(&json!({"status": "ready"})), Readiness::Ready);
        assert_eq!(
            readiness_of(
                &json!({"status": "not_ready", "brainRefusal": {"reason": "contract_mismatch"}})
            ),
            Readiness::Refused("contract_mismatch".into())
        );
        assert!(matches!(
            readiness_of(&json!({"status": "not_ready"})),
            Readiness::NotReady(_)
        ));
        assert!(matches!(
            readiness_of(&json!({})),
            Readiness::Unavailable(_)
        ));
    }

    fn required_failure() -> Value {
        json!({ "status": "not_ready", "checks": {
            "draining": false, "acceptingWrites": true, "storage": true,
            "brain": true, "sidecar": true, "gateway": true,
            "configRevision": true, "headlessContract": true, "bootstrapped": true,
            "requiredRuntimes": false, "failedRequiredRuntimes": ["connector-runtime"],
            "restartingRequiredRuntimes": []
        }})
    }

    #[test]
    fn only_baseline_required_failures_are_exempted_for_trials() {
        let response = required_failure();
        let readiness = readiness_of(&response);
        assert_eq!(
            readiness.failed_required().unwrap(),
            vec!["connector-runtime"]
        );
        assert_eq!(
            readiness.clone().for_trial(&["connector-runtime".into()]),
            Readiness::Ready
        );
        assert!(matches!(readiness.for_trial(&[]), Readiness::NotReady(_)));
        let mut new_failure = response;
        new_failure["checks"]["failedRequiredRuntimes"] = json!(["connector-runtime", "scheduler"]);
        assert!(matches!(
            readiness_of(&new_failure).for_trial(&["connector-runtime".into()]),
            Readiness::NotReady(_)
        ));
    }

    #[test]
    fn baseline_failures_do_not_mask_bootstrap_restarts_or_other_checks() {
        let baseline = vec!["connector-runtime".into()];
        for (name, value) in [
            ("bootstrapped", json!(false)),
            ("brain", json!(false)),
            ("storage", json!(false)),
            ("acceptingWrites", json!(false)),
            ("draining", json!(true)),
            ("configRevision", json!(false)),
            ("headlessContract", json!(false)),
            ("sidecar", json!(false)),
            ("gateway", json!(false)),
            ("futureCheck", json!(false)),
            ("restartingRequiredRuntimes", json!(["connector-runtime"])),
        ] {
            let mut response = required_failure();
            response["checks"][name] = value;
            assert!(
                matches!(
                    readiness_of(&response).for_trial(&baseline),
                    Readiness::NotReady(_)
                ),
                "{name}"
            );
        }
        let mut malformed = required_failure();
        malformed["checks"]["failedRequiredRuntimes"] = json!([1]);
        assert!(matches!(
            readiness_of(&malformed).for_trial(&baseline),
            Readiness::Unavailable(_)
        ));
        let mut missing_failures = required_failure();
        missing_failures["checks"]
            .as_object_mut()
            .unwrap()
            .remove("failedRequiredRuntimes");
        assert!(readiness_of(&missing_failures).failed_required().is_err());
        let mut missing_bootstrap = required_failure();
        missing_bootstrap["checks"]
            .as_object_mut()
            .unwrap()
            .remove("bootstrapped");
        assert!(readiness_of(&missing_bootstrap).failed_required().is_err());
        let mut missing_status = required_failure();
        missing_status.as_object_mut().unwrap().remove("status");
        assert!(readiness_of(&missing_status).failed_required().is_err());
        let mut missing_check = required_failure();
        missing_check["checks"]
            .as_object_mut()
            .unwrap()
            .remove("storage");
        assert!(matches!(
            readiness_of(&missing_check).for_trial(&baseline),
            Readiness::NotReady(_)
        ));
    }

    #[test]
    fn incomplete_runtime_reports_cannot_be_saved_as_update_baselines() {
        for (name, value) in [
            ("bootstrapped", json!(false)),
            ("brain", json!(false)),
            ("restartingRequiredRuntimes", json!(["scheduler"])),
        ] {
            let mut response = required_failure();
            response["checks"][name] = value;
            assert!(readiness_of(&response).failed_required().is_err(), "{name}");
        }
        let mut drained = required_failure();
        drained["checks"]["draining"] = json!(true);
        drained["checks"]["acceptingWrites"] = json!(false);
        assert_eq!(
            readiness_of(&drained).failed_required().unwrap(),
            vec!["connector-runtime"]
        );
    }

    #[test]
    fn legacy_and_optional_failures_keep_their_readiness_behavior() {
        let legacy =
            json!({ "status": "ready", "degraded": true, "failedRuntimes": ["scheduler"] });
        assert_eq!(readiness_of(&legacy).for_trial(&[]), Readiness::Ready);
        // Older servers can be drained while recording the update baseline.
        let old_draining = json!({ "status": "not_ready", "checks": { "draining": true, "acceptingWrites": false } });
        assert!(readiness_of(&old_draining)
            .failed_required()
            .unwrap()
            .is_empty());
        assert!(matches!(
            readiness_of(&old_draining).for_trial(&[]),
            Readiness::NotReady(_)
        ));
        let mut optional = required_failure();
        optional["status"] = json!("ready");
        optional["checks"]["requiredRuntimes"] = json!(true);
        optional["checks"]["failedRequiredRuntimes"] = json!([]);
        optional["failedRuntimes"] = json!(["backup-scheduler"]);
        optional["degraded"] = json!(true);
        assert_eq!(readiness_of(&optional).for_trial(&[]), Readiness::Ready);
    }

    #[test]
    fn the_image_is_pinned_in_the_env_file_that_sets_it() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("a.env");
        let second = tmp.path().join("b.env");
        std::fs::write(&first, "COGNIA_SERVER_IMAGE=x\n").unwrap();
        std::fs::write(&second, "OTHER=1\n").unwrap();
        let mut container = parse_container(&inspect(), Vec::new()).unwrap();
        container.env_files = vec![first.clone(), second.clone()];
        assert_eq!(container.image_env_file(), first);
        std::fs::write(&second, "COGNIA_SERVER_IMAGE=y\n").unwrap();
        assert_eq!(container.image_env_file(), second);
        container.env_files.clear();
        container.working_dir = tmp.path().to_path_buf();
        assert_eq!(container.image_env_file(), tmp.path().join(".env"));
    }
}
