//! Process-tree sampling via `sysinfo` — the data behind the Processes tab.
//!
//! Samples the current process plus every descendant (by parent-PID walk),
//! classifying each as the main app, the Node sidecar, or a generic child.
//! CPU is reported both raw (sysinfo's per-core-summed percentage, which can
//! exceed 100) and normalized to a 0–100 scale by dividing by the logical core
//! count — the Windows-Task-Manager convention the panel mirrors.
//!
//! Disk I/O is reported as bytes-per-second, derived from sysinfo's
//! bytes-since-last-refresh divided by the sampling interval.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// Role of a process within the app's process tree.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessRole {
    /// The cognia Tauri main process (our own PID).
    Main,
    /// The bundled Node sidecar (`claude-host.mjs`).
    Sidecar,
    /// Any other spawned descendant (sandbox runner, cli-bridge, cloudflared…).
    Child,
}

/// One process row in a [`super::sampler::PerfSample`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub role: ProcessRole,
    /// CPU normalized to 0–100 across all logical cores.
    pub cpu_pct: f32,
    /// Raw sysinfo CPU (sum across cores; can exceed 100).
    pub cpu_pct_raw: f32,
    pub mem_bytes: u64,
    pub disk_read_bps: u64,
    pub disk_write_bps: u64,
    /// Seconds the process has been running (from `sysinfo::Process::run_time`).
    pub run_secs: u64,
}

/// System-level memory snapshot for the memory-pressure gauge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemory {
    pub total_bytes: u64,
    pub used_bytes: u64,
}

/// Logical core count, used to normalize CPU into the 0–100 Task-Manager scale.
fn core_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .max(1)
}

/// What each tick asks sysinfo to refresh.
///
/// `cmd` is **not** optional here even though it is immutable per PID:
/// `ProcessRefreshKind::nothing()` leaves it at [`UpdateKind::Never`], which
/// makes `Process::cmd()` return an empty slice — and [`classify_role`] reads
/// only the cmdline to spot the sidecar, so with `cmd` off every descendant
/// silently collapses to [`ProcessRole::Child`] and the `sidecar` role becomes
/// unreachable in production. `OnlyIfNotSet` fetches argv once per PID, so the
/// cost is paid on first sight of a process rather than every tick.
fn refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_disk_usage()
        .with_cmd(UpdateKind::OnlyIfNotSet)
}

/// Classify a process given its name/cmdline and whether it is our own PID.
pub fn classify_role(pid: u32, current_pid: u32, name: &str, cmd: &[String]) -> ProcessRole {
    if pid == current_pid {
        return ProcessRole::Main;
    }
    let name_l = name.to_ascii_lowercase();
    let is_node = name_l.starts_with("node");
    let runs_sidecar = cmd.iter().any(|a| a.contains("claude-host.mjs"));
    if runs_sidecar || (is_node && cmd.iter().any(|a| a.contains("sidecar"))) {
        ProcessRole::Sidecar
    } else {
        ProcessRole::Child
    }
}

/// Compute the set of descendant PIDs of `root` from a child-index built out of
/// `parent_of` (pid → optional parent pid).
pub fn descendants(parent_of: &HashMap<u32, Option<u32>>, root: u32) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &parent) in parent_of {
        if let Some(p) = parent {
            children.entry(p).or_default().push(pid);
        }
    }
    let mut out = HashSet::new();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if let Some(kids) = children.get(&p) {
            for &k in kids {
                if out.insert(k) {
                    stack.push(k);
                }
            }
        }
    }
    out
}

/// Owns a persistent `sysinfo::System` so CPU deltas are accurate across ticks
/// (sysinfo needs two refreshes to compute CPU usage).
pub struct ProcessSampler {
    sys: System,
    current_pid: Option<u32>,
    cores: usize,
}

impl Default for ProcessSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessSampler {
    pub fn new() -> Self {
        Self {
            sys: System::new(),
            current_pid: sysinfo::get_current_pid().ok().map(|p| p.as_u32()),
            cores: core_count(),
        }
    }

    fn refresh(&mut self) {
        self.sys
            .refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
    }

    /// Prime CPU counters before the first real sample so the opening frame
    /// isn't all-zero (sysinfo's first CPU reading has no prior to diff).
    pub fn prime(&mut self) {
        self.refresh();
    }

