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
/// `up --wait` gives the server this long to report healthy.
const UP_WAIT_SECS: &str = "300";

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
    /// Its brain was refused: a server and brain from different builds,
    /// which waiting will not fix (ADR-0224 A10a).
    Refused(String),
    /// Not ready yet, or not answering.
    NotReady(String),
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
    match body.get("status").and_then(Value::as_str) {
        Some("ready") => Readiness::Ready,
        Some(other) => Readiness::NotReady(other.to_owned()),
        None => Readiness::NotReady("readyz answered without a status".into()),
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
    /// value when `None`), and wait for its health check.
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
        let mut command = self.compose(at, Some(image));
        command.args(["config", "--format", "json"]);
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
        command
            .args([
                "up",
                "-d",
                "--no-deps",
                "--no-build",
                "--wait",
                "--wait-timeout",
            ])
            .arg(UP_WAIT_SECS)
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
                Err(_) => Readiness::NotReady("readyz did not answer JSON".into()),
            },
            Err(error) => Readiness::NotReady(error),
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
        assert!(matches!(readiness_of(&json!({})), Readiness::NotReady(_)));
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
