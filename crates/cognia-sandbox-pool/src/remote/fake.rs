//! An in-memory remote provider for the driver's tests (ADR-0221).
//!
//! It answers exactly the commands the remote preparation branch sends —
//! `probe`, `health`, `bridge-service`, `connect-agent`, `renew-agent`,
//! `signal-agent` and the git commands under `init-agent` — and records every
//! provision, exec and removal so a test can assert what the driver asked for.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use async_trait::async_trait;
use cognia_environment::spec::{EgressTier, IsolationTier};
use cognia_external_agent::container_backend::{
    ContainerApi, OwnedContainer, OwnedVolume, RegistryAuth, RunnerEvent, RunnerExecSpec,
    RunnerRunError, RunnerSpec, RunningRunner, RuntimeContainerState, SandboxDockerApi,
    VolumeRemoval,
};
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
use parking_lot::Mutex;
use tokio::sync::mpsc;

use super::{ProvisionRequest, RemoteProvisioner};

/// A live exec the test can drive by pushing events into it. Its stdin
/// receiver is held only so the driver's writes are accepted, as a live
/// exec's would be.
pub(crate) struct FakeExec {
    pub events: mpsc::UnboundedSender<RunnerEvent>,
    _stdin: Mutex<Option<mpsc::UnboundedReceiver<Vec<u8>>>>,
}

/// A scripted git result: stdout and exit code.
#[derive(Clone)]
pub(crate) struct GitAnswer {
    pub stdout: String,
    pub code: i64,
}

pub(crate) type FakeInstance = (BTreeMap<String, String>, bool);

pub(crate) struct FakeRemote {
    pub kind: &'static str,
    pub tiers: Mutex<Result<Vec<IsolationTier>, SandboxSpawnError>>,
    pub enforces_allowlist: bool,
    pub delegated: Vec<String>,
    pub provision_error: Mutex<Option<SandboxSpawnError>>,
    /// Whether `start_runtime` works (E2B resumes; a Kubernetes pod cannot).
    pub restartable: bool,
    pub probe: Mutex<(Vec<u8>, i64)>,
    /// Answers by git subcommand (`clone`, `status`, `rev-parse`, `push`, …).
    /// `rev-parse` answers are consumed in order, the last one repeating.
    pub git: Mutex<HashMap<String, Vec<GitAnswer>>>,
    pub provisions: Mutex<Vec<ProvisionRequest>>,
    pub released: Mutex<Vec<String>>,
    pub execs: Mutex<Vec<RunnerExecSpec>>,
    pub removed: Mutex<Vec<String>>,
    /// How many more removals the provider refuses (a provider API that is
    /// down or rate-limiting).
    pub remove_failures: Mutex<u32>,
    /// Instance name → its labels and whether it is running.
    pub instances: Mutex<BTreeMap<String, FakeInstance>>,
    pub sessions: Mutex<HashMap<String, Arc<FakeExec>>>,
    pub bridges: Mutex<Vec<Arc<FakeExec>>>,
    counter: Mutex<u64>,
}

impl FakeRemote {
    pub fn new(kind: &'static str) -> Arc<Self> {
        Arc::new(Self {
            kind,
            tiers: Mutex::new(Ok(vec![IsolationTier::Vm])),
            enforces_allowlist: true,
            delegated: Vec::new(),
            provision_error: Mutex::new(None),
            restartable: true,
            probe: Mutex::new((Vec::new(), 0)),
            git: Mutex::new(HashMap::from([
                (
                    "rev-parse".to_string(),
                    vec![GitAnswer {
                        stdout: "a".repeat(40),
                        code: 0,
                    }],
                ),
                (
                    "status".to_string(),
                    vec![GitAnswer {
                        stdout: String::new(),
                        code: 0,
                    }],
                ),
            ])),
            provisions: Mutex::new(Vec::new()),
            released: Mutex::new(Vec::new()),
            execs: Mutex::new(Vec::new()),
            removed: Mutex::new(Vec::new()),
            remove_failures: Mutex::new(0),
            instances: Mutex::new(BTreeMap::new()),
            sessions: Mutex::new(HashMap::new()),
            bridges: Mutex::new(Vec::new()),
            counter: Mutex::new(0),
        })
    }

    pub fn with(kind: &'static str, configure: impl FnOnce(&mut FakeRemote)) -> Arc<Self> {
        let mut fake = Arc::try_unwrap(Self::new(kind)).ok().expect("fresh fake");
        configure(&mut fake);
        Arc::new(fake)
    }

    pub fn answer_git(&self, subcommand: &str, answers: Vec<GitAnswer>) {
        self.git.lock().insert(subcommand.to_string(), answers);
    }

    /// Every git subcommand the driver ran, in order.
    pub fn git_calls(&self) -> Vec<Vec<String>> {
        self.execs
            .lock()
            .iter()
            .filter_map(|exec| {
                let at = exec.command.iter().position(|arg| arg == "--")?;
                exec.command[at + 1]
                    .ends_with("/git")
                    .then(|| exec.command[at + 1..].to_vec())
            })
            .collect()
    }

