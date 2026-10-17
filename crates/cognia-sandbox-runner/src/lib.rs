//! The Windows sandbox runner's contract and its launch plan.
//!
//! The binary (`src/main.rs`) is the Win32 half: a restricted, low-integrity
//! token in a Job Object. This library is the half that can be reasoned about
//! and tested on any host — what the runner was **asked** for, what it will
//! actually **enforce**, and the refusal when those two cannot be made to
//! agree.
//!
//! Three properties matter to the acceptance case that pays for this module
//! (SAFE-02: generated code must not reach the network, the docker socket or
//! host secrets, and its resource use must be bounded):
//!
//! * **Network.** This tier has no kernel-enforced egress control. The
//!   restricted token and the low integrity label confine *writes* and
//!   *privileges*; they confine no socket. A caller that asks for
//!   `network: "off"` therefore gets [`PlanError::NetworkConfinementUnavailable`]
//!   and **nothing is launched** — the Linux backend's fail-closed rule
//!   (`downgrade_unenforceable_network`) applied to the one platform that
//!   cannot honour "off" at all. Running the command anyway would present an
//!   open network as an isolated one.
//! * **Host secrets and the docker socket.** The child's environment is the
//!   caller's, plus a fixed allowlist of operating-system variables. The
//!   runner's own environment — which holds whatever the desktop app was
//!   started with, provider keys and `DOCKER_HOST` included — is never
//!   inherited wholesale. This matches the macOS and Linux backends, which
//!   `env_clear()` before they exec, and closes the one place this runner
//!   differed.
//! * **Resource use.** The Job Object caps active processes (the fork-bomb
//!   bound the other tiers lack), per-process committed memory, job-wide
//!   memory, and per-process CPU time; the wall clock is the caller's
//!   timeout, clamped to a finite ceiling.
//!
//! A payload from a caller that predates these fields plans exactly what it
//! planned before: no memory cap, 512 active processes, no CPU cap, a five
//! minute default timeout and an unconfined network.

use cognia_exec_sandbox::filesystem_plan::FilesystemPlan;
use std::collections::BTreeMap;
use std::time::Duration;

/// Per-stream output cap. Bytes past it are dropped with a marker.
pub const MAX_OUTPUT_BYTES: usize = 1_000_000;
pub const TRUNCATION_MARKER: &str = "\n... (truncated)";

/// The Job Object's fork-bomb bound when the caller names none. Generous
/// enough for a parallel build's fan-out.
pub const DEFAULT_ACTIVE_PROCESS_LIMIT: u32 = 512;
/// The ceiling a caller may raise the process bound to.
pub const MAX_ACTIVE_PROCESS_LIMIT: u32 = 4_096;
/// The wall clock a payload with `timeout_seconds: 0` gets.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);

/// The exit code the runner uses when it refuses to launch because the
/// confinement the caller asked for is not available on this platform.
/// Distinct from `2` (a malformed payload) so the backend can tell a refusal
/// from a bug.
pub const EXIT_CONFINEMENT_UNAVAILABLE: i32 = 3;

/// The network shape a caller asked for. Absent means the caller predates the
/// field and takes what the tier gives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkRequest {
    /// The caller said nothing about the network.
    #[default]
    Unspecified,
    /// No network at all.
    Off,
    /// Unrestricted egress.
    On,
    /// Egress restricted to an allowlist. This runner refuses the request:
    /// proxy variables alone cannot prevent direct sockets.
    Allowlist,
}

/// What the tier actually enforces, as opposed to what was asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkEnforcement {
    /// Nothing stops a socket. Network is not restricted on this tier.
    Unconfined,
}

