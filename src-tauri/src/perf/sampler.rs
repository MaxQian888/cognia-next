//! Demand-driven host performance sampling with versioned leases and frames.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::process::{ProcessSample, ProcessSampler, SystemMemory};
use super::registry::{SpanSnapshot, REGISTRY};
use super::runtime::{RuntimeSample, RuntimeSampler};

pub const FRAME_EVENT: &str = "perf://frame";
pub const SAMPLE_EVENT: &str = "perf://sample";
pub const PERF_WIRE_VERSION: u8 = 1;
pub const RING_CAP: usize = 120;
pub const DEFAULT_INTERVAL_MS: u64 = 1000;
pub const LOCAL_MIN_INTERVAL_MS: u64 = 250;
pub const REMOTE_MIN_INTERVAL_MS: u64 = 500;
pub const MAX_INTERVAL_MS: u64 = 10_000;
pub const LEASE_TTL_MS: i64 = 15_000;
pub const MAX_HOST_LEASES: usize = 16;
const OPEN_RATE_LIMIT_MS: i64 = 100;

/// Framework-free host boundary for managed-process collection and event
/// delivery. The lease/sampling core never receives a Tauri `AppHandle` or
/// Companion server state; desktop and headless adapters own those details.
pub trait PerfHostPort: Send + Sync {
    fn collect_managed(
        &self,
    ) -> Pin<Box<dyn Future<Output = Vec<crate::process_registry::ManagedProcess>> + Send + '_>>;