    /// The sandboxd action of every exec, in order (`git` for git commands).
    pub fn actions(&self) -> Vec<String> {
        self.execs
            .lock()
            .iter()
            .map(|exec| match exec.command.get(1).map(String::as_str) {
                Some("init-agent") => "git".to_string(),
                Some(action) => action.to_string(),
                None => String::new(),
            })
            .collect()
    }

    fn git_answer(&self, args: &[String]) -> GitAnswer {
        // Skip `git -c k=v …` and `-C dir` to find the subcommand.
        let mut index = 1;
        while index < args.len() {
            match args[index].as_str() {
                "-c" | "-C" => index += 2,
                _ => break,
            }
        }
        let subcommand = args.get(index).cloned().unwrap_or_default();
        let mut git = self.git.lock();
        match git.get_mut(&subcommand) {
            Some(answers) if answers.len() > 1 => answers.remove(0),
            Some(answers) if answers.len() == 1 => answers[0].clone(),
            _ => GitAnswer {
                stdout: String::new(),
                code: 0,
            },
        }
    }
}

fn finished(stdout: Vec<u8>, code: i64) -> RunningRunner {
    let (events, receiver) = mpsc::unbounded_channel();
    let (stdin, _) = mpsc::unbounded_channel::<Vec<u8>>();
    if !stdout.is_empty() {
        let _ = events.send(RunnerEvent::Stdout(stdout));
    }
    let _ = events.send(RunnerEvent::Exited { code: Some(code) });
    RunningRunner {
        container_id: String::new(),
        events: receiver.into(),
        stdin: stdin.into(),
    }
}

#[async_trait]
impl RemoteProvisioner for FakeRemote {
    fn kind(&self) -> &'static str {
        self.kind
    }
    async fn tiers(&self) -> Result<Vec<IsolationTier>, SandboxSpawnError> {
        self.tiers.lock().clone()
    }
    fn egress_enforced(&self, tier: EgressTier) -> bool {
        !matches!(tier, EgressTier::Allowlist) || self.enforces_allowlist
    }
    fn may_receive_registry_credentials(&self, registry: &str) -> bool {
        self.delegated.iter().any(|allowed| allowed == registry)
    }
    async fn provision(&self, request: &ProvisionRequest) -> Result<String, SandboxSpawnError> {
        self.provisions.lock().push(request.clone());
        if let Some(error) = self.provision_error.lock().clone() {
            return Err(error);
        }
        let id = {
            let mut counter = self.counter.lock();
            *counter += 1;
            format!("instance-{}", *counter)
        };
        self.instances
            .lock()
            .insert(id.clone(), (request.labels.clone(), true));
        Ok(id)
    }
    async fn release_supervisor(
        &self,
        instance: &str,
        _request: &ProvisionRequest,
    ) -> Result<(), SandboxSpawnError> {
        self.released.lock().push(instance.to_string());
        Ok(())
    }
}

#[async_trait]
impl ContainerApi for FakeRemote {
    async fn run(&self, _spec: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
        Err(RunnerRunError::Other(
            "remote providers provision instances; they do not run containers".into(),
        ))
    }
    async fn pull_image(&self, _image: &str) -> Result<(), String> {
        Err("a remote provider pulls while provisioning".into())
    }
    async fn kill(&self, id: &str) -> Result<(), String> {
        self.remove(id).await
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        {
            let mut failures = self.remove_failures.lock();
            if *failures > 0 {
                *failures -= 1;
                return Err("the provider refused the deletion".into());
            }
        }
        if self.instances.lock().remove(id).is_some() {
            self.removed.lock().push(id.to_string());
        }
        Ok(())
    }
    async fn labels(&self, id: &str) -> Result<Option<BTreeMap<String, String>>, String> {
        Ok(self.instances.lock().get(id).map(|(labels, _)| labels.clone()))
    }
    async fn list_owned(&self) -> Result<Vec<OwnedContainer>, String> {
        Ok(self
            .instances
            .lock()
            .iter()
            .map(|(id, (labels, _))| OwnedContainer {
                id: id.clone(),
                labels: labels.clone(),
            })
            .collect())
    }
}