/// What the runner will enforce for one launch, reported back so no consumer
/// has to infer it from the platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Confinement {
    /// A restricted token with every privilege disabled.
    pub restricted_token: bool,
    /// The child runs at low integrity, so it cannot write the user's files.
    pub low_integrity: bool,
    /// Intentionally inert until a separately shipped minifilter enforces
    /// filesystem roots; low integrity is not path-based confinement.
    pub filesystem_enforcement: bool,
    pub network_requested: NetworkRequest,
    pub network_enforced: NetworkEnforcement,
    /// True when the child's environment is the caller's plus the OS
    /// allowlist, rather than the runner's own environment.
    pub host_environment_filtered: bool,
    pub active_process_limit: u32,
    pub process_memory_bytes: Option<u64>,
    pub job_memory_bytes: Option<u64>,
    pub cpu_seconds: Option<u64>,
    pub wall_clock_seconds: u64,
}

/// Environment shapes the desktop backend has serialised over time.
///
/// `crates/cognia-exec-sandbox/src/windows.rs` builds the payload's
/// `env` as a `Vec<(String, String)>`, which serialises to an array of pairs;
/// this struct's own history says map. A runner that accepts only one of the
/// two refuses every call from the other, which is exactly what happened:
/// the Windows sandbox answered `invalid type: sequence, expected a map` to
/// every request. Accepting both is the fix that cannot break the other end.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(untagged)]
pub enum EnvPayload {
    #[default]
    Absent,
    Map(BTreeMap<String, String>),
    Pairs(Vec<(String, String)>),
}

impl EnvPayload {
    pub fn into_map(self) -> BTreeMap<String, String> {
        match self {
            EnvPayload::Absent => BTreeMap::new(),
            EnvPayload::Map(map) => map,
            EnvPayload::Pairs(pairs) => pairs.into_iter().collect(),
        }
    }
}

/// The JSON the desktop backend hands the runner in `argv[1]`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunnerInput {
    /// Retained for backward compatibility with the synthetic-user model;
    /// the restricted-token runner ignores it.
    #[serde(default)]
    pub target_user: String,
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub env: EnvPayload,
    #[serde(default)]
    pub timeout_seconds: u64,
    /// 0 = no per-process committed-memory cap.
    #[serde(default)]
    pub max_memory_mb: u32,
    /// 0 = no job-wide committed-memory cap.
    #[serde(default)]
    pub max_job_memory_mb: u32,
    /// 0 = no per-process CPU-time cap. Matches `RLIMIT_CPU` on the Unix
    /// backends: each process in the job gets its own budget.
    #[serde(default)]
    pub max_cpu_seconds: u32,
    /// 0 = [`DEFAULT_ACTIVE_PROCESS_LIMIT`].
    #[serde(default)]
    pub max_processes: u32,
    /// What the caller's policy says about the network.
    #[serde(default)]
    pub network: NetworkRequest,
    #[serde(default = "legacy_filesystem_plan")]
    pub filesystem: FilesystemPlan,
}

/// Required security fields for protocol v2. No missing field gets a default.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunnerRequestV2 {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub timeout_seconds: u64,
    pub limits: RunnerLimitsV2,
    pub network: NetworkRequest,
    pub filesystem: FilesystemPlan,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunnerLimitsV2 {
    pub max_memory_mb: u32,
    pub max_job_memory_mb: u32,
    pub max_cpu_seconds: u32,
    pub max_processes: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunnerEnvelopeV2 {
    pub protocol: u32,
    pub request: RunnerRequestV2,
}

/// Parse exactly one v2 JSON value, rejecting trailing requests and versions
/// whose security contract this executable does not implement.
pub fn parse_v2(payload: &str) -> Result<RunnerInput, String> {
    let envelope: RunnerEnvelopeV2 = serde_json::from_str(payload).map_err(|e| e.to_string())?;
    if envelope.protocol != 2 {
        return Err(format!(
            "unsupported runner protocol: {}",
            envelope.protocol
        ));
    }
    let request = envelope.request;
    Ok(RunnerInput {
        target_user: String::new(),
        argv: request.argv,
        cwd: request.cwd,
        env: EnvPayload::Map(request.env),
        timeout_seconds: request.timeout_seconds,
        max_memory_mb: request.limits.max_memory_mb,
        max_job_memory_mb: request.limits.max_job_memory_mb,
        max_cpu_seconds: request.limits.max_cpu_seconds,
        max_processes: request.limits.max_processes,
        network: request.network,
        filesystem: request.filesystem,
    })
}

pub use cognia_exec_sandbox::types::WindowsCapabilities as RunnerCapabilities;

fn legacy_filesystem_plan() -> FilesystemPlan {
    FilesystemPlan {
        readable_trees: vec![],
        writable_trees: vec![],
        writable_files: vec![],
        deny_read: vec![],
        deny_write: vec![],
        runtime_reads: vec![],
        private_scratch: String::new(),
    }
}

/// Side-effect-free capability description: no token, job or process is created.
pub fn capabilities_v2() -> RunnerCapabilities {
    RunnerCapabilities {
        protocol_versions: vec![2],
        filesystem_enforcement: false,
        filesystem_reason: "windows_filesystem_roots_unenforced".into(),
        network_enforcement: "unconfined".into(),
        restricted_token: true,
        low_integrity: true,
        job_object: true,
    }
}

/// What the runner prints on success.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunnerOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    /// What was actually enforced for this launch.
    pub confinement: Confinement,
}

