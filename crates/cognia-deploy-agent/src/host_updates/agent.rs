//! The agent's side of a Compose host's update (ADR-0224 A10).
//!
//! 1. **Check**, as the host would: the signed catalog for the host's channel
//!    and platform, then the Worker's rollout gate
//!    ([`check_host_release`]). The host only says which version it expects;
//!    a different answer is a refusal.
//! 2. **Pull** the release's `repository@digest`, confirming first that the
//!    operator's Compose files take the server image from
//!    `COGNIA_SERVER_IMAGE` (otherwise nothing the agent pins would run).
//!    The swap is recorded, then the host is told `accepted`.
//! 3. **Switch**: pin the digest in the project's env file and recreate only
//!    the server container (`up --no-deps --wait`).
//! 4. **Prove it** like a native host proves a new version: commit once
//!    `/readyz` has stayed ready for the settle period; roll back on a refused
//!    brain or at the deadline, by pinning the old build again and recreating.

use std::sync::Arc;
use std::time::Duration;

use cognia_host_service::install_home::{UpdateOutcome, UpdateResult};
use cognia_host_service::update_agent::{
    AcceptedUpdate, AgentPhase, AgentRequest, AgentResponse, AgentStatus, AgentTrial, UpdateRequest,
};
use cognia_update_catalog::client::{check_host_release, HostCheck, TrustFile, UpdateNetwork};
use cognia_update_catalog::RootPayload;
use parking_lot::Mutex;
use serde::Serialize;

use super::docker::{ComposeHost, Readiness, ServerContainer};
use super::env_file::{read_var, set_var, write_preserving, SERVER_IMAGE_VAR};
use super::state::{AgentState, PendingSwap, StateFile};

/// How long a new version has to prove itself (as on a native host).
pub const TRIAL_WINDOW: Duration = Duration::from_secs(10 * 60);
/// How long `/readyz` must stay ready before the swap commits.
pub const TRIAL_SETTLE: Duration = Duration::from_secs(30);
/// Between readiness probes during a trial.
pub const TRIAL_POLL: Duration = Duration::from_secs(5);

/// Channels a host may follow (`normalize_channel` on the host).
const CHANNELS: [&str; 2] = ["stable", "beta"];

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub trial_window: Duration,
    pub settle: Duration,
    pub poll: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            trial_window: TRIAL_WINDOW,
            settle: TRIAL_SETTLE,
            poll: TRIAL_POLL,
        }
    }
}

/// What `host-updates adopt` found and pinned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptReport {
    pub project: String,
    pub service: String,
    pub image: String,
    pub env_file: String,
    pub target: Option<String>,
}

pub struct HostUpdateAgent {
    compose: Arc<dyn ComposeHost>,
    network: Arc<dyn UpdateNetwork>,
    root: Option<RootPayload>,
    trust: TrustFile,
    state: StateFile,
    timing: Timing,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    inner: Mutex<Inner>,
}

#[derive(Debug)]
struct Inner {
    phase: AgentPhase,
    last_error: Option<String>,
}

impl HostUpdateAgent {
    pub fn new(
        compose: Arc<dyn ComposeHost>,
        network: Arc<dyn UpdateNetwork>,
        root: Option<RootPayload>,
        state: StateFile,
        timing: Timing,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self {
            compose,
            network,
            root,
            trust: TrustFile::new(state.trust_path()),
            state,
            timing,
            clock,
            inner: Mutex::new(Inner {
                phase: AgentPhase::Idle,
                last_error: None,
            }),
        })
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn set_phase(&self, phase: AgentPhase) {
        self.inner.lock().phase = phase;
    }

    pub fn status(&self) -> AgentStatus {
        let (state, load_error) = match self.state.load() {
            Ok(state) => (state, None),
            Err(error) => (AgentState::default(), Some(error)),
        };
        let inner = self.inner.lock();
        AgentStatus {
            phase: inner.phase,
            image: state.image,
            trial: state.pending.map(|pending| AgentTrial {
                attempt_id: pending.attempt_id,
                from: pending.from,
                to: pending.to,
                deadline_ms: pending.deadline_ms,
            }),
            last_outcome: state.last_outcome,
            last_error: load_error.or_else(|| inner.last_error.clone()),
        }
    }