    /// Sample the process tree. `interval_secs` is used to convert disk
    /// bytes-since-last-refresh into a per-second rate.
    pub fn sample(&mut self, interval_secs: f64) -> Vec<ProcessSample> {
        self.refresh();

        let Some(current_pid) = self.current_pid else {
            return Vec::new();
        };
        let secs = if interval_secs > 0.0 {
            interval_secs
        } else {
            1.0
        };
        let cores = self.cores.max(1) as f32;

        // Build the parent index, then the descendant set of our own PID.
        let parent_of: HashMap<u32, Option<u32>> = self
            .sys
            .processes()
            .values()
            .map(|p| (p.pid().as_u32(), p.parent().map(|pp| pp.as_u32())))
            .collect();
        let mut included = descendants(&parent_of, current_pid);
        included.insert(current_pid);

        let mut out: Vec<ProcessSample> = self
            .sys
            .processes()
            .values()
            .filter(|p| included.contains(&p.pid().as_u32()))
            .map(|p| {
                let pid = p.pid().as_u32();
                let name = p.name().to_string_lossy().to_string();
                let cmd: Vec<String> = p
                    .cmd()
                    .iter()
                    .map(|s| s.to_string_lossy().to_string())
                    .collect();
                let disk = p.disk_usage();
                let cpu_raw = p.cpu_usage();
                ProcessSample {
                    pid,
                    parent_pid: p.parent().map(|pp| pp.as_u32()),
                    role: classify_role(pid, current_pid, &name, &cmd),
                    name,
                    cpu_pct: (cpu_raw / cores).min(100.0),
                    cpu_pct_raw: cpu_raw,
                    mem_bytes: p.memory(),
                    disk_read_bps: (disk.read_bytes as f64 / secs) as u64,
                    disk_write_bps: (disk.written_bytes as f64 / secs) as u64,
                    run_secs: p.run_time(),
                }
            })
            .collect();

        // Main first, then heaviest CPU — matches the panel's default ordering.
        out.sort_by(|a, b| {
            (b.role == ProcessRole::Main)
                .cmp(&(a.role == ProcessRole::Main))
                .then(
                    b.cpu_pct
                        .partial_cmp(&a.cpu_pct)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
        });
        out
    }

    /// Return a system-level memory snapshot (total + used).
    pub fn sample_system_memory(&mut self) -> SystemMemory {
        self.sys.refresh_memory();
        SystemMemory {
            total_bytes: self.sys.total_memory(),
            used_bytes: self.sys.used_memory(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_kind_requests_the_cmdline() {
        // Regression guard: with `cmd` left at `Never`, `Process::cmd()` is
        // always empty and `classify_role` can never return `Sidecar`.
        assert_ne!(refresh_kind().cmd(), UpdateKind::Never);
    }

    #[test]
    fn sampled_processes_expose_a_cmdline() {
        // End-to-end proof that the refresh kind actually populates `cmd`:
        // the test process itself must have a non-empty argv.
        let mut s = ProcessSampler::new();
        s.prime();
        let me = sysinfo::get_current_pid().unwrap();
        let cmd = s.sys.process(me).map(|p| p.cmd().len()).unwrap_or(0);
        assert!(cmd > 0, "sysinfo must report a cmdline for our own process");
    }

    #[test]
    fn classify_role_identifies_main() {
        assert_eq!(classify_role(10, 10, "cognia-next", &[]), ProcessRole::Main);
    }

    #[test]
    fn classify_role_identifies_sidecar_by_cmdline() {
        let cmd = vec![
            "node".to_string(),
            "/app/sidecar/claude-host.mjs".to_string(),
        ];
        assert_eq!(
            classify_role(20, 10, "node.exe", &cmd),
            ProcessRole::Sidecar
        );
    }

    #[test]
    fn classify_role_defaults_to_child() {
        let cmd = vec!["cloudflared".to_string(), "tunnel".to_string()];
        assert_eq!(
            classify_role(30, 10, "cloudflared", &cmd),
            ProcessRole::Child
        );
    }

    #[test]
    fn descendants_walks_the_tree_transitively() {
        // 1 → 2 → 3, 1 → 4, plus an unrelated 99.
        let parent_of: HashMap<u32, Option<u32>> = [
            (1, None),
            (2, Some(1)),
            (3, Some(2)),
            (4, Some(1)),
            (99, None),
        ]
        .into_iter()
        .collect();
        let d = descendants(&parent_of, 1);
        let expected: HashSet<u32> = [2, 3, 4].into_iter().collect();
        assert_eq!(d, expected);
        assert!(!d.contains(&99));
        assert!(!d.contains(&1));
    }

    #[test]
    fn descendants_handles_cycles_without_hanging() {
        // Pathological self/back edges must not loop forever.
        let parent_of: HashMap<u32, Option<u32>> =
            [(1, Some(2)), (2, Some(1))].into_iter().collect();
        let _ = descendants(&parent_of, 1); // terminates
    }

    #[test]
    fn process_sample_serializes_run_secs_camel_case() {
        let sample = ProcessSample {
            pid: 1,
            parent_pid: None,
            name: "cognia".to_string(),
            role: ProcessRole::Main,
            cpu_pct: 1.0,
            cpu_pct_raw: 4.0,
            mem_bytes: 100,
            disk_read_bps: 0,
            disk_write_bps: 0,
            run_secs: 42,
        };
        let json = serde_json::to_string(&sample).unwrap();
        assert!(json.contains("\"runSecs\":42"));
    }

    #[test]
    fn sample_includes_the_current_process_as_main() {
        let mut s = ProcessSampler::new();
        s.prime();
        let rows = s.sample(1.0);
        // The test process is its own PID; it must appear and be classified Main.
        let me = sysinfo::get_current_pid().unwrap().as_u32();
        let mine = rows.iter().find(|r| r.pid == me);
        assert!(mine.is_some(), "current process should be sampled");
        assert_eq!(mine.unwrap().role, ProcessRole::Main);
    }
}