/// The Job Object limits one launch is assigned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobLimits {
    pub active_processes: u32,
    pub process_memory_bytes: Option<u64>,
    pub job_memory_bytes: Option<u64>,
    pub per_process_cpu: Option<Duration>,
    /// Always true: the whole tree dies with the job handle, so no
    /// grandchild outlives the runner.
    pub kill_on_close: bool,
}

/// Everything the Win32 launch needs, decided before a handle is opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub argv: Vec<String>,
    pub cwd: String,
    /// The child's whole environment: the caller's, over the OS allowlist.
    pub environment: BTreeMap<String, String>,
    pub timeout: Duration,
    pub job: JobLimits,
    pub confinement: Confinement,
}

/// Why a payload cannot be launched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    /// `argv` is empty.
    EmptyArgv,
    /// The caller asked for a confinement this tier cannot enforce. The
    /// message names it, and the runner exits [`EXIT_CONFINEMENT_UNAVAILABLE`]
    /// without launching anything.
    NetworkConfinementUnavailable(String),
    FilesystemConfinementUnavailable,
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::EmptyArgv => write!(formatter, "argv is empty"),
            PlanError::NetworkConfinementUnavailable(message) => write!(formatter, "{message}"),
            PlanError::FilesystemConfinementUnavailable => {
                write!(formatter, "windows_filesystem_roots_unenforced")
            }
        }
    }
}

/// Operating-system variables a child keeps when the runner does not inherit
/// the host environment.
///
/// Everything outside this list is dropped, which is how a provider key, a
/// `DOCKER_HOST` pointing at the engine's named pipe, or an `SSH_AUTH_SOCK`
/// in the desktop app's own environment stops reaching sandboxed code. The
/// entries here name the machine, not the person: without `SystemRoot` and
/// `ComSpec` almost nothing on Windows starts at all.
pub const HOST_ENV_ALLOWLIST: [&str; 26] = [
    "ALLUSERSPROFILE",
    "APPDATA",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "COMPUTERNAME",
    "COMSPEC",
    "DRIVERDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PUBLIC",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
];

/// The child's environment: the OS allowlist taken from `host`, with the
/// caller's own variables written over it.
///
/// The caller's entries are kept verbatim — the ADR-0028 contract is that a
/// sandboxed command runs with exactly the environment the caller supplied,
/// and the dispatcher has already scrubbed the code-injection variables
/// (`LD_PRELOAD`, `NODE_OPTIONS`, …) from it. What this function decides is
/// only what the *host* contributes.
pub fn child_environment(
    host: &BTreeMap<String, String>,
    caller: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::new();
    for (key, value) in host {
        let upper = key.to_ascii_uppercase();
        if HOST_ENV_ALLOWLIST.contains(&upper.as_str()) {
            environment.insert(key.clone(), value.clone());
        }
    }
    // `TEMP`/`TMP` follow the allowlist only when the caller named neither,
    // and they come last so a caller that pinned a scratch directory inside
    // its own writable root keeps it.
    for name in ["TEMP", "TMP"] {
        if let Some((key, value)) = host.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)) {
            environment.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in caller {
        environment.insert(key.clone(), value.clone());
    }
    environment
}