    /// Answer one socket request; `true` asks the caller to [`Self::activate`]
    /// once the answer is written.
    pub async fn answer(&self, request: AgentRequest) -> (AgentResponse, bool) {
        match request {
            AgentRequest::Status => (AgentResponse::Status(self.status()), false),
            AgentRequest::Update(request) => match self.update(&request).await {
                Ok(accepted) => (AgentResponse::Accepted(accepted), true),
                Err(error) => (AgentResponse::Refused { error }, false),
            },
        }
    }

    /// Check, pull and record a swap; the server is untouched until
    /// [`Self::activate`].
    pub async fn update(&self, request: &UpdateRequest) -> Result<AcceptedUpdate, String> {
        {
            let mut inner = self.inner.lock();
            if inner.phase != AgentPhase::Idle {
                return Err("an update is already in progress".into());
            }
            inner.phase = AgentPhase::Pulling;
        }
        let result = self.prepare(request).await;
        let mut inner = self.inner.lock();
        match &result {
            Ok(_) => {
                inner.phase = AgentPhase::Activating;
                inner.last_error = None;
            }
            Err(error) => {
                inner.phase = AgentPhase::Idle;
                inner.last_error = Some(error.clone());
            }
        }
        result
    }

    async fn prepare(&self, request: &UpdateRequest) -> Result<AcceptedUpdate, String> {
        let mut state = self.state.load()?;
        if state.pending.is_some() {
            return Err("an update is already in progress".into());
        }
        if !CHANNELS.contains(&request.channel.as_str()) {
            return Err(format!("{:?} is not a release channel", request.channel));
        }
        let root = self
            .root
            .as_ref()
            .ok_or("this deploy agent ships no update trust root")?;
        let at = self.located().await?;
        let target = at
            .target
            .clone()
            .filter(|target| target.starts_with("oci-"))
            .ok_or("the server image does not name its platform (COGNIA_HOST_TARGET)")?;
        let release = check_host_release(
            self.network.as_ref(),
            root,
            &self.trust,
            &HostCheck {
                channel: request.channel.clone(),
                target,
                current_version: request.current_version.clone(),
                bucket: request.bucket.min(9_999),
                manual: request.manual,
                now_ms: self.now(),
            },
        )
        .await?
        .ok_or("no release is rolling for this host")?;
        if release.version != request.expect_version {
            return Err(format!(
                "the deploy agent finds {} rolling, not {}",
                release.version, request.expect_version
            ));
        }
        let image = release
            .artifact
            .image_reference()
            .ok_or("the release is not a server image")?;
        if at.runs(&image) {
            return Err(format!("this host already runs {}", release.version));
        }
        self.confirm_pinnable(&at, &image).await?;
        let env_file = visible_env_file(&at)?;
        self.compose.pull(&at, &image).await?;

        let previous_env = std::fs::read_to_string(&env_file)
            .ok()
            .and_then(|content| read_var(&content, SERVER_IMAGE_VAR));
        let now = self.now();
        let pending = PendingSwap {
            attempt_id: format!("{now:x}-{:x}", std::process::id()),
            from: request.current_version.clone(),
            to: release.version.clone(),
            image: image.clone(),
            env_file,
            previous_env,
            rollback_image: at.pinned_reference(),
            started_at_ms: now,
            deadline_ms: now + self.timing.trial_window.as_millis() as i64,
            activated: false,
        };
        state.pending = Some(pending.clone());
        self.state.save(&state)?;
        tracing::info!(
            from = %pending.from,
            to = %pending.to,
            image = %pending.image,
            "host update accepted"
        );
        Ok(AcceptedUpdate {
            attempt_id: pending.attempt_id,
            from: pending.from,
            to: pending.to,
            image,
        })
    }

    async fn located(&self) -> Result<ServerContainer, String> {
        let at = self.compose.locate().await?;
        if !at.working_dir.is_dir() {
            return Err(format!(
                "{} is not visible to the deploy agent; mount the Compose directory at the same path",
                at.working_dir.display()
            ));
        }
        Ok(at)
    }

