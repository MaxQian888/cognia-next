//! Versioned diagnostic observations from immutable, confined launch paths.
//! The Host validates every required observation; no guest success flag exists.
use crate::observation::{ProcessBoundaryReport, NAMESPACES};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROBE_VERSION: u32 = 1;
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
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkloadQualificationReport {
    pub report_version: u32,
    pub boundary_generation: String,
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
impl WorkloadQualificationReport {
    pub fn validate(&self) -> Result<(), &'static str> {
        use crate::observation::ObservationPhase;
        let fail = "managed_desktop_qualification_invalid";
        self.desktop.validate(1000)?;
        self.acceptance_admission.validate(1000)?;
        self.importer_admission.validate(1001)?;
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
            return Err(fail);
        }
        self.desktop_probe
            .acceptance
            .validate(1000, &self.desktop.namespaces)?;
        self.desktop_probe
            .terminal
            .validate(1000, &self.desktop.namespaces)?;
        self.desktop_probe
            .browser
            .process
            .validate(1000, &self.desktop.namespaces)?;
        self.importer_probe
            .importer
            .validate(1001, &self.importer_admission.namespaces)?;
        self.importer_probe
            .git
            .validate(1001, &self.importer_admission.namespaces)?;
        if !self
            .desktop_probe
            .acceptance
            .process
            .executable
            .eq("/usr/local/bin/cognia-desktop-guest")
            || !self
                .desktop_probe
                .terminal
                .process
                .executable
                .eq("/usr/local/bin/cognia-desktop-guest")
            || !self
                .importer_probe
                .importer
                .process
                .executable
                .eq("/usr/local/bin/cognia-desktop-guest")
            || !self.importer_probe.git.executable.eq("/usr/bin/git")
            || !self
                .desktop_probe
                .browser
                .process
                .executable
                .eq("/usr/lib/chromium/chromium")
            || self.importer_probe.git_exit_code != 0
            || self.desktop_probe.browser.exit_code != 0
            || self.desktop_probe.browser.local_preview != "cognia-qualified-loopback"
            || !self
                .desktop_probe
                .browser
                .metadata_navigation_net_errors
                .contains(&-109)
            || !self
                .desktop_probe
                .browser
                .redirect_net_errors
                .contains(&-109)
            || !self
                .desktop_probe
                .browser
                .hostname_net_errors
                .contains(&-105)
            || self.desktop_probe.acceptance.process.pid == self.desktop_probe.terminal.process.pid
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
            return Err(fail);
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