    fn emit(&self, frame: &PerfFrame, deliveries: &[PerfDelivery]);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PerfDelivery {
    pub lease_id: String,
    pub device_id: String,
    pub requested_interval_ms: u64,
    pub remote: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PerfBuildDescriptor {
    pub version: String,
    pub commit: Option<String>,
    pub profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PerfClockDescriptor {
    pub kind: String,
    pub origin_wall_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PerfConnectionDescriptor {
    pub state: String,
    pub changed_at_ms: i64,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PerfSourceDescriptor {
    pub wire_version: u8,
    pub source_id: String,
    pub kind: String,
    pub host_instance_id: String,
    pub runtime_kind: String,
    pub build: PerfBuildDescriptor,
    pub metric_schema_version: u32,
    pub capabilities: Vec<String>,
    pub clock: PerfClockDescriptor,
    pub connection: PerfConnectionDescriptor,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PerfLeasePurpose {
    Live,
    Capture,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PerfLease {
    pub wire_version: u8,
    pub lease_id: String,
    pub client_id: String,
    pub device_id: String,
    pub target_id: String,
    pub routing_generation: u64,
    pub source_id: Option<String>,
    pub purpose: PerfLeasePurpose,
    pub requested_cadence_ms: u64,
    pub sampling_session_id: String,
    pub opened_at_ms: i64,
    pub heartbeat_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfOpenLeaseRequest {
    pub client_id: String,
    pub device_id: String,
    pub target_id: String,
    pub routing_generation: u64,
    pub purpose: PerfLeasePurpose,
    pub requested_cadence_ms: u64,
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PerfOpenLeaseResult {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<PerfLease>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<PerfSourceDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl PerfOpenLeaseResult {
    fn accepted(lease: PerfLease, source: PerfSourceDescriptor) -> Self {
        Self {
            accepted: true,
            lease: Some(lease),
            source: Some(source),
            code: None,
            detail: None,
        }
    }

    fn rejected(code: &str, detail: &str) -> Self {
        Self {
            accepted: false,
            lease: None,
            source: None,
            code: Some(code.to_string()),
            detail: Some(detail.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PerfFrameFlags {
    pub reset: bool,
    pub discontinuity: bool,
    pub counter_reset: bool,
    pub source_restarted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerfFrame {
    pub wire_version: u8,
    pub source_id: String,
    pub target_id: String,
    pub routing_generation: u64,
    pub host_instance_id: String,
    pub sampling_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    pub sequence: u64,
    pub requested_interval_ms: u64,
    pub actual_interval_ms: u64,
    pub monotonic_elapsed_ms: u64,
    pub wall_start_ms: i64,
    pub wall_end_ms: i64,
    pub collection_duration_ms: u64,
    pub missed_ticks: u64,
    pub flags: PerfFrameFlags,
    // One-release compatibility payload.
    pub ts_ms: i64,
    pub interval_ms: u64,
    pub processes: Vec<ProcessSample>,
    pub runtime: RuntimeSample,
    pub top_spans: Vec<SpanSnapshot>,
    pub system_memory: Option<SystemMemory>,
    pub managed: Vec<crate::process_registry::ManagedProcess>,
}

pub type PerfSample = PerfFrame;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerfGap {
    pub reason: String,
    pub source_id: String,
    pub sampling_session_id: String,
    pub sequence_start: Option<u64>,
    pub sequence_end: Option<u64>,
    pub wall_start_ms: i64,
    pub wall_end_ms: i64,
    pub recoverable: bool,
    pub clock_uncertainty_ms: Option<u64>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSnapshot {
    pub wire_version: u8,
    pub frames: Vec<PerfFrame>,
    pub oldest_sequence: Option<u64>,
    pub latest_sequence: Option<u64>,
    pub sources: Vec<PerfSourceDescriptor>,
    pub leases: Vec<PerfLease>,
    pub gaps: Vec<PerfGap>,
    pub samples: Vec<PerfFrame>,
    pub running: bool,
    pub interval_ms: u64,
}

#[derive(Debug, Clone)]
struct LeaseEntry {
    lease: PerfLease,
    remote: bool,
    delivered_sequences: VecDeque<u64>,
    last_delivered_wall_ms: i64,
}

struct SamplerInner {
    leases: HashMap<String, LeaseEntry>,
    legacy_leases: VecDeque<String>,
    last_open_by_device: HashMap<String, i64>,
    last_renew_by_device: HashMap<String, i64>,
    ring: VecDeque<PerfFrame>,
    gaps: VecDeque<PerfGap>,
    sampling_session_id: String,
    target_id: String,
    routing_generation: u64,
}

pub struct SamplerHandle {
    running: AtomicBool,
    generation: AtomicU64,
    sequence: AtomicU64,
    source: PerfSourceDescriptor,
    inner: Mutex<SamplerInner>,
    host_port: Mutex<Option<Arc<dyn PerfHostPort>>>,
}

impl Default for SamplerHandle {
    fn default() -> Self {
        let now = super::now_ms();
        let host_instance_id = uuid::Uuid::new_v4().to_string();
        Self {
            running: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            sequence: AtomicU64::new(0),
            source: PerfSourceDescriptor {
                wire_version: PERF_WIRE_VERSION,
                source_id: format!("host:{host_instance_id}"),
                kind: "host".to_string(),
                host_instance_id,
                runtime_kind: "tauri-rust".to_string(),
                build: PerfBuildDescriptor {
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    commit: option_env!("GIT_COMMIT").map(str::to_string),
                    profile: if cfg!(debug_assertions) {
                        "development".to_string()
                    } else {
                        "production".to_string()
                    },
                },
                metric_schema_version: 1,
                capabilities: vec![
                    "host.processes".to_string(),
                    "host.system-memory-utilization".to_string(),
                    "runtime.tokio".to_string(),
                    "runtime.dial9".to_string(),
                    "host.managed-processes".to_string(),
                    "host.traces".to_string(),
                ],
                clock: PerfClockDescriptor {
                    kind: "host-monotonic".to_string(),
                    origin_wall_ms: now,
                },
                connection: PerfConnectionDescriptor {
                    state: "live".to_string(),
                    changed_at_ms: now,
                    detail: None,
                },
            },
            inner: Mutex::new(SamplerInner {
                leases: HashMap::new(),
                legacy_leases: VecDeque::new(),
                last_open_by_device: HashMap::new(),
                last_renew_by_device: HashMap::new(),
                ring: VecDeque::new(),
                gaps: VecDeque::new(),
                sampling_session_id: uuid::Uuid::new_v4().to_string(),
                target_id: "local-desktop".to_string(),
                routing_generation: 0,
            }),
            host_port: Mutex::new(None),
        }
    }
}

impl SamplerHandle {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn interval(&self) -> u64 {
        self.fastest_interval().unwrap_or(DEFAULT_INTERVAL_MS)
    }

    pub fn leases(&self) -> u64 {
        self.inner.lock().leases.len() as u64
    }

    pub fn source(&self) -> PerfSourceDescriptor {
        self.source.clone()
    }

    pub fn open(
        &self,
        request: PerfOpenLeaseRequest,
        remote: bool,
        now_ms: i64,
    ) -> PerfOpenLeaseResult {
        let minimum = if remote {
            REMOTE_MIN_INTERVAL_MS
        } else {
            LOCAL_MIN_INTERVAL_MS
        };
        if request.requested_cadence_ms < minimum {
            return PerfOpenLeaseResult::rejected(
                "cadence-too-fast",
                "requested cadence is below the admitted minimum",
            );
        }
        if request.requested_cadence_ms > MAX_INTERVAL_MS {
            return PerfOpenLeaseResult::rejected(
                "unsupported",
                "requested cadence exceeds the supported maximum",
            );
        }
        let mut inner = self.inner.lock();
        Self::expire_locked(&mut inner, now_ms);
        if inner.leases.len() >= MAX_HOST_LEASES {
            return PerfOpenLeaseResult::rejected("host-lease-limit", "host lease limit reached");
        }
        if inner.leases.values().any(|entry| {
            entry.lease.device_id == request.device_id && entry.lease.purpose == request.purpose
        }) {
            return PerfOpenLeaseResult::rejected(
                "device-purpose-limit",
                "device already owns a lease for this purpose",
            );
        }
        if remote
            && inner
                .last_open_by_device
                .get(&request.device_id)
                .is_some_and(|last| now_ms.saturating_sub(*last) < OPEN_RATE_LIMIT_MS)
        {
            return PerfOpenLeaseResult::rejected("rate-limited", "lease open is rate limited");
        }
        inner
            .last_open_by_device
            .insert(request.device_id.clone(), now_ms);
        if inner.leases.is_empty() {
            inner.sampling_session_id = uuid::Uuid::new_v4().to_string();
            inner.target_id = request.target_id.clone();
            inner.routing_generation = request.routing_generation;
            self.sequence.store(0, Ordering::SeqCst);
        } else if inner.target_id != request.target_id {
            return PerfOpenLeaseResult::rejected(
                "target-mismatch",
                "active leases bind another target",
            );
        } else if inner.routing_generation != request.routing_generation {
            return PerfOpenLeaseResult::rejected(
                "routing-generation-mismatch",
                "active leases bind another routing generation",
            );
        }
        let lease = PerfLease {
            wire_version: PERF_WIRE_VERSION,
            lease_id: uuid::Uuid::new_v4().to_string(),
            client_id: request.client_id,
            device_id: request.device_id,
            target_id: request.target_id,
            routing_generation: request.routing_generation,
            source_id: request.source_id,
            purpose: request.purpose,
            requested_cadence_ms: request.requested_cadence_ms,
            sampling_session_id: inner.sampling_session_id.clone(),
            opened_at_ms: now_ms,
            heartbeat_at_ms: now_ms,
            expires_at_ms: now_ms + LEASE_TTL_MS,
        };
        inner.leases.insert(
            lease.lease_id.clone(),
            LeaseEntry {
                lease: lease.clone(),
                remote,
                delivered_sequences: VecDeque::new(),
                last_delivered_wall_ms: 0,
            },
        );
        PerfOpenLeaseResult::accepted(lease, self.source())
    }

    pub fn renew(
        &self,
        lease_id: &str,
        device_id: Option<&str>,
        now_ms: i64,
    ) -> Result<PerfLease, String> {
        let mut inner = self.inner.lock();
        Self::expire_locked(&mut inner, now_ms);
        let Some(entry) = inner.leases.get_mut(lease_id) else {
            return Err("lease-expired".to_string());
        };
        Self::assert_owner(entry, device_id)?;
        let renew_device = entry.lease.device_id.clone();
        let is_remote = entry.remote;
        if is_remote
            && inner
                .last_renew_by_device
                .get(&renew_device)
                .is_some_and(|last| now_ms.saturating_sub(*last) < OPEN_RATE_LIMIT_MS)
        {
            return Err("rate-limited".to_string());
        }
        if is_remote {
            inner.last_renew_by_device.insert(renew_device, now_ms);
        }
        let Some(entry) = inner.leases.get_mut(lease_id) else {
            return Err("lease-expired".to_string());
        };
        entry.lease.heartbeat_at_ms = now_ms;
        entry.lease.expires_at_ms = now_ms + LEASE_TTL_MS;
        Ok(entry.lease.clone())
    }

    pub fn close(&self, lease_id: &str, device_id: Option<&str>) -> Result<bool, String> {
        let empty = {
            let mut inner = self.inner.lock();
            let Some(entry) = inner.leases.get(lease_id) else {
                return Err("lease-expired".to_string());
            };
            Self::assert_owner(entry, device_id)?;
            inner.leases.remove(lease_id);
            inner.leases.is_empty()
        };
        if empty {
            self.running.store(false, Ordering::SeqCst);
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
        Ok(empty)
    }

    pub fn close_legacy(&self) {
        let lease_id = self.inner.lock().legacy_leases.pop_front();
        if let Some(lease_id) = lease_id {
            let _ = self.close(&lease_id, None);
        }
    }

    pub fn set_legacy_interval(&self, interval_ms: u64) {
        let cadence = interval_ms.clamp(LOCAL_MIN_INTERVAL_MS, MAX_INTERVAL_MS);
        let mut inner = self.inner.lock();
        let legacy_ids: Vec<_> = inner.legacy_leases.iter().cloned().collect();
        for lease_id in legacy_ids {
            if let Some(entry) = inner.leases.get_mut(&lease_id) {
                entry.lease.requested_cadence_ms = cadence;
            }
        }
    }

    pub fn halt(&self) {
        let mut inner = self.inner.lock();
        inner.leases.clear();
        inner.legacy_leases.clear();
        self.running.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn snapshot(
        &self,
        lease_id: Option<&str>,
        device_id: Option<&str>,
        now_ms: i64,
    ) -> Result<PerfSnapshot, String> {
        let mut inner = self.inner.lock();
        Self::expire_locked(&mut inner, now_ms);
        if let Some(id) = lease_id {
            let Some(entry) = inner.leases.get(id) else {
                return Err("lease-expired".to_string());
            };
            Self::assert_owner(entry, device_id)?;
        }
        let frames: Vec<_> = match lease_id.and_then(|id| inner.leases.get(id)) {
            Some(entry) => {
                let delivered: std::collections::HashSet<_> =
                    entry.delivered_sequences.iter().copied().collect();
                inner
                    .ring
                    .iter()
                    .filter(|frame| {
                        frame.sampling_session_id == entry.lease.sampling_session_id
                            && delivered.contains(&frame.sequence)
                    })
                    .map(|frame| {
                        let mut frame = frame.clone();
                        frame.lease_id = Some(entry.lease.lease_id.clone());
                        frame.requested_interval_ms = entry.lease.requested_cadence_ms;
                        frame
                    })
                    .collect()
            }
            None => inner
                .ring
                .iter()
                .filter(|frame| frame.sampling_session_id == inner.sampling_session_id)
                .cloned()
                .collect(),
        };
        let leases = match lease_id {
            Some(id) => inner
                .leases
                .get(id)
                .map(|entry| vec![entry.lease.clone()])
                .unwrap_or_default(),
            None => inner
                .leases
                .values()
                .map(|entry| entry.lease.clone())
                .collect(),
        };
        Ok(PerfSnapshot {
            wire_version: PERF_WIRE_VERSION,
            oldest_sequence: frames.first().map(|frame| frame.sequence),
            latest_sequence: frames.last().map(|frame| frame.sequence),
            samples: frames.clone(),
            frames,
            sources: vec![self.source()],
            leases,
            gaps: inner.gaps.iter().cloned().collect(),
            running: !inner.leases.is_empty(),
            interval_ms: inner
                .leases
                .values()
                .map(|entry| entry.lease.requested_cadence_ms)
                .min()
                .unwrap_or(DEFAULT_INTERVAL_MS),
        })
    }

    pub fn read_observations(
        &self,
        lease_id: &str,
        after_sequence: Option<u64>,
        device_id: Option<&str>,
        now_ms: i64,
    ) -> Result<Vec<PerfFrame>, String> {
        let snapshot = self.snapshot(Some(lease_id), device_id, now_ms)?;
        Ok(snapshot
            .frames
            .into_iter()
            .filter(|frame| after_sequence.is_none_or(|sequence| frame.sequence > sequence))
            .collect())
    }

    fn fastest_interval(&self) -> Option<u64> {
        self.inner
            .lock()
            .leases
            .values()
            .map(|entry| entry.lease.requested_cadence_ms)
            .min()
    }

    fn expire_locked(inner: &mut SamplerInner, now_ms: i64) {
        inner
            .leases
            .retain(|_, entry| entry.lease.expires_at_ms > now_ms);
    }

    fn push(&self, frame: PerfFrame) {
        let mut inner = self.inner.lock();
        if inner.ring.len() >= RING_CAP {
            inner.ring.pop_front();
        }
        inner.ring.push_back(frame);
    }

    fn deliveries(&self, frame: &PerfFrame) -> Vec<PerfDelivery> {
        let mut inner = self.inner.lock();
        let oldest = inner
            .ring
            .front()
            .map(|value| value.sequence)
            .unwrap_or(frame.sequence);
        let mut deliveries = Vec::new();
        for entry in inner.leases.values_mut() {
            let due = entry.last_delivered_wall_ms == 0
                || frame
                    .wall_end_ms
                    .saturating_sub(entry.last_delivered_wall_ms)
                    >= entry.lease.requested_cadence_ms as i64;
            if !due {
                continue;
            }
            entry.last_delivered_wall_ms = frame.wall_end_ms;
            entry.delivered_sequences.push_back(frame.sequence);
            while entry
                .delivered_sequences
                .front()
                .is_some_and(|sequence| *sequence < oldest)
            {
                entry.delivered_sequences.pop_front();
            }
            deliveries.push(PerfDelivery {
                lease_id: entry.lease.lease_id.clone(),
                device_id: entry.lease.device_id.clone(),
                requested_interval_ms: entry.lease.requested_cadence_ms,
                remote: entry.remote,
            });
        }
        deliveries
    }

    fn assert_owner(entry: &LeaseEntry, device_id: Option<&str>) -> Result<(), String> {
        if device_id.is_some_and(|value| value != entry.lease.device_id) {
            Err("permission-denied".to_string())
        } else {
            Ok(())
        }
    }

    fn frame_scope(&self) -> (String, u64, String) {
        let inner = self.inner.lock();
        (
            inner.target_id.clone(),
            inner.routing_generation,
            inner.sampling_session_id.clone(),
        )
    }
}

pub fn open_lease(
    handle: Arc<SamplerHandle>,
    request: PerfOpenLeaseRequest,
    remote: bool,
    host_port: Arc<dyn PerfHostPort>,
) -> PerfOpenLeaseResult {
    *handle.host_port.lock() = Some(host_port);
    let result = handle.open(request, remote, super::now_ms());
    if result.accepted {
        ensure_loop(handle);
    }
    result
}

/// Compatibility adapter for the old local start command.
pub fn start(handle: Arc<SamplerHandle>, interval_ms: u64, host_port: Arc<dyn PerfHostPort>) {
    *handle.host_port.lock() = Some(host_port);
    let legacy_id = uuid::Uuid::new_v4().to_string();
    let result = handle.open(
        PerfOpenLeaseRequest {
            client_id: format!("legacy:{legacy_id}"),
            device_id: format!("legacy:{legacy_id}"),
            target_id: "local-desktop".to_string(),
            routing_generation: 0,
            purpose: PerfLeasePurpose::Live,
            requested_cadence_ms: interval_ms.clamp(LOCAL_MIN_INTERVAL_MS, MAX_INTERVAL_MS),
            source_id: None,
        },
        false,
        super::now_ms(),
    );
    if let Some(lease) = result.lease {
        handle.inner.lock().legacy_leases.push_back(lease.lease_id);
        ensure_loop(handle);
    }
}

pub fn ensure_loop(handle: Arc<SamplerHandle>) {
    if handle.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let generation = handle.generation.load(Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let mut process_sampler = ProcessSampler::new();
        let mut runtime_sampler = RuntimeSampler::new();
        process_sampler.prime();
        let _ = runtime_sampler.sample(&tokio::runtime::Handle::current().metrics());
        let mut last_tick = Instant::now();
        let mut last_interval = handle.interval();
        loop {
            if !handle.running.load(Ordering::SeqCst)
                || handle.generation.load(Ordering::SeqCst) != generation
            {
                break;
            }
            let interval = handle.interval();
            tokio::time::sleep(Duration::from_millis(interval)).await;
            if !handle.running.load(Ordering::SeqCst)
                || handle.generation.load(Ordering::SeqCst) != generation
            {
                break;
            }
            if handle
                .snapshot(None, None, super::now_ms())
                .is_ok_and(|snapshot| snapshot.leases.is_empty())
            {
                handle.running.store(false, Ordering::SeqCst);
                break;
            }

            let Some(host_port) = handle.host_port.lock().clone() else {
                handle.running.store(false, Ordering::SeqCst);
                break;
            };
            let collection_started = Instant::now();
            let actual_elapsed = collection_started.duration_since(last_tick);
            last_tick = collection_started;
            let cadence_changed = interval != last_interval;
            if cadence_changed {
                process_sampler = ProcessSampler::new();
                runtime_sampler = RuntimeSampler::new();
                process_sampler.prime();
                let _ = runtime_sampler.sample(&tokio::runtime::Handle::current().metrics());
                last_interval = interval;
            }
            let actual_ms = actual_elapsed.as_millis().min(u128::from(u64::MAX)) as u64;
            let processes = process_sampler.sample(actual_elapsed.as_secs_f64());
            let runtime = runtime_sampler.sample(&tokio::runtime::Handle::current().metrics());
            let top_spans = REGISTRY.snapshot();
            let system_memory = Some(process_sampler.sample_system_memory());
            let managed = host_port.collect_managed().await;
            let wall_end_ms = super::now_ms();
            let collection_duration_ms = collection_started
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64;
            let (target_id, routing_generation, sampling_session_id) = handle.frame_scope();
            let sequence = handle.sequence.fetch_add(1, Ordering::SeqCst) + 1;
            let frame = PerfFrame {
                wire_version: PERF_WIRE_VERSION,
                source_id: handle.source.source_id.clone(),
                target_id,
                routing_generation,
                host_instance_id: handle.source.host_instance_id.clone(),
                sampling_session_id,
                lease_id: None,
                sequence,
                requested_interval_ms: interval,
                actual_interval_ms: actual_ms,
                monotonic_elapsed_ms: actual_ms,
                wall_start_ms: wall_end_ms.saturating_sub(actual_ms as i64),
                wall_end_ms,
                collection_duration_ms,
                missed_ticks: actual_ms.saturating_div(interval).saturating_sub(1),
                flags: PerfFrameFlags {
                    reset: sequence == 1 || cadence_changed,
                    discontinuity: false,
                    counter_reset: cadence_changed,
                    source_restarted: sequence == 1,
                },
                ts_ms: wall_end_ms,
                interval_ms: actual_ms,
                processes,
                runtime,
                top_spans,
                system_memory,
                managed,
            };
            handle.push(frame.clone());
            let deliveries = handle.deliveries(&frame);
            host_port.emit(&frame, &deliveries);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(device: &str, purpose: PerfLeasePurpose, cadence: u64) -> PerfOpenLeaseRequest {
        PerfOpenLeaseRequest {
            client_id: format!("client-{device}"),
            device_id: device.to_string(),
            target_id: "target-a".to_string(),
            routing_generation: 7,
            purpose,
            requested_cadence_ms: cadence,
            source_id: None,
        }
    }

    #[test]
    fn admits_one_live_and_one_capture_per_device_and_arbitrates_fastest_cadence() {
        let handle = SamplerHandle::default();
        let live = handle.open(
            request("device-a", PerfLeasePurpose::Live, 1000),
            true,
            1000,
        );
        let capture = handle.open(
            request("device-a", PerfLeasePurpose::Capture, 500),
            true,
            1200,
        );
        assert!(live.accepted);
        assert!(capture.accepted);
        assert_eq!(handle.interval(), 500);
        let duplicate = handle.open(
            request("device-a", PerfLeasePurpose::Live, 1000),
            true,
            1400,
        );
        assert_eq!(duplicate.code.as_deref(), Some("device-purpose-limit"));
    }

    #[test]
    fn remote_cadence_has_a_500ms_floor_but_local_compatibility_keeps_250ms() {
        let handle = SamplerHandle::default();
        assert_eq!(
            handle
                .open(request("remote", PerfLeasePurpose::Live, 250), true, 1000)
                .code
                .as_deref(),
            Some("cadence-too-fast")
        );
        assert!(
            handle
                .open(request("local", PerfLeasePurpose::Live, 250), false, 1000)
                .accepted
        );
    }

    #[test]
    fn renew_extends_heartbeat_and_ttl_and_expiry_is_explicit() {
        let handle = SamplerHandle::default();
        let opened = handle.open(
            request("device-a", PerfLeasePurpose::Live, 1000),
            true,
            1000,
        );
        let lease_id = opened.lease.unwrap().lease_id;
        let renewed = handle.renew(&lease_id, Some("device-a"), 5000).unwrap();
        assert_eq!(renewed.heartbeat_at_ms, 5000);
        assert_eq!(renewed.expires_at_ms, 5000 + LEASE_TTL_MS);
        assert_eq!(
            handle.renew(&lease_id, Some("device-a"), 5050),
            Err("rate-limited".to_string())
        );
        assert_eq!(
            handle.renew(&lease_id, Some("device-a"), 5000 + LEASE_TTL_MS),
            Err("lease-expired".to_string())
        );
    }

    #[test]
    fn close_releases_immediately_and_ring_is_bounded() {
        let handle = SamplerHandle::default();
        let opened = handle.open(
            request("device-a", PerfLeasePurpose::Live, 1000),
            true,
            1000,
        );
        let lease_id = opened.lease.unwrap().lease_id;
        assert!(handle.close(&lease_id, Some("device-a")).unwrap());
        assert_eq!(handle.leases(), 0);
    }

    #[test]
    fn lease_operations_reject_another_authenticated_device() {
        let handle = SamplerHandle::default();
        let opened = handle.open(
            request("device-a", PerfLeasePurpose::Live, 1000),
            true,
            1000,
        );
        let lease_id = opened.lease.unwrap().lease_id;
        assert_eq!(
            handle.renew(&lease_id, Some("device-b"), 2000),
            Err("permission-denied".to_string())
        );
        assert_eq!(
            handle
                .snapshot(Some(&lease_id), Some("device-b"), 2000)
                .unwrap_err(),
            "permission-denied"
        );
        assert_eq!(
            handle.close(&lease_id, Some("device-b")),
            Err("permission-denied".to_string())
        );
        assert_eq!(handle.leases(), 1);
    }

    #[test]
    fn enforces_the_host_lease_limit() {
        let handle = SamplerHandle::default();
        for index in 0..MAX_HOST_LEASES {
            assert!(
                handle
                    .open(
                        request(&format!("device-{index}"), PerfLeasePurpose::Live, 1000),
                        true,
                        1000 + index as i64 * 200,
                    )
                    .accepted
            );
        }
        assert_eq!(
            handle
                .open(
                    request("overflow", PerfLeasePurpose::Live, 1000),
                    true,
                    10_000
                )
                .code
                .as_deref(),
            Some("host-lease-limit")
        );
    }
}