    /// Whether pinning `COGNIA_SERVER_IMAGE` actually changes what runs.
    async fn confirm_pinnable(&self, at: &ServerContainer, image: &str) -> Result<(), String> {
        let resolved = self.compose.resolved_image(at, image).await?;
        if resolved != image {
            return Err(format!(
                "the Compose files do not take the {} image from {SERVER_IMAGE_VAR}, so the agent cannot pin it",
                at.service
            ));
        }
        Ok(())
    }

    /// Switch the server to the recorded swap and prove it. Returns how it
    /// ended, or `None` when no swap was recorded.
    pub async fn activate(&self) -> Option<UpdateOutcome> {
        let mut pending = match self.state.load() {
            Ok(state) => state.pending?,
            Err(error) => {
                self.inner.lock().last_error = Some(error);
                return None;
            }
        };
        self.set_phase(AgentPhase::Activating);
        if let Err(error) = pin(&pending.env_file, Some(&pending.image)) {
            return Some(
                self.roll_back(pending, format!("could not pin the new image: {error}"))
                    .await,
            );
        }
        pending.activated = true;
        if let Err(error) = self.save_pending(&pending) {
            return Some(self.roll_back(pending, error).await);
        }
        let switched = async {
            let at = self.compose.locate().await?;
            self.compose
                .recreate(&at, Some(&pending.image))
                .await
                .map_err(|error| format!("the new server did not start: {error}"))?;
            let now_running = self.compose.locate().await?;
            if !now_running.runs(&pending.image) {
                return Err("Compose did not run the new image".to_owned());
            }
            Ok(())
        }
        .await;
        if let Err(error) = switched {
            return Some(self.roll_back(pending, error).await);
        }
        Some(self.supervise(pending).await)
    }

    /// Finish a swap the agent was in when it stopped.
    pub async fn resume(&self) -> Option<UpdateOutcome> {
        let pending = self.state.load().ok()?.pending?;
        if !pending.activated {
            return Some(
                self.roll_back(
                    pending,
                    "the deploy agent restarted before it switched the server".into(),
                )
                .await,
            );
        }
        tracing::info!(to = %pending.to, "resuming a host update trial");
        Some(self.supervise(pending).await)
    }

    async fn supervise(&self, pending: PendingSwap) -> UpdateOutcome {
        self.set_phase(AgentPhase::Trial);
        let settle = self.timing.settle.as_millis() as i64;
        let mut ready_since: Option<i64> = None;
        loop {
            let now = self.now();
            let readiness = match self.compose.locate().await {
                Ok(at) if at.running => self.compose.readiness(&at).await,
                Ok(_) => Readiness::NotReady("the server is not running".into()),
                Err(error) => Readiness::NotReady(error),
            };
            match readiness {
                Readiness::Refused(reason) => {
                    return self
                        .roll_back(pending, format!("its server refused its brain ({reason})"))
                        .await;
                }
                Readiness::Ready => {
                    let since = *ready_since.get_or_insert(now);
                    if now - since >= settle {
                        return self.commit(pending);
                    }
                }
                Readiness::NotReady(_) => ready_since = None,
            }
            if now > pending.deadline_ms {
                return self
                    .roll_back(pending, "it did not become ready in time".into())
                    .await;
            }
            tokio::time::sleep(self.timing.poll).await;
        }
    }

    fn save_pending(&self, pending: &PendingSwap) -> Result<(), String> {
        let mut state = self.state.load()?;
        state.pending = Some(pending.clone());
        self.state.save(&state)
    }

    fn finish(&self, outcome: UpdateOutcome, image: Option<String>) -> UpdateOutcome {
        let result = self.state.load().and_then(|mut state| {
            state.pending = None;
            if image.is_some() {
                state.image = image;
            }
            state.last_outcome = Some(outcome.clone());
            self.state.save(&state)
        });
        let mut inner = self.inner.lock();
        inner.phase = AgentPhase::Idle;
        inner.last_error = result.err();
        outcome
    }

    fn commit(&self, pending: PendingSwap) -> UpdateOutcome {
        tracing::info!(to = %pending.to, "host update installed");
        let outcome = UpdateOutcome {
            attempt_id: pending.attempt_id,
            from: pending.from,
            to: pending.to,
            result: UpdateResult::Installed,
            reason: None,
            at_ms: self.now(),
        };
        self.finish(outcome, Some(pending.image))
    }