/// Decide everything about a launch from its payload and the host's
/// environment, or refuse.
pub fn plan_with_host_env(
    input: &RunnerInput,
    host_env: &BTreeMap<String, String>,
) -> Result<LaunchPlan, PlanError> {
    if input.argv.is_empty() {
        return Err(PlanError::EmptyArgv);
    }
    if input.filesystem.has_roots() {
        return Err(PlanError::FilesystemConfinementUnavailable);
    }
    if matches!(
        input.network,
        NetworkRequest::Off | NetworkRequest::Allowlist
    ) {
        return Err(PlanError::NetworkConfinementUnavailable(
            "network confinement unavailable: this Windows sandbox tier confines privileges, \
             integrity and the process tree, but it cannot block egress. Refusing to run a \
             command that asked for network Off or Allowlist with an open network."
                .to_string(),
        ));
    }

    let timeout = if input.timeout_seconds == 0 {
        DEFAULT_TIMEOUT
    } else {
        Duration::from_secs(input.timeout_seconds)
    };
    let active_processes = if input.max_processes == 0 {
        DEFAULT_ACTIVE_PROCESS_LIMIT
    } else {
        input.max_processes.min(MAX_ACTIVE_PROCESS_LIMIT)
    };
    let process_memory_bytes = megabytes(input.max_memory_mb);
    let job_memory_bytes = megabytes(input.max_job_memory_mb);
    let per_process_cpu =
        (input.max_cpu_seconds > 0).then(|| Duration::from_secs(u64::from(input.max_cpu_seconds)));

    let mut environment = child_environment(host_env, &input.env.clone().into_map());
    if !input.filesystem.private_scratch.is_empty() {
        environment
            .retain(|key, _| !key.eq_ignore_ascii_case("TEMP") && !key.eq_ignore_ascii_case("TMP"));
        for name in ["TEMP", "TMP"] {
            environment.insert(name.into(), input.filesystem.private_scratch.clone());
        }
    }

    Ok(LaunchPlan {
        argv: input.argv.clone(),
        cwd: input.cwd.clone(),
        environment,
        timeout,
        job: JobLimits {
            active_processes,
            process_memory_bytes,
            job_memory_bytes,
            per_process_cpu,
            kill_on_close: true,
        },
        confinement: Confinement {
            restricted_token: true,
            low_integrity: true,
            filesystem_enforcement: false,
            network_requested: input.network,
            network_enforced: NetworkEnforcement::Unconfined,
            host_environment_filtered: true,
            active_process_limit: active_processes,
            process_memory_bytes,
            job_memory_bytes,
            cpu_seconds: per_process_cpu.map(|cpu| cpu.as_secs()),
            wall_clock_seconds: timeout.as_secs(),
        },
    })
}

/// [`plan_with_host_env`] against this process's own environment.
pub fn plan(input: &RunnerInput) -> Result<LaunchPlan, PlanError> {
    let host: BTreeMap<String, String> = std::env::vars().collect();
    plan_with_host_env(input, &host)
}

fn megabytes(value: u32) -> Option<u64> {
    (value > 0).then(|| u64::from(value).saturating_mul(1024 * 1024))
}

/// Convert a wait timeout to the `u32` milliseconds `WaitForSingleObject`
/// wants, without the silent `as u32` wrap that turned any timeout above
/// ~49.7 days (and, via millis-as-`u32` truncation, anything past ~71
/// minutes) into a tiny value — making long-running commands time out almost
/// immediately. We saturate at `u32::MAX - 1` (≈49.7 days): a finite,
/// very-long ceiling that is deliberately NOT the `INFINITE` (`u32::MAX`)
/// sentinel, so a hung child can never wait forever.
pub fn clamp_timeout_millis(timeout: Duration) -> u32 {
    const MAX_FINITE_MS: u128 = (u32::MAX - 1) as u128;
    timeout.as_millis().min(MAX_FINITE_MS) as u32
}