#[async_trait]
impl SandboxDockerApi for FakeRemote {
    async fn inspect_runtime(&self, id: &str) -> Result<Option<RuntimeContainerState>, String> {
        Ok(self
            .instances
            .lock()
            .get(id)
            .map(|(labels, running)| RuntimeContainerState {
                running: *running,
                labels: labels.clone(),
            }))
    }
    async fn start_runtime(&self, id: &str) -> Result<(), String> {
        if !self.restartable {
            return Err("this provider cannot restart an instance".into());
        }
        match self.instances.lock().get_mut(id) {
            Some((_, running)) => {
                *running = true;
                Ok(())
            }
            None => Err("instance missing".into()),
        }
    }
    async fn stop_runtime(&self, id: &str) -> Result<(), String> {
        if let Some((_, running)) = self.instances.lock().get_mut(id) {
            *running = false;
        }
        Ok(())
    }
    async fn exec_runtime(&self, spec: RunnerExecSpec) -> Result<RunningRunner, String> {
        if !self.instances.lock().contains_key(&spec.container_id) {
            return Err(format!("no instance {}", spec.container_id));
        }
        self.execs.lock().push(spec.clone());
        let action = spec.command.get(1).cloned().unwrap_or_default();
        let session = spec
            .command
            .windows(2)
            .find(|pair| pair[0] == "--session")
            .map(|pair| pair[1].clone());
        let mut running = match action.as_str() {
            "probe" => {
                let (stdout, code) = self.probe.lock().clone();
                finished(stdout, code)
            }
            "health" => {
                let labels = self
                    .instances
                    .lock()
                    .get(&spec.container_id)
                    .map(|(labels, _)| labels.clone())
                    .unwrap_or_default();
                let ready = self.released.lock().contains(&spec.container_id);
                finished(
                    serde_json::to_vec(&serde_json::json!({
                        "ready": ready,
                        "runtimeKey": labels.get("cognia.runtime-key"),
                    }))
                    .unwrap(),
                    0,
                )
            }
            "renew-agent" | "publish-gateway-ready" | "delete-gateway-task" => {
                finished(Vec::new(), 0)
            }
            "signal-agent" => {
                if let Some(session) = session.and_then(|id| self.sessions.lock().remove(&id)) {
                    let _ = session.events.send(RunnerEvent::Exited { code: Some(143) });
                }
                finished(Vec::new(), 0)
            }
            "init-agent" => {
                let at = spec.command.iter().position(|arg| arg == "--").unwrap_or(0);
                let answer = self.git_answer(&spec.command[at + 1..]);
                finished(answer.stdout.into_bytes(), answer.code)
            }
            "bridge-service" | "connect-agent" => {
                let (events, receiver) = mpsc::unbounded_channel();
                let (stdin, stdin_receiver) = mpsc::unbounded_channel();
                if action == "bridge-service" {
                    let port = spec
                        .command
                        .windows(2)
                        .find(|pair| pair[0] == "--listen-port")
                        .and_then(|pair| pair[1].parse::<u16>().ok())
                        .unwrap_or(34567)
                        .to_be_bytes();
                    let _ = events.send(RunnerEvent::Stdout(vec![
                        1, 0, 0, 0, 0, 0, 0, 0, 2, port[0], port[1],
                    ]));
                }
                let exec = Arc::new(FakeExec {
                    events,
                    _stdin: Mutex::new(Some(stdin_receiver)),
                });
                match session {
                    Some(session) if action == "connect-agent" => {
                        self.sessions.lock().insert(session, exec);
                    }
                    _ => self.bridges.lock().push(exec),
                }
                RunningRunner {
                    container_id: String::new(),
                    events: receiver.into(),
                    stdin: stdin.into(),
                }
            }
            other => return Err(format!("unscripted remote action {other}")),
        };
        running.container_id = spec.container_id;
        Ok(running)
    }
    async fn runtimes(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    async fn ensure_volume(
        &self,
        _name: &str,
        _labels: &BTreeMap<String, String>,
    ) -> Result<(), String> {
        Err("a remote provider has no named volumes".into())
    }
    async fn list_owned_volumes(&self) -> Result<Vec<OwnedVolume>, String> {
        Ok(Vec::new())
    }
    async fn remove_volume(&self, _name: &str) -> Result<VolumeRemoval, String> {
        Ok(VolumeRemoval::Gone)
    }
    async fn pull_image_with_auth(
        &self,
        _image: &str,
        _auth: Option<RegistryAuth>,
    ) -> Result<(), String> {
        Err("a remote provider pulls while provisioning".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(args: &[&str]) -> Vec<String> {
        std::iter::once("/cognia/common/bin/git")
            .chain(args.iter().copied())
            .map(str::to_string)
            .collect()
    }

    /// The driver's tests script git by subcommand; a misread subcommand
    /// would let a test pass on answers meant for another step.
    #[test]
    fn git_answers_follow_the_subcommand_past_global_options() {
        let fake = FakeRemote::new("fake");
        fake.answer_git(
            "rev-parse",
            vec![
                GitAnswer {
                    stdout: "first".into(),
                    code: 0,
                },
                GitAnswer {
                    stdout: "last".into(),
                    code: 0,
                },
            ],
        );
        fake.answer_git(
            "push",
            vec![GitAnswer {
                stdout: String::new(),
                code: 1,
            }],
        );
        let rev_parse = git(&["-c", "core.hooksPath=/dev/null", "-C", "/workspace", "rev-parse", "HEAD"]);
        assert_eq!(fake.git_answer(&rev_parse).stdout, "first");
        assert_eq!(fake.git_answer(&rev_parse).stdout, "last");
        assert_eq!(fake.git_answer(&rev_parse).stdout, "last", "the last answer repeats");
        assert_eq!(fake.git_answer(&git(&["push", "origin"])).code, 1);
        assert_eq!(fake.git_answer(&git(&["fetch"])).code, 0, "unscripted git succeeds");
    }
}