    async fn roll_back(&self, pending: PendingSwap, reason: String) -> UpdateOutcome {
        self.set_phase(AgentPhase::Activating);
        let restore = pending.restore_value().map(str::to_owned);
        let mut reason = reason;
        if let Err(error) = pin(&pending.env_file, restore.as_deref()) {
            reason.push_str(&format!("; could not restore the env file: {error}"));
        }
        if pending.activated {
            let restarted = async {
                let at = self.compose.locate().await?;
                self.compose.recreate(&at, restore.as_deref()).await
            }
            .await;
            if let Err(error) = restarted {
                reason.push_str(&format!(
                    "; restarting the previous version failed: {error}"
                ));
            }
        }
        tracing::error!(from = %pending.from, to = %pending.to, %reason, "host update rolled back");
        let outcome = UpdateOutcome {
            attempt_id: pending.attempt_id,
            from: pending.from,
            to: pending.to,
            result: UpdateResult::RolledBack,
            reason: Some(reason),
            at_ms: self.now(),
        };
        let pinned = pending.rollback_image.clone();
        self.finish(outcome, pinned)
    }

    /// Pin the image the server runs now, so later updates and rollbacks
    /// have an exact build to return to.
    pub async fn adopt(&self) -> Result<AdoptReport, String> {
        let at = self.located().await?;
        let image = at.pinned_reference().ok_or(
            "the server image has no registry digest; pull it from a registry instead of building it locally",
        )?;
        self.confirm_pinnable(&at, &image).await?;
        let env_file = visible_env_file(&at)?;
        pin(&env_file, Some(&image))?;
        let mut state = self.state.load()?;
        state.image = Some(image.clone());
        self.state.save(&state)?;
        Ok(AdoptReport {
            project: at.project,
            service: at.service,
            image,
            env_file: env_file.display().to_string(),
            target: at.target,
        })
    }
}

/// The env file the image is pinned in, if the agent can reach it.
fn visible_env_file(at: &ServerContainer) -> Result<std::path::PathBuf, String> {
    let env_file = at.image_env_file();
    if !env_file.parent().is_some_and(std::path::Path::is_dir) {
        return Err(format!(
            "{} is not visible to the deploy agent; keep the env file in the Compose directory",
            env_file.display()
        ));
    }
    Ok(env_file)
}