/// Per-process CPU time as the 100-nanosecond units a Job Object's
/// `PerProcessUserTimeLimit` counts, saturating rather than wrapping.
pub fn cpu_time_100ns(cpu: Duration) -> i64 {
    let ticks = cpu.as_nanos() / 100;
    i64::try_from(ticks).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v2_payload() -> serde_json::Value {
        serde_json::json!({
            "protocol": 2,
            "request": {
                "argv": ["cmd.exe", "/c", "echo ok"], "cwd": "C:\\work",
                "env": {}, "timeout_seconds": 30,
                "limits": { "max_memory_mb": 0, "max_job_memory_mb": 0,
                    "max_cpu_seconds": 0, "max_processes": 1 },
                "network": "on", "filesystem": legacy_filesystem_plan()
            }
        })
    }

    #[test]
    fn v2_requires_every_security_field_and_rejects_unknown_fields() {
        let original = v2_payload();
        assert!(parse_v2(&original.to_string()).is_ok());
        for key in [
            "argv",
            "cwd",
            "env",
            "timeout_seconds",
            "limits",
            "network",
            "filesystem",
        ] {
            let mut value = original.clone();
            value["request"].as_object_mut().unwrap().remove(key);
            assert!(parse_v2(&value.to_string()).is_err(), "missing {key}");
        }
        for key in [
            "max_memory_mb",
            "max_job_memory_mb",
            "max_cpu_seconds",
            "max_processes",
        ] {
            let mut value = original.clone();
            value["request"]["limits"]
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(parse_v2(&value.to_string()).is_err(), "missing {key}");
        }
        for key in [
            "readable_trees",
            "writable_trees",
            "writable_files",
            "deny_read",
            "deny_write",
            "runtime_reads",
            "private_scratch",
        ] {
            let mut value = original.clone();
            value["request"]["filesystem"]
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(parse_v2(&value.to_string()).is_err(), "missing {key}");
        }
        for pointer in ["", "/request", "/request/limits", "/request/filesystem"] {
            let mut value = original.clone();
            value
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unknown".into(), true.into());
            assert!(
                parse_v2(&value.to_string()).is_err(),
                "unknown at {pointer}"
            );
        }
    }

    #[test]
    fn v2_refuses_versions_legacy_payloads_and_multiple_requests() {
        for protocol in [0, 1, 3, u32::MAX] {
            let mut value = v2_payload();
            value["protocol"] = protocol.into();
            assert!(parse_v2(&value.to_string()).is_err());
        }
        assert!(parse_v2(r#"{"argv":["a"],"cwd":"C:\\work"}"#).is_err());
        assert!(parse_v2(&format!("{} {}", v2_payload(), v2_payload())).is_err());
    }

    #[test]
    fn every_protocol_refuses_filesystem_roots() {
        for field in ["readable_trees", "writable_trees", "writable_files"] {
            let mut value = v2_payload();
            value["request"]["filesystem"][field] = serde_json::json!(["C:\\work"]);
            let input = parse_v2(&value.to_string()).unwrap();
            assert_eq!(
                plan_with_host_env(&input, &host(&[])),
                Err(PlanError::FilesystemConfinementUnavailable)
            );
            let mut legacy = value["request"].clone();
            legacy.as_object_mut().unwrap().remove("limits");
            let input: RunnerInput = serde_json::from_value(legacy).unwrap();
            assert_eq!(
                plan_with_host_env(&input, &host(&[])),
                Err(PlanError::FilesystemConfinementUnavailable)
            );
        }
        assert!(serde_json::from_str::<RunnerInput>(
            r#"{"argv":["a"],"cwd":"C:\\work","readable_roots":["C:\\"]}"#
        )
        .is_err());
    }

    #[test]
    fn allowlist_is_refused_even_with_proxy_environment() {
        let mut value = v2_payload();
        value["request"]["network"] = "allowlist".into();
        value["request"]["env"] = serde_json::json!({"HTTPS_PROXY": "http://127.0.0.1:8888"});
        let input = parse_v2(&value.to_string()).unwrap();
        assert!(matches!(
            plan_with_host_env(&input, &host(&[])),
            Err(PlanError::NetworkConfinementUnavailable(_))
        ));
    }

    #[test]
    fn explicit_private_scratch_overrides_host_and_caller_temp_variables() {
        let mut value = v2_payload();
        value["request"]["filesystem"]["private_scratch"] = "C:\\private-scratch".into();
        value["request"]["env"] = serde_json::json!({"Temp": "C:\\shared"});
        let input = parse_v2(&value.to_string()).unwrap();
        let launch = plan_with_host_env(&input, &host(&[("TMP", "C:\\host-temp")])).unwrap();
        assert_eq!(
            launch.environment.get("TEMP").unwrap(),
            "C:\\private-scratch"
        );
        assert_eq!(
            launch.environment.get("TMP").unwrap(),
            "C:\\private-scratch"
        );
        assert!(!launch.environment.contains_key("Temp"));
    }

    #[test]
    fn capabilities_pin_intentional_filesystem_dormancy_and_unconfined_network() {
        let capability = capabilities_v2();
        let parsed: RunnerCapabilities =
            serde_json::from_value(serde_json::to_value(&capability).unwrap()).unwrap();
        assert_eq!(parsed, capability);
        assert_eq!(capability.protocol_versions, [2]);
        assert!(!capability.filesystem_enforcement);
        assert_eq!(
            capability.filesystem_reason,
            "windows_filesystem_roots_unenforced"
        );
        assert_eq!(capability.network_enforcement, "unconfined");
        assert!(capability.restricted_token && capability.low_integrity && capability.job_object);
        let mut value = serde_json::to_value(&capability).unwrap();
        value["unknown"] = true.into();
        assert!(serde_json::from_value::<RunnerCapabilities>(value).is_err());
    }

    fn host(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn payload(json: &str) -> RunnerInput {
        serde_json::from_str(json).expect("the payload parses")
    }

    fn legacy_payload() -> RunnerInput {
        // The exact shape `build_runner_payload` in
        // `crates/cognia-exec-sandbox/src/windows.rs` emitted before
        // this contract grew fields: `env` as an array of pairs.
        payload(
            r#"{"target_user":"CogniaSandboxOnline","argv":["cmd.exe","/c","echo hi"],
                "cwd":"C:\\work","env":[["FOO","bar"]],"timeout_seconds":42}"#,
        )
    }

    #[test]
    fn the_backends_array_of_pairs_and_a_map_both_parse() {
        assert_eq!(
            legacy_payload().env.into_map(),
            host(&[("FOO", "bar")]),
            "the desktop backend serialises env as an array of pairs"
        );
        let mapped =
            payload(r#"{"argv":["a"],"cwd":"C:\\work","env":{"FOO":"bar"},"timeout_seconds":1}"#);
        assert_eq!(mapped.env.into_map(), host(&[("FOO", "bar")]));
        let absent = payload(r#"{"argv":["a"],"cwd":"C:\\work"}"#);
        assert!(absent.env.into_map().is_empty());
    }

    #[test]
    fn a_payload_that_predates_the_limits_plans_what_it_always_did() {
        let plan = plan_with_host_env(&legacy_payload(), &host(&[])).unwrap();
        assert_eq!(plan.timeout, Duration::from_secs(42));
        assert_eq!(plan.job.active_processes, DEFAULT_ACTIVE_PROCESS_LIMIT);
        assert_eq!(plan.job.process_memory_bytes, None);
        assert_eq!(plan.job.job_memory_bytes, None);
        assert_eq!(plan.job.per_process_cpu, None);
        assert!(plan.job.kill_on_close);
        assert_eq!(
            plan.confinement.network_requested,
            NetworkRequest::Unspecified
        );

        let no_timeout = payload(r#"{"argv":["a"],"cwd":"C:\\work","timeout_seconds":0}"#);
        assert_eq!(
            plan_with_host_env(&no_timeout, &host(&[])).unwrap().timeout,
            DEFAULT_TIMEOUT
        );
    }

    /// [ACC:SAFE-02] Every launch is bounded: processes, per-process memory,
    /// job-wide memory, CPU time and the wall clock.
    #[test]
    fn resource_limits_reach_the_job_object_and_are_reported() {
        let input = payload(
            r#"{"argv":["node","build.js"],"cwd":"C:\\work","env":{},"timeout_seconds":120,
                "max_memory_mb":512,"max_job_memory_mb":2048,"max_cpu_seconds":60,
                "max_processes":64,"network":"on"}"#,
        );
        let plan = plan_with_host_env(&input, &host(&[])).unwrap();

        assert_eq!(plan.job.active_processes, 64);
        assert_eq!(plan.job.process_memory_bytes, Some(512 * 1024 * 1024));
        assert_eq!(plan.job.job_memory_bytes, Some(2048 * 1024 * 1024));
        assert_eq!(plan.job.per_process_cpu, Some(Duration::from_secs(60)));
        assert_eq!(plan.timeout, Duration::from_secs(120));
        assert!(plan.job.kill_on_close);

        assert_eq!(plan.confinement.active_process_limit, 64);
        assert_eq!(plan.confinement.cpu_seconds, Some(60));
        assert_eq!(plan.confinement.wall_clock_seconds, 120);
        assert_eq!(cpu_time_100ns(Duration::from_secs(60)), 600_000_000);
    }

    #[test]
    fn a_process_bound_is_clamped_rather_than_taken_on_trust() {
        let input =
            payload(r#"{"argv":["a"],"cwd":"C:\\work","max_processes":1000000,"network":"on"}"#);
        assert_eq!(
            plan_with_host_env(&input, &host(&[]))
                .unwrap()
                .job
                .active_processes,
            MAX_ACTIVE_PROCESS_LIMIT
        );
    }

    /// [ACC:SAFE-02] A command that asked for no network is refused rather
    /// than run with one: this tier has no egress control to give it.
    #[test]
    fn a_network_off_request_is_refused_instead_of_silently_unconfined() {
        let input = payload(
            r#"{"argv":["pytest"],"cwd":"C:\\work","env":{},"timeout_seconds":60,"network":"off"}"#,
        );
        let error = plan_with_host_env(&input, &host(&[])).unwrap_err();
        assert!(
            matches!(error, PlanError::NetworkConfinementUnavailable(_)),
            "{error:?}"
        );
        assert!(error.to_string().contains("cannot block egress"), "{error}");
    }

    /// [ACC:SAFE-02] The tier never claims an egress guarantee it does not
    /// have, so nothing downstream can present it as a network-isolated
    /// acceptance sandbox.
    #[test]
    fn the_plan_states_that_egress_is_unconfined() {
        for request in ["on", "unspecified"] {
            let input = payload(&format!(
                r#"{{"argv":["a"],"cwd":"C:\\work","network":"{request}"}}"#
            ));
            let plan = plan_with_host_env(&input, &host(&[])).unwrap();
            assert_eq!(
                plan.confinement.network_enforced,
                NetworkEnforcement::Unconfined
            );
            assert!(plan.confinement.restricted_token && plan.confinement.low_integrity);
        }
    }

    /// [ACC:SAFE-02] The runner's own environment — the desktop app's, with
    /// whatever keys the user exported — does not reach sandboxed code. The
    /// docker engine's address is part of that: no `DOCKER_HOST`, no client
    /// pointed at the socket.
    #[test]
    fn host_credentials_and_the_docker_socket_address_are_not_inherited() {
        let host_env = host(&[
            ("SystemRoot", "C:\\Windows"),
            ("PATH", "C:\\Windows\\system32"),
            ("TEMP", "C:\\Users\\dev\\AppData\\Local\\Temp"),
            ("ANTHROPIC_API_KEY", "sk-secret"),
            ("AWS_SECRET_ACCESS_KEY", "aws-secret"),
            ("DOCKER_HOST", "npipe:////./pipe/docker_engine"),
            ("SSH_AUTH_SOCK", "\\\\.\\pipe\\openssh-ssh-agent"),
            ("GITHUB_TOKEN", "ghp_secret"),
            ("NPM_TOKEN", "npm-secret"),
            ("KUBECONFIG", "C:\\Users\\dev\\.kube\\config"),
        ]);
        let input = payload(r#"{"argv":["a"],"cwd":"C:\\work","env":{"CI":"1"},"network":"on"}"#);
        let plan = plan_with_host_env(&input, &host_env).unwrap();

        assert_eq!(
            plan.environment.get("SystemRoot").map(String::as_str),
            Some("C:\\Windows")
        );
        assert_eq!(plan.environment.get("CI").map(String::as_str), Some("1"));
        for secret in [
            "ANTHROPIC_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "DOCKER_HOST",
            "SSH_AUTH_SOCK",
            "GITHUB_TOKEN",
            "NPM_TOKEN",
            "KUBECONFIG",
        ] {
            assert!(
                !plan.environment.contains_key(secret),
                "{secret} reached the sandboxed child"
            );
        }
        assert!(plan.confinement.host_environment_filtered);
    }

    #[test]
    fn a_caller_variable_wins_over_the_host_one() {
        let host_env = host(&[("PATH", "C:\\Windows\\system32"), ("TEMP", "C:\\Temp")]);
        let input = payload(
            r#"{"argv":["a"],"cwd":"C:\\work","env":{"PATH":"C:\\tools","TEMP":"C:\\work\\tmp"},
                "network":"on"}"#,
        );
        let plan = plan_with_host_env(&input, &host_env).unwrap();
        assert_eq!(
            plan.environment.get("PATH").map(String::as_str),
            Some("C:\\tools")
        );
        assert_eq!(
            plan.environment.get("TEMP").map(String::as_str),
            Some("C:\\work\\tmp")
        );
    }

    #[test]
    fn an_empty_argv_is_refused_before_anything_else() {
        let input = payload(r#"{"argv":[],"cwd":"C:\\work","network":"off"}"#);
        assert_eq!(
            plan_with_host_env(&input, &host(&[])).unwrap_err(),
            PlanError::EmptyArgv
        );
    }

    const INFINITE: u32 = u32::MAX;

    #[test]
    fn short_timeout_passes_through_unchanged() {
        assert_eq!(clamp_timeout_millis(Duration::from_secs(300)), 300_000);
    }

    #[test]
    fn ninety_minute_timeout_is_not_truncated() {
        // 90 min = 5_400_000 ms — above the old u32-wrap edge but well under
        // the saturation ceiling, so it must round-trip exactly (the bug
        // returned a tiny wrapped value here, causing an instant timeout).
        let ms = 90u64 * 60 * 1000;
        assert_eq!(
            clamp_timeout_millis(Duration::from_secs(90 * 60)),
            ms as u32
        );
    }

    #[test]
    fn huge_timeout_saturates_below_the_infinite_sentinel() {
        let clamped = clamp_timeout_millis(Duration::from_secs(60 * 60 * 24 * 365));
        assert_eq!(clamped, INFINITE - 1);
        assert_ne!(clamped, INFINITE, "must never become the INFINITE sentinel");
    }

    #[test]
    fn exactly_at_the_ceiling_clamps_to_max_finite() {
        let clamped = clamp_timeout_millis(Duration::from_millis(u32::MAX as u64));
        assert_eq!(clamped, INFINITE - 1);
    }

    #[test]
    fn cpu_time_saturates_rather_than_wrapping() {
        assert_eq!(cpu_time_100ns(Duration::from_secs(1)), 10_000_000);
        assert_eq!(cpu_time_100ns(Duration::from_secs(u64::MAX / 2)), i64::MAX);
    }
}
