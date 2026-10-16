//! Versioned diagnostic observations from immutable, confined launch paths.
//! The Host validates every required observation; no guest success flag exists.
use crate::observation::{ProcessBoundaryReport, NAMESPACES};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROBE_VERSION: u32 = 2;
pub const TARGETS: [&str; 15] = [
    "1.1.1.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "100.64.0.1",
    "169.254.0.1",
    "169.254.169.254",
    "2606:4700:4700::1111",
    "fd00:ec2::254",
    "169.254.170.2",
    "100.100.100.200",
    "::ffff:169.254.169.254",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
];
pub const HIDDEN_PATHS: [&str; 6] = [
    "/run/cognia-desktop/control.sock",
    "/run/cognia-desktop/state.json",
    "/run/cognia-desktop/relay.sock",
    "/run/envd.sock",
    "/root/.e2b",
    "/var/lib/cognia-desktop",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SocketAttempt {
    pub target: String,
    pub transport: String,
    pub port: u16,
    pub result: i32,
    pub errno: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorObservation {
    pub operation: String,
    pub result: i32,
    pub errno: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessSnapshot {
    pub pid: u32,
    pub start_time: u64,
    pub executable: String,
    pub status: String,
    pub namespaces: BTreeMap<String, String>,
    pub descriptors: BTreeMap<u32, crate::observation::DescriptorObservation>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeRun {
    pub process: ProcessSnapshot,
    pub sockets: Vec<SocketAttempt>,
    pub escapes: Vec<ErrorObservation>,
    pub paths: Vec<ErrorObservation>,
    pub hostnames: Vec<ErrorObservation>,
    pub local_helpers: Vec<ErrorObservation>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserRun {
    pub process: ProcessSnapshot,
    pub exit_code: i32,
    pub local_preview: String,
    pub metadata_navigation_net_errors: Vec<i32>,
    pub redirect_net_errors: Vec<i32>,
    pub hostname_net_errors: Vec<i32>,
}
impl BrowserRun {
    fn validate_outcome(&self) -> Result<(), &'static str> {
        if self.process.executable != "/usr/lib/chromium/chromium" {
            return Err("validation_browser_executable");
        }
        if self.exit_code != 0 {
            return Err("validation_browser_exit");
        }
        if self.local_preview != "cognia-qualified-loopback" {
            return Err("validation_browser_preview");
        }
        // Chromium normalizes failed TCP connects and system DNS lookups to
        // ERR_INTERNET_DISCONNECTED (-106) when only loopback is online. These
        // navigation outcomes do not replace the mandatory raw socket, DNS and
        // namespace observations validated by the complete report.
        let denied = |errors: &[i32], expected: i32| {
            !errors.is_empty() && errors.iter().all(|code| *code == expected || *code == -106)
        };
        if !denied(&self.metadata_navigation_net_errors, -109) {
            return Err("validation_browser_metadata");
        }
        if !denied(&self.redirect_net_errors, -109) {
            return Err("validation_browser_redirect");
        }
        if !denied(&self.hostname_net_errors, -105) {
            return Err("validation_browser_hostname");
        }
        Ok(())
    }
}

/// Failure-only diagnostic projection. It contains no URL, response, path,
/// environment or arbitrary message and can never substitute for a report.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserDiagnostic {
    pub boundary_generation: String,
    pub acceptance_executable_matches: bool,
    pub terminal_executable_matches: bool,
    pub importer_executable_matches: bool,
    pub git_executable_matches: bool,
    pub browser_executable_matches: bool,
    pub git_exit_code: i32,
    pub local_exit_code: i32,
    pub local_preview_present: bool,
    pub metadata_net_errors: Vec<i32>,
    pub redirect_net_errors: Vec<i32>,
    pub hostname_net_errors: Vec<i32>,
}
impl BrowserDiagnostic {
    pub fn from_report(report: &WorkloadQualificationReport) -> Self {
        let browser = &report.desktop_probe.browser;
        Self {
            boundary_generation: report.boundary_generation.clone(),
            acceptance_executable_matches: report.desktop_probe.acceptance.process.executable
                == "/usr/local/bin/cognia-desktop-guest",
            terminal_executable_matches: report.desktop_probe.terminal.process.executable
                == "/usr/local/bin/cognia-desktop-guest",
            importer_executable_matches: report.importer_probe.importer.process.executable
                == "/usr/local/bin/cognia-desktop-guest",
            git_executable_matches: report.importer_probe.git.executable == "/usr/bin/git",
            browser_executable_matches: browser.process.executable == "/usr/lib/chromium/chromium",
            git_exit_code: report.importer_probe.git_exit_code,
            local_exit_code: browser.exit_code,
            local_preview_present: browser.local_preview == "cognia-qualified-loopback",
            metadata_net_errors: browser
                .metadata_navigation_net_errors
                .iter()
                .take(8)
                .copied()
                .collect(),
            redirect_net_errors: browser
                .redirect_net_errors
                .iter()
                .take(8)
                .copied()
                .collect(),
            hostname_net_errors: browser
                .hostname_net_errors
                .iter()
                .take(8)
                .copied()
                .collect(),
        }
    }
    pub fn validate_for(&self, generation: &str) -> Result<(), &'static str> {
        if self.boundary_generation != generation
            || !uuid::Uuid::parse_str(generation)
                .is_ok_and(|id| !id.is_nil() && id.to_string() == generation)
            || !(0..=255).contains(&self.git_exit_code)
            || !(0..=255).contains(&self.local_exit_code)
            || [
                &self.metadata_net_errors,
                &self.redirect_net_errors,
                &self.hostname_net_errors,
            ]
            .into_iter()
            .any(|errors| {
                errors.len() > 8 || errors.iter().any(|code| !(-10000..=0).contains(code))
            })
        {
            return Err("managed_desktop_browser_diagnostic_invalid");
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopProbe {
    pub acceptance: ProbeRun,
    pub terminal: ProbeRun,
    pub browser: BrowserRun,
    pub detached_pid: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImporterProbe {
    pub importer: ProbeRun,
    pub git: ProcessSnapshot,
    pub git_exit_code: i32,
}
/// Actual root-observed intentionally incomplete launch, not mutated evidence.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WeakenedLaunchEvidence {
    pub profile: String,
    pub executable: String,
    pub admission: ProcessBoundaryReport,
    pub terminated_processes: BTreeMap<u32, u64>,
    pub surviving_processes: BTreeMap<u32, u64>,
}
impl WeakenedLaunchEvidence {
    pub fn validate(&self, desktop: &ProcessBoundaryReport) -> Result<(), &'static str> {
        let fail = "validation_weakened_launch";
        if self.profile != "importer-without-seccomp-v1"
            || self.executable != "/usr/local/bin/cognia-desktop-guest"
            || self.admission.boundary_generation != desktop.boundary_generation
            || self.admission.provider_namespaces != desktop.provider_namespaces
            || self.admission.phase != crate::observation::ObservationPhase::ImporterAdmission
            || NAMESPACES
                .iter()
                .any(|name| self.admission.namespaces.get(*name) == desktop.namespaces.get(*name))
            || self.admission.validate(1001).is_ok()
            || self.terminated_processes.len() < 2
            || self.terminated_processes.len() > 256
            || self
                .terminated_processes
                .iter()
                .any(|(pid, start)| *pid <= 1 || *start == 0)
            || self
                .terminated_processes
                .get(&self.admission.namespace_init_pid)
                != Some(&self.admission.namespace_init_start_time)
            || self.terminated_processes.get(&self.admission.workload_pid)
                != Some(&self.admission.workload_start_time)
            || !self.surviving_processes.is_empty()
        {
            return Err(fail);
        }
        let seccomp: Vec<_> = self
            .admission
            .status
            .lines()
            .filter_map(|line| line.strip_prefix("Seccomp:"))
            .collect();
        if seccomp.len() != 1 || seccomp[0].trim() != "0" {
            return Err(fail);
        }
        // The actual observation must fail the normal contract specifically
        // because the filter is absent. This verification copy is not evidence
        // of a real filtered process and is never returned as admission.
        let mut complete = self.admission.clone();
        complete.status = complete
            .status
            .lines()
            .map(|line| {
                if line.starts_with("Seccomp:") {
                    "Seccomp:2"
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        complete.validate(1001).map_err(|_| fail)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkloadQualificationReport {
    pub report_version: u32,
    pub boundary_generation: String,
    /// Actual provider-root collector context; must fail workload admission.
    pub negative_control: ProcessSnapshot,
    pub weakened_launch: WeakenedLaunchEvidence,
    pub desktop: ProcessBoundaryReport,
    pub acceptance_admission: ProcessBoundaryReport,
    pub importer_admission: ProcessBoundaryReport,
    pub desktop_probe: DesktopProbe,
    pub importer_probe: ImporterProbe,
    /// Outer PIDs and their pre-teardown start times, observed by the root collector.
    pub terminated_processes: BTreeMap<u32, u64>,
    /// The same root collector reads /proc after killing the pinned namespace init.
    pub surviving_processes: BTreeMap<u32, u64>,
    pub detached_outer_pid: u32,
    pub supervisor_pid: u32,
    pub supervisor_start_time: u64,
    pub ingress_errno: i32,
}
impl ProcessSnapshot {
    pub fn validate(
        &self,
        uid: u32,
        namespaces: &BTreeMap<String, String>,
    ) -> Result<(), &'static str> {
        let fail = "managed_desktop_probe_invalid";
        if self.pid == 0
            || self.start_time == 0
            || &self.namespaces != namespaces
            || self.namespaces.len() != 6
            || self.executable.len() > 256
            || self.status.len() > 4096
            || self.descriptors.len() > 128
            || !(0..=2).all(|fd| self.descriptors.contains_key(&fd))
        {
            return Err(fail);
        }
        let fields: BTreeMap<_, _> = self
            .status
            .lines()
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k, v.trim()))
            .collect();
        let id = uid.to_string();
        if !["Uid", "Gid"].iter().all(|k| {
            fields
                .get(k)
                .is_some_and(|v| v.split_whitespace().collect::<Vec<_>>() == [id.as_str(); 4])
        }) || fields.get("Groups") != Some(&"")
            || fields.get("NoNewPrivs") != Some(&"1")
            || fields.get("Seccomp") != Some(&"2")
            || !["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]
                .iter()
                .all(|k| {
                    fields
                        .get(k)
                        .is_some_and(|v| u64::from_str_radix(v, 16) == Ok(0))
                })
        {
            return Err(fail);
        }
        if self.descriptors.values().any(|v| {
            let path = &v.target;
            let allowed = path == "/dev/null"
                || path.starts_with("/dev/pts/")
                || path.starts_with("pipe:[") && path.ends_with(']')
                || path.starts_with("socket:[")
                    && path.ends_with(']')
                    && v.socket_scope.as_deref() == Some("workload")
                || matches!(
                    path.as_str(),
                    "anon_inode:[eventpoll]"
                        | "anon_inode:[eventfd]"
                        | "anon_inode:[timerfd]"
                        | "anon_inode:inotify"
                )
                || path.starts_with("/usr/") && v.flags & 3 == 0
                || path.starts_with("/tmp/cognia-p4-")
                || path.starts_with("/dev/shm/")
                || path.starts_with("/memfd:")
                || path == "/output/qualification.json";
            path.len() > 256
                || !allowed
                || !path.starts_with("socket:[") && v.socket_scope.is_some()
        }) {
            return Err(fail);
        }
        Ok(())
    }
}
impl ProbeRun {
    pub fn validate(
        &self,
        uid: u32,
        namespaces: &BTreeMap<String, String>,
    ) -> Result<(), &'static str> {
        let fail = "managed_desktop_probe_invalid";
        self.process.validate(uid, namespaces)?;
        if self.sockets.len() != TARGETS.len() * 3 {
            return Err(fail);
        }
        for target in TARGETS {
            for (transport, port) in [("tcp", 80), ("tcp", 443), ("udp", 443)] {
                let found: Vec<_> = self
                    .sockets
                    .iter()
                    .filter(|x| x.target == target && x.transport == transport && x.port == port)
                    .collect();
                // Linux ENETUNREACH only: a timeout, HTTP error, unsupported socket or policy rejection is not a no-route observation.
                if found.len() != 1 || found[0].result != -1 || found[0].errno != 101 {
                    return Err(fail);
                }
            }
        }
        if self.paths.len() != HIDDEN_PATHS.len()
            || HIDDEN_PATHS.iter().any(|p| {
                self.paths
                    .iter()
                    .filter(|v| v.operation == *p && v.result == -1 && matches!(v.errno, 2 | 13))
                    .count()
                    != 1
            })
        {
            return Err(fail);
        }
        if self.hostnames.len() != 2
            || ["example.com", "metadata.google.internal"]
                .iter()
                .any(|name| {
                    self.hostnames
                        .iter()
                        .filter(|x| {
                            x.operation == *name && x.result != 0 && matches!(x.errno, -2 | -3)
                        })
                        .count()
                        != 1
                })
            || self.local_helpers.len() != 2
            || ["127.0.0.1:49983", "127.0.0.1:8000"].iter().any(|name| {
                self.local_helpers
                    .iter()
                    .filter(|x| x.operation == *name && x.result == -1 && x.errno == 111)
                    .count()
                    != 1
            })
        {
            return Err(fail);
        }
        if self.escapes.len() != 2
            || self
                .escapes
                .iter()
                .filter(|v| v.operation == "unshareUser" && v.result == -1 && v.errno == 1)
                .count()
                != 1
            || self
                .escapes
                .iter()
                .filter(|v| {
                    v.operation == "setuidRoot" && v.result == -1 && matches!(v.errno, 1 | 22)
                })
                .count()
                != 1
        {
            return Err(fail);
        }
        Ok(())
    }
}
/// Runtime validator checks, run by both immutable collector and native Host.
/// These mutate observations, never the production kernel launch profile.
fn reject_tampered_probe(
    good: &ProbeRun,
    namespaces: &BTreeMap<String, String>,
) -> Result<(), &'static str> {
    let fail = "managed_desktop_negative_control_failed";
    good.validate(1000, namespaces)?;
    for (key, replacement) in [("CapEff", "1"), ("Seccomp", "0"), ("NoNewPrivs", "0")] {
        let mut bad = good.clone();
        bad.process.status = bad
            .process
            .status
            .lines()
            .map(|line| {
                if line.split_once(':').is_some_and(|(name, _)| name == key) {
                    format!("{key}:{replacement}")
                } else {
                    line.into()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if bad.validate(1000, namespaces).is_ok() {
            return Err(fail);
        }
    }
    let mut bad = good.clone();
    bad.process
        .namespaces
        .insert("net".into(), "net:[1]".into());
    if bad.validate(1000, namespaces).is_ok() {
        return Err(fail);
    }
    let mut bad = good.clone();
    bad.process.descriptors.insert(
        127,
        crate::observation::DescriptorObservation {
            target: "socket:[123]".into(),
            flags: 0,
            socket_scope: Some("outside".into()),
        },
    );
    if bad.validate(1000, namespaces).is_ok() {
        return Err(fail);
    }
    let mut bad = good.clone();
    bad.sockets[0].result = 0;
    bad.sockets[0].errno = 0;
    if bad.validate(1000, namespaces).is_ok() {
        return Err(fail);
    }
    Ok(())
}
impl WorkloadQualificationReport {
    pub fn validate(&self) -> Result<(), &'static str> {
        use crate::observation::ObservationPhase;
        self.desktop
            .validate(1000)
            .map_err(|_| "validation_desktop")?;
        let root_uid = self
            .negative_control
            .status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .map(|value| value.split_whitespace().collect::<Vec<_>>());
        if self.negative_control.pid <= 1
            || self.negative_control.start_time == 0
            || root_uid != Some(vec!["0", "0", "0", "0"])
            || self.negative_control.executable != "/usr/local/bin/cognia-desktop-guest"
            || self.negative_control.namespaces != self.desktop.provider_namespaces
            || self
                .negative_control
                .validate(1000, &self.desktop.namespaces)
                .is_ok()
        {
            return Err("validation_negative_control");
        }
        self.weakened_launch.validate(&self.desktop)?;
        reject_tampered_probe(&self.desktop_probe.acceptance, &self.desktop.namespaces)
            .map_err(|_| "validation_tamper_control")?;
        self.acceptance_admission
            .validate(1000)
            .map_err(|_| "validation_acceptance_admission")?;
        self.importer_admission
            .validate(1001)
            .map_err(|_| "validation_importer_admission")?;
        if self.report_version != PROBE_VERSION
            || self.boundary_generation != self.desktop.boundary_generation
            || self.desktop.phase != ObservationPhase::DesktopLive
            || self.acceptance_admission.phase != ObservationPhase::AcceptanceAdmission
            || self.importer_admission.phase != ObservationPhase::ImporterAdmission
            || self.acceptance_admission.boundary_generation != self.boundary_generation
            || self.importer_admission.boundary_generation != self.boundary_generation
            || self.acceptance_admission.namespaces != self.desktop.namespaces
            || self.acceptance_admission.namespace_init_pid != self.desktop.namespace_init_pid
            || self.acceptance_admission.namespace_init_start_time
                != self.desktop.namespace_init_start_time
            || self.importer_admission.provider_namespaces != self.desktop.provider_namespaces
            || NAMESPACES.iter().any(|n| {
                self.importer_admission.namespaces.get(*n) == self.desktop.namespaces.get(*n)
            })
        {
            return Err("validation_binding");
        }
        self.desktop_probe
            .acceptance
            .validate(1000, &self.desktop.namespaces)
            .map_err(|_| "validation_acceptance_probe")?;
        self.desktop_probe
            .terminal
            .validate(1000, &self.desktop.namespaces)
            .map_err(|_| "validation_terminal_probe")?;
        self.desktop_probe
            .browser
            .process
            .validate(1000, &self.desktop.namespaces)
            .map_err(|_| "validation_browser_process")?;
        self.importer_probe
            .importer
            .validate(1001, &self.importer_admission.namespaces)
            .map_err(|_| "validation_importer_probe")?;
        self.importer_probe
            .git
            .validate(1001, &self.importer_admission.namespaces)
            .map_err(|_| "validation_git_process")?;
        for (actual, expected, category) in [
            (
                &self.desktop_probe.acceptance.process.executable,
                "/usr/local/bin/cognia-desktop-guest",
                "validation_acceptance_executable",
            ),
            (
                &self.desktop_probe.terminal.process.executable,
                "/usr/local/bin/cognia-desktop-guest",
                "validation_terminal_executable",
            ),
            (
                &self.importer_probe.importer.process.executable,
                "/usr/local/bin/cognia-desktop-guest",
                "validation_importer_executable",
            ),
            (
                &self.importer_probe.git.executable,
                "/usr/bin/git",
                "validation_git_executable",
            ),
        ] {
            if actual != expected {
                return Err(category);
            }
        }
        if self.importer_probe.git_exit_code != 0 {
            return Err("validation_git_exit");
        }
        self.desktop_probe.browser.validate_outcome()?;
        if self.desktop_probe.acceptance.process.pid == self.desktop_probe.terminal.process.pid
            || self.desktop_probe.detached_pid == 0
            || self.detached_outer_pid <= 1
            || !self
                .terminated_processes
                .contains_key(&self.detached_outer_pid)
            || self.supervisor_pid <= 1
            || self.supervisor_start_time == 0
            || self.terminated_processes.get(&self.supervisor_pid)
                != Some(&self.supervisor_start_time)
            || self.ingress_errno != 111
            || self.terminated_processes.is_empty()
            || !self
                .terminated_processes
                .contains_key(&self.desktop.namespace_init_pid)
            || !self.surviving_processes.is_empty()
        {
            return Err("validation_teardown");
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_matrix_is_explicit_and_has_no_duplicates() {
        let set: std::collections::BTreeSet<_> = TARGETS.into_iter().collect();
        assert_eq!(set.len(), 15);
        assert!(TARGETS.contains(&"::ffff:169.254.169.254"));
    }
    fn valid_probe() -> ProbeRun {
        let namespaces = NAMESPACES
            .into_iter()
            .map(|n| (n.into(), format!("{n}:[42]")))
            .collect();
        ProbeRun{ process:ProcessSnapshot{pid:5,start_time:9,executable:"/usr/local/bin/cognia-desktop-guest".into(),status:"Uid:1000 1000 1000 1000\nGid:1000 1000 1000 1000\nGroups:\nCapInh:0\nCapPrm:0\nCapEff:0\nCapBnd:0\nCapAmb:0\nNoNewPrivs:1\nSeccomp:2".into(),namespaces,descriptors:(0..=2).map(|fd|(fd,crate::observation::DescriptorObservation{target:"/dev/null".into(),flags:0,socket_scope:None})).collect()}, sockets:TARGETS.into_iter().flat_map(|target|[("tcp",80),("tcp",443),("udp",443)].into_iter().map(move|(transport,port)|SocketAttempt{target:target.into(),transport:transport.into(),port,result:-1,errno:101})).collect(), escapes:vec![ErrorObservation{operation:"unshareUser".into(),result:-1,errno:1},ErrorObservation{operation:"setuidRoot".into(),result:-1,errno:22}], paths:HIDDEN_PATHS.into_iter().map(|operation|ErrorObservation{operation:operation.into(),result:-1,errno:2}).collect(), hostnames:["example.com","metadata.google.internal"].into_iter().map(|operation|ErrorObservation{operation:operation.into(),result:-3,errno:-3}).collect(),local_helpers:["127.0.0.1:49983","127.0.0.1:8000"].into_iter().map(|operation|ErrorObservation{operation:operation.into(),result:-1,errno:111}).collect() }
    }
    #[test]
    fn browser_failure_categories_preserve_each_required_outcome() {
        let mut process = valid_probe().process;
        process.executable = "/usr/lib/chromium/chromium".into();
        let good = BrowserRun {
            process,
            exit_code: 0,
            local_preview: "cognia-qualified-loopback".into(),
            metadata_navigation_net_errors: vec![-109],
            redirect_net_errors: vec![-109],
            hostname_net_errors: vec![-105],
        };
        assert!(good.validate_outcome().is_ok());
        let mut bad = good.clone();
        bad.process.executable = "/wrong".into();
        assert_eq!(bad.validate_outcome(), Err("validation_browser_executable"));
        let mut bad = good.clone();
        bad.exit_code = 1;
        assert_eq!(bad.validate_outcome(), Err("validation_browser_exit"));
        let mut bad = good.clone();
        bad.local_preview.clear();
        assert_eq!(bad.validate_outcome(), Err("validation_browser_preview"));
        let mut bad = good.clone();
        bad.metadata_navigation_net_errors = vec![-3];
        assert_eq!(bad.validate_outcome(), Err("validation_browser_metadata"));
        let mut bad = good.clone();
        bad.redirect_net_errors = vec![-3];
        assert_eq!(bad.validate_outcome(), Err("validation_browser_redirect"));
        let mut bad = good.clone();
        bad.hostname_net_errors = vec![-3];
        assert_eq!(bad.validate_outcome(), Err("validation_browser_hostname"));
    }
    #[test]
    fn browser_denials_require_nonempty_exact_target_specific_errors() {
        let mut process = valid_probe().process;
        process.executable = "/usr/lib/chromium/chromium".into();
        let good = BrowserRun {
            process,
            exit_code: 0,
            local_preview: "cognia-qualified-loopback".into(),
            metadata_navigation_net_errors: vec![-106],
            redirect_net_errors: vec![-106],
            hostname_net_errors: vec![-106],
        };
        assert!(good.validate_outcome().is_ok());
        let mut mixed_allowed = good.clone();
        mixed_allowed.metadata_navigation_net_errors.push(-109);
        mixed_allowed.redirect_net_errors.push(-109);
        mixed_allowed.hostname_net_errors.push(-105);
        assert!(mixed_allowed.validate_outcome().is_ok());

        for errors in [
            vec![],
            vec![0],
            vec![-106, 0],
            vec![-106, -3],
            vec![-106, -7],
            vec![-106, -102],
        ] {
            let mut bad = good.clone();
            bad.metadata_navigation_net_errors = errors.clone();
            assert_eq!(bad.validate_outcome(), Err("validation_browser_metadata"));
            let mut bad = good.clone();
            bad.redirect_net_errors = errors.clone();
            assert_eq!(bad.validate_outcome(), Err("validation_browser_redirect"));
            let mut bad = good.clone();
            bad.hostname_net_errors = errors;
            assert_eq!(bad.validate_outcome(), Err("validation_browser_hostname"));
        }
        let mut bad = good.clone();
        bad.metadata_navigation_net_errors.push(-105);
        assert_eq!(bad.validate_outcome(), Err("validation_browser_metadata"));
        let mut bad = good.clone();
        bad.redirect_net_errors.push(-105);
        assert_eq!(bad.validate_outcome(), Err("validation_browser_redirect"));
        let mut bad = good;
        bad.hostname_net_errors.push(-109);
        assert_eq!(bad.validate_outcome(), Err("validation_browser_hostname"));
    }
    #[test]
    fn weakened_launch_requires_actual_missing_filter_and_otherwise_complete_boundary() {
        use crate::observation::{ObservationPhase, ISOLATION_REVISION, REPORT_VERSION};
        let process = valid_probe().process;
        let mut admission = ProcessBoundaryReport {
            report_version: REPORT_VERSION,
            phase: ObservationPhase::ImporterAdmission,
            workload_isolation_revision: ISOLATION_REVISION,
            boundary_generation: "6a370d8e-2d69-40fb-9586-786b7424365a".into(),
            namespace_init_pid: 20,
            namespace_init_start_time: 1,
            workload_pid: 21,
            workload_start_time: 2,
            namespaces: process.namespaces.clone(),
            provider_namespaces: NAMESPACES
                .into_iter()
                .map(|name| (name.into(), format!("{name}:[1]")))
                .collect(),
            status: process
                .status
                .replace("1000", "1001")
                .replace("Seccomp:2", "Seccomp:0"),
            network_devices: "header\nheader\n lo: 0\n".into(),
            ipv4_routes: "header\n".into(),
            ipv6_routes: String::new(),
            descriptors: process.descriptors,
        };
        admission.descriptors.get_mut(&0).unwrap().target = "pipe:[42]".into();
        let mut desktop = admission.clone();
        desktop.namespaces = NAMESPACES
            .into_iter()
            .map(|name| (name.into(), format!("{name}:[3]")))
            .collect();
        let good = WeakenedLaunchEvidence {
            profile: "importer-without-seccomp-v1".into(),
            executable: "/usr/local/bin/cognia-desktop-guest".into(),
            admission,
            terminated_processes: [(20, 1), (21, 2)].into(),
            surviving_processes: BTreeMap::new(),
        };
        assert!(good.admission.validate(1001).is_err());
        assert!(good.validate(&desktop).is_ok());
        let mut bad = good.clone();
        bad.admission.status = bad.admission.status.replace("Seccomp:0", "Seccomp:2");
        assert!(bad.validate(&desktop).is_err()); // inherited filter cannot masquerade as a weak launch
        let mut bad = good.clone();
        bad.admission.status = bad.admission.status.replace("CapEff:0", "CapEff:1");
        assert!(bad.validate(&desktop).is_err());
        let mut bad = good.clone();
        bad.admission.ipv4_routes.push_str("unexpected route\n");
        assert!(bad.validate(&desktop).is_err());
        let mut bad = good.clone();
        bad.surviving_processes.insert(21, 2);
        assert!(bad.validate(&desktop).is_err());
        let mut bad = good.clone();
        bad.terminated_processes.insert(21, 3);
        assert!(bad.validate(&desktop).is_err());
        let mut bad = good.clone();
        bad.admission.boundary_generation = uuid::Uuid::new_v4().to_string();
        assert!(bad.validate(&desktop).is_err());
    }
    #[test]
    fn deliberately_weakened_profile_cannot_qualify() {
        let good = valid_probe();
        assert!(good.validate(1000, &good.process.namespaces).is_ok());
        let mut bad = good.clone();
        bad.process.status = bad.process.status.replace("CapEff:0", "CapEff:1");
        assert!(bad.validate(1000, &good.process.namespaces).is_err());
        let mut bad = good.clone();
        bad.sockets[0].errno = 110;
        assert!(bad.validate(1000, &good.process.namespaces).is_err());
        let mut bad = good.clone();
        bad.sockets[0].result = 0;
        bad.sockets[0].errno = 0;
        assert!(bad.validate(1000, &good.process.namespaces).is_err());
        let mut bad = good.clone();
        bad.sockets.pop();
        assert!(bad.validate(1000, &good.process.namespaces).is_err());
        let mut bad = good.clone();
        bad.process.descriptors.insert(
            5,
            crate::observation::DescriptorObservation {
                target: "socket:[123]".into(),
                flags: 0,
                socket_scope: Some("outside".into()),
            },
        );
        assert!(bad.validate(1000, &good.process.namespaces).is_err());
        let mut bad = good.clone();
        bad.process.descriptors.clear();
        assert!(bad.validate(1000, &good.process.namespaces).is_err());
        let mut bad = good.clone();
        bad.process.descriptors.insert(
            5,
            crate::observation::DescriptorObservation {
                target: "/proc/1/ns/net".into(),
                flags: 0,
                socket_scope: None,
            },
        );
        assert!(bad.validate(1000, &good.process.namespaces).is_err());
    }
    #[test]
    fn serialized_unknown_observations_refuse() {
        assert!(serde_json::from_str::<ErrorObservation>(
            r#"{"operation":"setuidRoot","result":-1,"errno":1,"passed":true}"#
        )
        .is_err());
    }
}