fn pin(env_file: &std::path::Path, image: Option<&str>) -> Result<(), String> {
    let content = match std::fs::read_to_string(env_file) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("{}: {error}", env_file.display())),
    };
    let updated = set_var(&content, SERVER_IMAGE_VAR, image);
    if updated == content {
        return Ok(());
    }
    write_preserving(env_file, &updated)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    use async_trait::async_trait;
    use cognia_update_catalog::client::{RolloutAnswer, RolloutQuery};
    use cognia_update_catalog::test_support;
    use serde_json::{json, Value};

    pub const REPO: &str = "ghcr.io/x/cognia-server";
    pub const BASE_MS: i64 = 1_790_000_000_000;

    pub fn digest_ref(fill: char) -> String {
        format!("{REPO}@sha256:{}", fill.to_string().repeat(64))
    }

    /// A Compose stack in memory: one server container whose image follows
    /// what `recreate` pins, readiness answers in order (the last repeats).
    pub struct FakeCompose {
        pub working_dir: PathBuf,
        pub running: Mutex<String>,
        pub resolves_to: Mutex<Option<String>>,
        pub pull_error: Mutex<Option<String>>,
        pub recreate_error: Mutex<Option<String>>,
        pub readiness: Mutex<Vec<Readiness>>,
        pub pulls: Mutex<Vec<String>>,
        pub recreates: Mutex<Vec<Option<String>>>,
    }

    impl FakeCompose {
        pub fn new(working_dir: &Path) -> Self {
            Self {
                working_dir: working_dir.to_path_buf(),
                running: Mutex::new(digest_ref('a')),
                resolves_to: Mutex::new(None),
                pull_error: Mutex::new(None),
                recreate_error: Mutex::new(None),
                readiness: Mutex::new(vec![Readiness::Ready]),
                pulls: Mutex::new(Vec::new()),
                recreates: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl ComposeHost for FakeCompose {
        async fn locate(&self) -> Result<ServerContainer, String> {
            let running = self.running.lock().clone();
            Ok(ServerContainer {
                id: "c1".into(),
                running: true,
                project: "cognia".into(),
                service: "cognia-server".into(),
                working_dir: self.working_dir.clone(),
                config_files: vec![self.working_dir.join("docker-compose.yml")],
                env_files: Vec::new(),
                configured_image: format!("{REPO}:latest-full"),
                image_id: "sha256:local".into(),
                repo_digests: vec![running],
                target: Some("oci-full-amd64".into()),
            })
        }
        async fn resolved_image(&self, _: &ServerContainer, image: &str) -> Result<String, String> {
            Ok(self
                .resolves_to
                .lock()
                .clone()
                .unwrap_or_else(|| image.to_owned()))
        }
        async fn pull(&self, _: &ServerContainer, image: &str) -> Result<(), String> {
            self.pulls.lock().push(image.to_owned());
            self.pull_error.lock().clone().map_or(Ok(()), Err)
        }
        async fn recreate(&self, _: &ServerContainer, image: Option<&str>) -> Result<(), String> {
            self.recreates.lock().push(image.map(str::to_owned));
            if let Some(error) = self.recreate_error.lock().take() {
                return Err(error);
            }
            if let Some(image) = image {
                *self.running.lock() = image.to_owned();
            }
            Ok(())
        }
        async fn readiness(&self, _: &ServerContainer) -> Readiness {
            let mut answers = self.readiness.lock();
            if answers.len() > 1 {
                answers.remove(0)
            } else {
                answers[0].clone()
            }
        }
    }

    pub struct FakeWorker {
        pub bundle: Mutex<Option<Value>>,
        pub answer: Mutex<Option<RolloutAnswer>>,
    }

    #[async_trait]
    impl UpdateNetwork for FakeWorker {
        async fn catalog(&self, _: &str) -> Result<Option<Value>, String> {
            Ok(self.bundle.lock().clone())
        }
        async fn rollout(&self, _: &RolloutQuery) -> Result<Option<RolloutAnswer>, String> {
            Ok(self.answer.lock().clone())
        }
        async fn download(&self, _: &str, _: &Path, _: u64) -> Result<(), String> {
            Err("a Compose host downloads no archives".into())
        }
    }

    /// A signed 1.5.0 image release rolling for everyone.
    pub fn worker() -> FakeWorker {
        let digest = digest_ref('b');
        let (repository, digest) = digest.split_once('@').unwrap();
        FakeWorker {
            bundle: Mutex::new(Some(test_support::sign_bundle(
                test_support::host_release_entries(
                    "1.5.0",
                    "stable",
                    "oci-full-amd64",
                    json!({ "image": repository, "digest": digest }),
                ),
                1,
                chrono::DateTime::from_timestamp_millis(BASE_MS).unwrap(),
            ))),
            answer: Mutex::new(Some(RolloutAnswer {
                version: "1.5.0".into(),
                digest: Some(digest.to_owned()),
            })),
        }
    }

    pub struct Harness {
        pub tmp: tempfile::TempDir,
        pub compose: Arc<FakeCompose>,
        pub worker: Arc<FakeWorker>,
        pub agent: Arc<HostUpdateAgent>,
    }

    impl Harness {
        pub fn env(&self) -> String {
            std::fs::read_to_string(self.tmp.path().join(".env")).unwrap_or_default()
        }
    }

    pub fn harness() -> Harness {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(".env"),
            "COGNIA_INSTANCE=cognia\nCOGNIA_SERVER_IMAGE=ghcr.io/x/cognia-server:latest-full\n",
        )
        .unwrap();
        let compose = Arc::new(FakeCompose::new(tmp.path()));
        let worker = Arc::new(worker());
        let start = tokio::time::Instant::now();
        let agent = HostUpdateAgent::new(
            compose.clone(),
            worker.clone(),
            Some(test_support::root()),
            StateFile::new(tmp.path().join("state")),
            Timing {
                trial_window: Duration::from_secs(600),
                settle: Duration::from_secs(30),
                poll: Duration::from_secs(5),
            },
            Arc::new(move || BASE_MS + start.elapsed().as_millis() as i64),
        );
        Harness {
            tmp,
            compose,
            worker,
            agent,
        }
    }

    pub fn request(expect: &str) -> UpdateRequest {
        UpdateRequest {
            channel: "stable".into(),
            bucket: 10,
            manual: true,
            current_version: "1.4.0".into(),
            expect_version: expect.into(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_update_pulls_pins_recreates_and_commits_once_ready() {
        let h = harness();
        let accepted = h.agent.update(&request("1.5.0")).await.unwrap();
        assert_eq!(
            (accepted.from.as_str(), accepted.to.as_str()),
            ("1.4.0", "1.5.0")
        );
        assert_eq!(accepted.image, digest_ref('b'));
        assert_eq!(*h.compose.pulls.lock(), vec![digest_ref('b')]);
        // Nothing switched before `accepted` reaches the host.
        assert!(h.compose.recreates.lock().is_empty());
        assert!(h
            .env()
            .contains("COGNIA_SERVER_IMAGE=ghcr.io/x/cognia-server:latest-full"));
        assert_eq!(h.agent.status().phase, AgentPhase::Activating);
        assert_eq!(h.agent.status().trial.unwrap().to, "1.5.0");

        *h.compose.readiness.lock() =
            vec![Readiness::NotReady("starting".into()), Readiness::Ready];
        let outcome = h.agent.activate().await.unwrap();
        assert_eq!(outcome.result, UpdateResult::Installed);
        assert_eq!(outcome.to, "1.5.0");
        assert_eq!(*h.compose.recreates.lock(), vec![Some(digest_ref('b'))]);
        assert!(h
            .env()
            .contains(&format!("COGNIA_SERVER_IMAGE={}", digest_ref('b'))));
        assert!(
            h.env().starts_with("COGNIA_INSTANCE=cognia\n"),
            "the rest is kept"
        );
        let status = h.agent.status();
        assert_eq!(status.phase, AgentPhase::Idle);
        assert_eq!(status.image.as_deref(), Some(digest_ref('b').as_str()));
        assert!(status.trial.is_none());
        assert_eq!(status.last_outcome.unwrap().result, UpdateResult::Installed);
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_brain_rolls_back_to_the_old_build() {
        let h = harness();
        h.agent.update(&request("1.5.0")).await.unwrap();
        *h.compose.readiness.lock() = vec![Readiness::Refused("contract_mismatch".into())];
        let outcome = h.agent.activate().await.unwrap();
        assert_eq!(outcome.result, UpdateResult::RolledBack);
        assert!(outcome.reason.unwrap().contains("contract_mismatch"));
        // Back on the exact build it ran, by digest.
        assert_eq!(
            *h.compose.recreates.lock(),
            vec![Some(digest_ref('b')), Some(digest_ref('a'))]
        );
        assert!(h
            .env()
            .contains(&format!("COGNIA_SERVER_IMAGE={}", digest_ref('a'))));
        assert_eq!(*h.compose.running.lock(), digest_ref('a'));
        assert_eq!(h.agent.status().phase, AgentPhase::Idle);
    }

    #[tokio::test(start_paused = true)]
    async fn a_server_that_never_gets_ready_rolls_back_at_the_deadline() {
        let h = harness();
        h.agent.update(&request("1.5.0")).await.unwrap();
        *h.compose.readiness.lock() = vec![Readiness::NotReady("starting".into())];
        let outcome = h.agent.activate().await.unwrap();
        assert_eq!(outcome.result, UpdateResult::RolledBack);
        assert!(outcome.reason.unwrap().contains("in time"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_recreate_rolls_back() {
        let h = harness();
        h.agent.update(&request("1.5.0")).await.unwrap();
        *h.compose.recreate_error.lock() = Some("unhealthy".into());
        let outcome = h.agent.activate().await.unwrap();
        assert_eq!(outcome.result, UpdateResult::RolledBack);
        assert!(outcome.reason.unwrap().contains("did not start"));
        assert_eq!(
            h.compose.recreates.lock().last().cloned(),
            Some(Some(digest_ref('a')))
        );
    }

    #[tokio::test]
    async fn the_agent_picks_the_release_itself_and_refuses_what_it_cannot_verify() {
        let h = harness();
        let refused = h.agent.update(&request("1.6.0")).await.unwrap_err();
        assert!(refused.contains("1.5.0 rolling, not 1.6.0"), "{refused}");
        assert_eq!(
            h.agent.status().last_error.as_deref(),
            Some(refused.as_str())
        );

        *h.worker.answer.lock() = None;
        assert!(h
            .agent
            .update(&request("1.5.0"))
            .await
            .unwrap_err()
            .contains("no release is rolling"));

        *h.worker.answer.lock() = Some(RolloutAnswer {
            version: "1.5.0".into(),
            digest: Some(format!("sha256:{}", "e".repeat(64))),
        });
        assert!(h.agent.update(&request("1.5.0")).await.is_err());

        let mut channel = request("1.5.0");
        channel.channel = "canary".into();
        assert!(h
            .agent
            .update(&channel)
            .await
            .unwrap_err()
            .contains("channel"));
        assert!(h.compose.pulls.lock().is_empty(), "nothing was pulled");
    }

    #[tokio::test]
    async fn compose_files_that_ignore_the_pin_are_refused_before_pulling() {
        let h = harness();
        *h.compose.resolves_to.lock() = Some(format!("{REPO}:pinned-by-hand"));
        let error = h.agent.update(&request("1.5.0")).await.unwrap_err();
        assert!(error.contains("COGNIA_SERVER_IMAGE"), "{error}");
        assert!(h.compose.pulls.lock().is_empty());
        assert_eq!(h.agent.status().phase, AgentPhase::Idle);
    }

    #[tokio::test]
    async fn a_failed_pull_leaves_nothing_behind() {
        let h = harness();
        *h.compose.pull_error.lock() = Some("manifest unknown".into());
        assert!(h.agent.update(&request("1.5.0")).await.is_err());
        assert!(h.agent.status().trial.is_none());
        // And a second request may try again.
        *h.compose.pull_error.lock() = None;
        assert!(h.agent.update(&request("1.5.0")).await.is_ok());
        assert!(h
            .agent
            .update(&request("1.5.0"))
            .await
            .unwrap_err()
            .contains("in progress"));
    }

    #[tokio::test]
    async fn without_a_trust_root_nothing_is_installed() {
        let h = harness();
        let agent = HostUpdateAgent::new(
            h.compose.clone(),
            h.worker.clone(),
            None,
            StateFile::new(h.tmp.path().join("state")),
            Timing::default(),
            Arc::new(|| BASE_MS),
        );
        assert!(agent
            .update(&request("1.5.0"))
            .await
            .unwrap_err()
            .contains("trust root"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_restarted_agent_finishes_the_swap_it_was_in() {
        let h = harness();
        h.agent.update(&request("1.5.0")).await.unwrap();
        // Restarted before switching: roll back, the server was never touched.
        let outcome = h.agent.resume().await.unwrap();
        assert_eq!(outcome.result, UpdateResult::RolledBack);
        assert!(h.compose.recreates.lock().is_empty());

        // Restarted mid-trial: keep proving it.
        h.agent.update(&request("1.5.0")).await.unwrap();
        let mut state = h.agent.state.load().unwrap();
        state.pending.as_mut().unwrap().activated = true;
        h.agent.state.save(&state).unwrap();
        let outcome = h.agent.resume().await.unwrap();
        assert_eq!(outcome.result, UpdateResult::Installed);
        assert_eq!(h.agent.resume().await, None, "nothing left to finish");
    }

    #[tokio::test]
    async fn adopt_pins_what_runs_now() {
        let h = harness();
        let report = h.agent.adopt().await.unwrap();
        assert_eq!(report.image, digest_ref('a'));
        assert_eq!(report.target.as_deref(), Some("oci-full-amd64"));
        assert!(h
            .env()
            .contains(&format!("COGNIA_SERVER_IMAGE={}", digest_ref('a'))));
        assert_eq!(h.agent.status().image, Some(digest_ref('a')));
    }

    #[tokio::test]
    async fn status_answers_over_the_same_entry_point() {
        let h = harness();
        let (response, activate) = h.agent.answer(AgentRequest::Status).await;
        assert!(!activate);
        assert!(
            matches!(response, AgentResponse::Status(ref status) if status.phase == AgentPhase::Idle)
        );
        let (response, activate) = h.agent.answer(AgentRequest::Update(request("1.5.0"))).await;
        assert!(activate);
        assert!(matches!(response, AgentResponse::Accepted(_)));
    }
}
