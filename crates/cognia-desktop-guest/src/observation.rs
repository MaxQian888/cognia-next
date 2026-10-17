//! Versioned kernel observations. Serialized evidence is never an admission boolean.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const REPORT_VERSION: u32 = 1;
pub const ISOLATION_REVISION: u32 = 1;
pub const NAMESPACES: [&str; 6] = ["user", "mnt", "net", "pid", "ipc", "uts"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DescriptorObservation {
    pub target: String,
    /// Kernel fdinfo flags, parsed as octal by the observer.
    pub flags: u64,
    /// Socket ownership: workload network namespace or fixed GUI ingress only.
    pub socket_scope: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ObservationPhase {
    DesktopLive,
    ImporterAdmission,
    AcceptanceAdmission,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessBoundaryReport {
    pub report_version: u32,
    pub phase: ObservationPhase,
    pub workload_isolation_revision: u32,
    pub boundary_generation: String,
    pub namespace_init_pid: u32,
    pub namespace_init_start_time: u64,
    pub workload_pid: u32,
    pub workload_start_time: u64,
    pub namespaces: BTreeMap<String, String>,
    pub provider_namespaces: BTreeMap<String, String>,
    pub status: String,
    pub network_devices: String,
    pub ipv4_routes: String,
    pub ipv6_routes: String,
    pub descriptors: BTreeMap<u32, DescriptorObservation>,
}
impl ProcessBoundaryReport {
    /// Called independently by the native Host after bounded authenticated transport.
    pub fn validate(&self, uid: u32) -> Result<(), &'static str> {
        let fail = "managed_desktop_boundary_invalid";
        if self.report_version != REPORT_VERSION
            || self.workload_isolation_revision != ISOLATION_REVISION
            || !uuid::Uuid::parse_str(&self.boundary_generation)
                .is_ok_and(|id| !id.is_nil() && id.to_string() == self.boundary_generation)
            || self.namespace_init_pid <= 1
            || self.workload_pid <= 1
            || self.namespace_init_start_time == 0
            || self.workload_start_time == 0
            || self.namespaces.len() != 6
            || self.provider_namespaces.len() != 6
            || ![1000, 1001].contains(&uid)
        {
            return Err(fail);
        }
        for name in NAMESPACES {
            let valid = |value: &str| {
                value
                    .strip_prefix(&format!("{name}:["))
                    .and_then(|v| v.strip_suffix(']'))
                    .is_some_and(|v| v.parse::<u64>().is_ok_and(|n| n > 0))
            };
            let value = self.namespaces.get(name).ok_or(fail)?;
            let outer = self.provider_namespaces.get(name).ok_or(fail)?;
            if !valid(value) || !valid(outer) || value == outer {
                return Err(fail);
            }
        }
        if self.status.len() > 2048
            || self.network_devices.len() > 4096
            || self.ipv4_routes.len() > 4096
            || self.ipv6_routes.len() > 8192
        {
            return Err(fail);
        }
        let fields: BTreeMap<_, _> = self
            .status
            .lines()
            .filter_map(|line| line.split_once(':'))
            .map(|(k, v)| (k, v.trim()))
            .collect();
        let uid = uid.to_string();
        if !["Uid", "Gid"].iter().all(|key| {
            fields.get(key).is_some_and(|v| {
                let ids: Vec<_> = v.split_whitespace().collect();
                ids.len() == 4 && ids.iter().all(|id| *id == uid)
            })
        }) || !["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]
            .iter()
            .all(|key| {
                fields
                    .get(key)
                    .is_some_and(|v| u64::from_str_radix(v, 16) == Ok(0))
            })
            || fields.get("Groups") != Some(&"")
            || fields.get("NoNewPrivs") != Some(&"1")
            || fields.get("Seccomp") != Some(&"2")
        {
            return Err(fail);
        }
        let interfaces: Vec<_> = self
            .network_devices
            .lines()
            .skip(2)
            .filter_map(|line| line.split_once(':').map(|(name, _)| name.trim()))
            .collect();
        if interfaces != ["lo"]
            || self
                .ipv4_routes
                .lines()
                .skip(1)
                .any(|line| !line.trim().is_empty())
            || self
                .ipv6_routes
                .lines()
                .any(|line| line.split_whitespace().last() != Some("lo"))
        {
            return Err(fail);
        }
        if self.descriptors.len() < 3
            || self.descriptors.len() > 128
            || !(0..=2).all(|fd| self.descriptors.contains_key(&fd))
        {
            return Err(fail);
        }
        if (uid == "1001") != (self.phase == ObservationPhase::ImporterAdmission) {
            return Err(fail);
        }
        let mut gates = 0;
        for (fd, value) in &self.descriptors {
            if self.phase == ObservationPhase::AcceptanceAdmission {
                if *fd <= 2 && value.target != "/dev/null" {
                    return Err(fail);
                }
                if *fd > 2 {
                    if !value.target.starts_with("pipe:[") || value.flags & 0o2000000 == 0 {
                        return Err(fail);
                    }
                    gates += 1;
                }
            }
            if self.phase == ObservationPhase::ImporterAdmission {
                let allowed = match fd {
                    0 => value.target.starts_with("pipe:["),
                    1 | 2 => value.target == "/dev/null",
                    _ => value.target == "/opt/cognia-desktop/handoff-import.py",
                };
                if !allowed {
                    return Err(fail);
                }
            }
            let target = &value.target;
            if target.len() > 256 {
                return Err(fail);
            }
            let socket = target.starts_with("socket:[") && target.ends_with(']');
            if socket {
                if !matches!(
                    value.socket_scope.as_deref(),
                    Some("workload") | Some("gui-ingress")
                ) {
                    return Err(fail);
                }
            } else {
                if value.socket_scope.is_some() {
                    return Err(fail);
                }
                let allowed = target == "/dev/null"
                    || target.starts_with("pipe:[") && target.ends_with(']')
                    || matches!(
                        target.as_str(),
                        "anon_inode:[eventpoll]" | "anon_inode:[eventfd]"
                    )
                    || value.flags & 3 == 0
                        && (target.starts_with("/usr/")
                            || target.starts_with("/opt/cognia-desktop/"));
                if !allowed {
                    return Err(fail);
                }
            }
        }
        if self.phase == ObservationPhase::AcceptanceAdmission && gates != 2 {
            return Err(fail);
        }
        Ok(())
    }
    pub fn same_boundary(&self, other: &Self) -> bool {
        self.phase == other.phase
            && self.report_version == other.report_version
            && self.workload_isolation_revision == other.workload_isolation_revision
            && self.boundary_generation == other.boundary_generation
            && self.namespace_init_pid == other.namespace_init_pid
            && self.namespace_init_start_time == other.namespace_init_start_time
            && self.workload_pid == other.workload_pid
            && self.workload_start_time == other.workload_start_time
            && self.namespaces == other.namespaces
            && self.provider_namespaces == other.provider_namespaces
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn valid() -> ProcessBoundaryReport {
        ProcessBoundaryReport { report_version:1, phase:ObservationPhase::DesktopLive, workload_isolation_revision:1, boundary_generation: "6a370d8e-2d69-40fb-9586-786b7424365a".into(), namespace_init_pid:20, namespace_init_start_time:1, workload_pid:21, workload_start_time:2,
            namespaces:NAMESPACES.into_iter().map(|n|(n.into(),format!("{n}:[2]"))).collect(), provider_namespaces:NAMESPACES.into_iter().map(|n|(n.into(),format!("{n}:[1]"))).collect(),
            status:"Uid:1000 1000 1000 1000\nGid:1000 1000 1000 1000\nGroups:\nCapInh:0\nCapPrm:0\nCapEff:0\nCapBnd:0\nCapAmb:0\nNoNewPrivs:1\nSeccomp:2\n".into(), network_devices:"header\nheader\n lo: 0\n".into(),ipv4_routes:"header\n".into(),ipv6_routes:String::new(), descriptors:(0..=2).map(|fd|(fd,DescriptorObservation{target:"/dev/null".into(), flags:0, socket_scope:None})).collect() }
    }
    #[test]
    fn rejects_weakened_profiles_and_old_reports() {
        let report = valid();
        assert!(report.validate(1000).is_ok());
        let mut bad = report.clone();
        bad.report_version = 0;
        assert!(bad.validate(1000).is_err());
        let mut bad = report.clone();
        bad.namespaces = bad.provider_namespaces.clone();
        assert!(bad.validate(1000).is_err());
        let mut bad = report.clone();
        bad.status = bad.status.replace("CapBnd:0", "CapBnd:1");
        assert!(bad.validate(1000).is_err());
        let mut bad = report.clone();
        bad.network_devices.push_str("eth0: 0\n");
        assert!(bad.validate(1000).is_err());
        let mut bad = report.clone();
        bad.descriptors.get_mut(&0).unwrap().target = "net:[1]".into();
        assert!(bad.validate(1000).is_err());
        let mut bad = report.clone();
        bad.descriptors.get_mut(&0).unwrap().target = "socket:[55]".into();
        assert!(bad.validate(1000).is_err());
        let mut bad = report.clone();
        bad.boundary_generation = uuid::Uuid::new_v4().to_string();
        assert!(!report.same_boundary(&bad));
    }
}
