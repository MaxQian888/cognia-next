//! Durable port blocks, scoped to the network namespace of the executor.
//! Probes are advisory: the ledger excludes other leases in this database,
//! not unrelated processes or another Cognia data directory after the bind closes.

use crate::{WorkspaceLifecyclePolicy, WorkspaceRecord, WorkspaceState};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

pub const HOST_LOOPBACK_NAMESPACE: &str = "host-loopback";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PortSubjectKind {
    Registry,
    DesktopSession,
    ProjectRoot,
}

/// Public subject commands cannot bypass registry lifecycle guards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalPortSubjectKind {
    DesktopSession,
    ProjectRoot,
}

impl From<ExternalPortSubjectKind> for PortSubjectKind {
    fn from(kind: ExternalPortSubjectKind) -> Self {
        match kind {
            ExternalPortSubjectKind::DesktopSession => Self::DesktopSession,
            ExternalPortSubjectKind::ProjectRoot => Self::ProjectRoot,
        }
    }
}

impl PortSubjectKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Registry => "registry",
            Self::DesktopSession => "desktop-session",
            Self::ProjectRoot => "project-root",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct WorkspacePortLease {
    pub lease_id: String,
    pub namespace_key: String,
    pub subject_kind: PortSubjectKind,
    pub subject_key: String,
    pub canonical_root: String,
    pub registry_workspace_id: Option<String>,
    pub base_port: u32,
    pub port_count: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PortLeaseError {
    #[error("invalid port allocation policy: {0}")]
    InvalidPolicy(String),
    #[error("no available port block: adjust portRangeStart ({start}), portRangeEnd ({end}), or portBlockSize ({block_size})")]
    Exhausted {
        start: u32,
        end: u32,
        block_size: u32,
    },
    #[error("port lease store: {0}")]
    Store(String),
    #[error("port lease root: {0}")]
    Root(String),
    #[error("workspace {0} not found")]
    WorkspaceNotFound(String),
    #[error("workspace {workspace_id} in state {state:?} cannot release its port lease")]
    WorkspaceBusy {
        workspace_id: String,
        state: WorkspaceState,
    },
    #[error("port lease {lease_id} is occupied on ports {ports:?}")]
    Occupied { lease_id: String, ports: Vec<u32> },
    #[error("cannot probe ports in network namespace {0} from this host")]
    ProbeUnavailable(String),
    #[error("probe port {port}: {message}")]
    Probe { port: u32, message: String },
    #[error("invalid port lease subject: {0}")]
    InvalidSubject(String),
}
impl From<rusqlite::Error> for PortLeaseError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Store(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PortLeaseDiagnosticKind {
    DuplicateRoot,
    Overlap,
    OutOfRange,
    AmbiguousRegistryLink,
    UnresolvedRegistryRoot,
    RegistryRootMismatch,
    MissingRoot,
    DiscoveryRejected,
    DiscoveryFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct PortLeaseDiagnostic {
    pub kind: PortLeaseDiagnosticKind,
    pub lease_ids: Vec<String>,
    pub detail: String,
}

/// Every owner of a physical-root lease, including aliases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct PortLeaseSubject {
    pub kind: PortSubjectKind,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct WorkspacePortLeaseStatus {
    pub lease: WorkspacePortLease,
    pub subjects: Vec<PortLeaseSubject>,
    /// None when the host cannot inspect this network namespace.
    pub occupied_ports: Option<Vec<u32>>,
    pub occupancy_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct WorkspacePortLeaseList {
    pub leases: Vec<WorkspacePortLeaseStatus>,
    pub diagnostics: Vec<PortLeaseDiagnostic>,
}

pub fn port_lease_env(lease: &WorkspacePortLease) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("COGNIA_PORT".into(), lease.base_port.to_string()),
        ("COGNIA_PORT_COUNT".into(), lease.port_count.to_string()),
        ("PORT".into(), lease.base_port.to_string()),
    ])
}

fn ipv6_unavailable(error: &io::Error) -> bool {
    if matches!(
        error.kind(),
        io::ErrorKind::AddrNotAvailable | io::ErrorKind::Unsupported
    ) {
        return true;
    }
    #[cfg(unix)]
    if matches!(
        error.raw_os_error(),
        Some(libc::EAFNOSUPPORT | libc::EPROTONOSUPPORT)
    ) {
        return true;
    }
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(10047 | 10043)) {
        return true;
    }
    false
}

fn bind_probe_socket(address: SocketAddr) -> io::Result<socket2::Socket> {
    let socket = socket2::Socket::new(
        socket2::Domain::for_address(address),
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    )?;
    // std::TcpListener enables reuse on Unix, which can hide a wildcard
    // listener on macOS/BSD. socket2 leaves it off; make that contract explicit.
    // socket2 0.6 has no SO_EXCLUSIVEADDRUSE API on Windows: use plain bind.
    socket.set_reuse_address(false)?;
    if address.is_ipv6() {
        socket.set_only_v6(true)?;
    }
    socket.bind(&address.into())?;
    Ok(socket)
}

fn probe(port: u32) -> Result<bool, PortLeaseError> {
    #[cfg(test)]
    if let Some(occupied) = TEST_PORT_OCCUPANCY.with(std::cell::Cell::get) {
        return Ok(occupied);
    }
    let mut occupied = false;
    for ip in [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::UNSPECIFIED),
    ] {
        let address = SocketAddr::new(ip, port as u16);
        match bind_probe_socket(address) {
            // Drop before the wildcard check so our own socket cannot occupy it.
            Ok(socket) => drop(socket),
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => occupied = true,
            Err(error) if address.is_ipv6() && ipv6_unavailable(&error) => {}
            Err(error) => {
                return Err(PortLeaseError::Probe {
                    port,
                    message: error.to_string(),
                })
            }
        }
    }
    Ok(occupied)
}

// Ledger/integration tests need real Git and SQLite but no network listeners.
// The override is opt-in, thread-local, nested, and absent from production.
#[cfg(test)]
thread_local! {
    static TEST_PORT_OCCUPANCY: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(crate) struct TestPortProbeGuard {
    previous: Option<bool>,
    _thread_bound: std::marker::PhantomData<std::rc::Rc<()>>,
}
#[cfg(test)]
impl TestPortProbeGuard {
    pub(crate) fn vacant() -> Self {
        Self {
            previous: TEST_PORT_OCCUPANCY.with(|state| state.replace(Some(false))),
            _thread_bound: std::marker::PhantomData,
        }
    }
}
#[cfg(test)]
impl Drop for TestPortProbeGuard {
    fn drop(&mut self) {
        TEST_PORT_OCCUPANCY.with(|state| state.set(self.previous));
    }
}

// Host-probe fixtures never overlap the default range used by ordinary
// workspace lifecycle tests, or another probe fixture running in parallel.
#[cfg(test)]
pub(crate) fn isolated_host_policy() -> WorkspaceLifecyclePolicy {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT_START: AtomicU32 = AtomicU32::new(20000);
    let start = NEXT_START.fetch_add(64, Ordering::Relaxed);
    assert!(start + 63 < 40000, "host port test ranges exhausted");
    WorkspaceLifecyclePolicy {
        port_range_start: start,
        port_range_end: start + 63,
        ..Default::default()
    }
}

// macOS sets FD_CLOEXEC after socket(), so a child forked by a parallel test
// in that window inherits the socket and holds the port until it exits.
// Host-probe fixtures retry for a bounded time instead of asserting at once.
#[cfg(test)]
pub(crate) fn eventually<T>(mut attempt: impl FnMut() -> Option<T>) -> T {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if let Some(value) = attempt() {
            return value;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "host port fixture did not settle within 10s"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Report-only. A bound port may belong to this very workspace; never kill or renumber it.
pub fn occupied_ports(lease: &WorkspacePortLease) -> Result<Vec<u32>, PortLeaseError> {
    occupied_ports_with(lease, &mut probe)
}

fn occupied_ports_with(
    lease: &WorkspacePortLease,
    probe: &mut impl FnMut(u32) -> Result<bool, PortLeaseError>,
) -> Result<Vec<u32>, PortLeaseError> {
    if lease.namespace_key != HOST_LOOPBACK_NAMESPACE {
        return Err(PortLeaseError::ProbeUnavailable(
            lease.namespace_key.clone(),
        ));
    }
    (lease.base_port..lease.base_port + lease.port_count)
        .filter_map(|port| match probe(port) {
            Ok(true) => Some(Ok(port)),
            Ok(false) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

const OCCUPANCY_SETTLE_LIMIT: Duration = Duration::from_millis(500);
const OCCUPANCY_SETTLE_INTERVAL: Duration = Duration::from_millis(20);

// A concurrently forked child can briefly inherit a just-closed probe socket.
// Only exhausted allocation and idle release wait; ordinary allocation stays fast.
fn settle_occupancy<'a, T>(
    candidates: &'a [T],
    available: impl FnMut(&T) -> Result<bool, PortLeaseError>,
) -> Result<Option<&'a T>, PortLeaseError> {
    let start = Instant::now();
    settle_occupancy_with_clock(
        candidates,
        available,
        || start.elapsed(),
        std::thread::sleep,
    )
}

fn settle_occupancy_with_clock<'a, T>(
    candidates: &'a [T],
    mut available: impl FnMut(&T) -> Result<bool, PortLeaseError>,
    mut elapsed: impl FnMut() -> Duration,
    mut sleep: impl FnMut(Duration),
) -> Result<Option<&'a T>, PortLeaseError> {
    if candidates.is_empty() {
        return Ok(None);
    }
    loop {
        for candidate in candidates {
            if elapsed() >= OCCUPANCY_SETTLE_LIMIT {
                return Ok(None);
            }
            if available(candidate)? {
                return Ok(Some(candidate));
            }
        }
        let remaining = OCCUPANCY_SETTLE_LIMIT.saturating_sub(elapsed());
        if remaining.is_zero() {
            return Ok(None);
        }
        sleep(OCCUPANCY_SETTLE_INTERVAL.min(remaining));
    }
}

pub(crate) fn require_idle(lease: &WorkspacePortLease) -> Result<(), PortLeaseError> {
    require_idle_with(lease, &mut probe)
}

fn require_idle_with(
    lease: &WorkspacePortLease,
    probe: &mut impl FnMut(u32) -> Result<bool, PortLeaseError>,
) -> Result<(), PortLeaseError> {
    let mut ports = occupied_ports_with(lease, probe)?;
    if ports.is_empty() {
        return Ok(());
    }
    if settle_occupancy(&[()], |_| {
        ports = occupied_ports_with(lease, probe)?;
        Ok(ports.is_empty())
    })?
    .is_some()
    {
        return Ok(());
    }
    Err(PortLeaseError::Occupied {
        lease_id: lease.lease_id.clone(),
        ports,
    })
}

pub(crate) fn canonical_root(root: &Path) -> Result<String, PortLeaseError> {
    let path = std::fs::canonicalize(root)
        .map_err(|error| PortLeaseError::Root(format!("{}: {error}", root.display())))?;
    if !path.is_dir() {
        return Err(PortLeaseError::Root(format!(
            "{} is not a directory",
            path.display()
        )));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Registry roots may not exist yet (reservation) or may be archived/offline.
/// Resolve their existing physical ancestor, retaining only normal missing
/// components. Arbitrary execution cwd inputs must use strict canonicalize.
pub(crate) fn registry_root(root: &Path) -> Result<String, PortLeaseError> {
    let mut ancestor = root;
    let mut missing = Vec::new();
    loop {
        match std::fs::canonicalize(ancestor) {
            Ok(mut path) => {
                for part in missing.iter().rev() {
                    path.push(part);
                }
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match ancestor.components().next_back() {
                    Some(Component::Normal(part)) => missing.push(part.to_os_string()),
                    _ => {
                        return Err(PortLeaseError::Root(format!(
                            "invalid registry root {}",
                            root.display()
                        )))
                    }
                }
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| PortLeaseError::Root(root.display().to_string()))?;
            }
            Err(error) => return Err(PortLeaseError::Root(format!("{}: {error}", root.display()))),
        }
    }
}

/// Normalize a recorded root identity without inspecting its current filesystem.
/// Release must still work after removal, loss of access, or a symlink retarget.
pub(crate) fn normalize_project_root_path(root: &Path) -> Result<String, PortLeaseError> {
    if !root.is_absolute() {
        return Err(PortLeaseError::InvalidSubject(
            "project root must be absolute".into(),
        ));
    }
    let mut normalized = PathBuf::new();
    for component in root.components() {
        match component {
            #[cfg(windows)]
            Component::Prefix(prefix) => match prefix.kind() {
                std::path::Prefix::Disk(drive) | std::path::Prefix::VerbatimDisk(drive) => {
                    normalized.push(format!("{}:", char::from(drive).to_ascii_uppercase()));
                }
                std::path::Prefix::UNC(server, share)
                | std::path::Prefix::VerbatimUNC(server, share) => {
                    normalized.push(format!(
                        "\\\\{}\\{}",
                        server.to_string_lossy(),
                        share.to_string_lossy()
                    ));
                }
                _ => normalized.push(prefix.as_os_str()),
            },
            component if component.as_os_str() == "." => {}
            component if component.as_os_str() == ".." => {
                if !normalized.pop() {
                    return Err(PortLeaseError::InvalidSubject(
                        "project root escapes the filesystem root".into(),
                    ));
                }
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized.to_string_lossy().into_owned())
}

/// Record only a path known by discovery to name this checkout's root, never
/// an arbitrary cwd below it. Aliases are durable identity, not new owners.
pub(crate) fn record_project_root_alias(
    connection: &Connection,
    lease: &WorkspacePortLease,
    requested_root: &Path,
) -> Result<(), PortLeaseError> {
    let alias = normalize_project_root_path(requested_root)?;
    connection.execute(
        "INSERT OR IGNORE INTO workspace_port_root_aliases (namespace_key, alias_root, lease_id)
         SELECT namespace_key, ?2, lease_id FROM workspace_port_leases l
         WHERE lease_id=?1 AND EXISTS (SELECT 1 FROM workspace_port_subjects s
             WHERE s.lease_id=l.lease_id AND s.subject_kind='project-root'
             AND s.subject_key='root:' || l.canonical_root)",
        params![lease.lease_id, alias],
    )?;
    Ok(())
}

/// Release exact durable root identities. This deliberately does not discover
/// Git roots, canonicalize paths, or match ancestor/descendant directories.
pub(crate) fn release_project_root_reference_in_transaction(
    connection: &Connection,
    namespace: &str,
    root: &Path,
    lease_id: Option<&str>,
) -> Result<(), PortLeaseError> {
    let root = normalize_project_root_path(root)?;
    let matches: std::collections::BTreeSet<String> = {
        let mut statement = connection.prepare(
            "SELECT l.canonical_root, a.alias_root FROM workspace_port_leases l
             JOIN workspace_port_subjects s ON s.lease_id=l.lease_id
             LEFT JOIN workspace_port_root_aliases a
                 ON a.lease_id=l.lease_id AND a.namespace_key=l.namespace_key
             WHERE l.namespace_key=?1 AND (?2 IS NULL OR l.lease_id=?2)
             AND s.subject_kind='project-root' AND s.subject_key='root:' || l.canonical_root",
        )?;
        let rows = statement.query_map(params![namespace, lease_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        let mut matches = std::collections::BTreeSet::new();
        for row in rows {
            let (canonical, alias) = row?;
            if std::iter::once(canonical.as_str())
                .chain(alias.as_deref())
                .any(|recorded| {
                    normalize_project_root_path(Path::new(recorded))
                        .ok()
                        .as_deref()
                        == Some(root.as_str())
                })
            {
                // Release the exact persisted key, not its normalized spelling.
                matches.insert(canonical);
            }
        }
        matches
    };
    for root in matches {
        release_subject_reference_in_transaction(
            connection,
            Some(namespace),
            PortSubjectKind::ProjectRoot,
            &format!("root:{root}"),
            lease_id,
        )?;
    }
    Ok(())
}

fn map_lease(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspacePortLease> {
    let kind: String = row.get(2)?;
    let subject_kind = match kind.as_str() {
        "registry" => PortSubjectKind::Registry,
        "desktop-session" => PortSubjectKind::DesktopSession,
        "project-root" => PortSubjectKind::ProjectRoot,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(WorkspacePortLease {
        lease_id: row.get(0)?,
        namespace_key: row.get(1)?,
        subject_kind,
        subject_key: row.get(3)?,
        canonical_root: row.get(4)?,
        registry_workspace_id: row.get(5)?,
        base_port: row.get(6)?,
        port_count: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}
const COLUMNS: &str = "lease_id, namespace_key, subject_kind, subject_key, canonical_root, registry_workspace_id, base_port, port_count, created_at, updated_at";

pub(crate) fn list(connection: &Connection) -> Result<Vec<WorkspacePortLease>, PortLeaseError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM workspace_port_leases ORDER BY lease_id"
    ))?;
    let rows = statement.query_map([], map_lease)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
pub(crate) fn read_root(
    connection: &Connection,
    namespace: &str,
    root: &str,
) -> Result<Option<WorkspacePortLease>, PortLeaseError> {
    Ok(connection.query_row(&format!("SELECT {COLUMNS} FROM workspace_port_leases WHERE namespace_key=?1 AND canonical_root=?2"), params![namespace, root], map_lease).optional()?)
}
pub(crate) fn read_subject(
    connection: &Connection,
    namespace: &str,
    kind: PortSubjectKind,
    key: &str,
) -> Result<Vec<WorkspacePortLease>, PortLeaseError> {
    let mut statement = connection.prepare(&format!("SELECT {COLUMNS} FROM workspace_port_leases WHERE namespace_key=?1 AND lease_id IN (SELECT lease_id FROM workspace_port_subjects WHERE subject_kind=?2 AND subject_key=?3)"))?;
    let rows = statement.query_map(params![namespace, kind.as_str(), key], map_lease)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
pub(crate) fn read_registry(
    connection: &Connection,
    namespace: &str,
    record: &WorkspaceRecord,
) -> Result<Option<WorkspacePortLease>, PortLeaseError> {
    let released: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspace_port_released_subjects WHERE namespace_key=?1 AND subject_kind='registry' AND subject_key=?2)",
        params![namespace, record.workspace_id], |row| row.get(0))?;
    if released {
        return Ok(None);
    }
    if let Some(lease) = read_subject(
        connection,
        namespace,
        PortSubjectKind::Registry,
        &record.workspace_id,
    )?
    .into_iter()
    .next()
    {
        return Ok(Some(lease));
    }
    let root = registry_root(Path::new(&record.execution_root))
        .unwrap_or_else(|_| record.execution_root.clone());
    read_root(connection, namespace, &root)
}

pub(crate) struct LeaseSubject<'a> {
    pub kind: PortSubjectKind,
    pub key: &'a str,
    pub root: &'a str,
    pub registry_id: Option<&'a str>,
}

pub(crate) fn ensure(
    connection: &Connection,
    namespace: &str,
    subject: LeaseSubject<'_>,
    policy: WorkspaceLifecyclePolicy,
    now: i64,
) -> Result<WorkspacePortLease, PortLeaseError> {
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let lease = ensure_in_transaction(&tx, namespace, subject, policy, now)?;
    tx.commit()?;
    Ok(lease)
}

fn block_available(
    base: u32,
    count: u32,
    probe: &mut impl FnMut(u32) -> Result<bool, PortLeaseError>,
) -> Result<bool, PortLeaseError> {
    for port in base..base + count {
        if probe(port)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn find_available_block(
    connection: &Connection,
    namespace: &str,
    policy: WorkspaceLifecyclePolicy,
    probe: &mut impl FnMut(u32) -> Result<bool, PortLeaseError>,
) -> Result<u32, PortLeaseError> {
    policy.validate_ports()?;
    let mut candidate = policy.port_range_start;
    // Alignment is relative to portRangeStart: start + n * portBlockSize.
    // u32 arithmetic is bounded by validation, including the inclusive end.
    let last = policy.port_range_end - policy.port_block_size + 1;
    let mut occupied_candidates = Vec::new();
    while candidate <= last {
        let overlaps: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_port_leases WHERE namespace_key=?1 AND base_port < ?3 AND base_port + port_count > ?2)",
            params![namespace, candidate, candidate + policy.port_block_size], |row| row.get(0))?;
        if !overlaps {
            if namespace != HOST_LOOPBACK_NAMESPACE
                || block_available(candidate, policy.port_block_size, probe)?
            {
                return Ok(candidate);
            }
            occupied_candidates.push(candidate);
        }
        candidate += policy.port_block_size;
    }
    // The caller still holds BEGIN IMMEDIATE, so these non-overlapping blocks
    // cannot gain a lease while we allow transient host occupancy to settle.
    if let Some(base) = settle_occupancy(&occupied_candidates, |base| {
        block_available(*base, policy.port_block_size, probe)
    })? {
        return Ok(*base);
    }
    Err(PortLeaseError::Exhausted {
        start: policy.port_range_start,
        end: policy.port_range_end,
        block_size: policy.port_block_size,
    })
}

pub(crate) fn ensure_in_transaction(
    connection: &Connection,
    namespace: &str,
    subject: LeaseSubject<'_>,
    policy: WorkspaceLifecyclePolicy,
    now: i64,
) -> Result<WorkspacePortLease, PortLeaseError> {
    if namespace.trim().is_empty() || subject.key.trim().is_empty() {
        return Err(PortLeaseError::InvalidSubject(
            "namespace and subject key must not be empty".into(),
        ));
    }
    let mut lease = if let Some(existing) = read_root(connection, namespace, subject.root)? {
        existing
    } else {
        let base = find_available_block(connection, namespace, policy, &mut probe)?;
        let lease = WorkspacePortLease {
            lease_id: uuid::Uuid::now_v7().to_string(),
            namespace_key: namespace.into(),
            subject_kind: subject.kind,
            subject_key: subject.key.into(),
            canonical_root: subject.root.into(),
            registry_workspace_id: subject.registry_id.map(str::to_owned),
            base_port: base,
            port_count: policy.port_block_size,
            created_at: now,
            updated_at: now,
        };
        connection.execute("INSERT INTO workspace_port_leases (lease_id, namespace_key, subject_kind, subject_key, canonical_root, registry_workspace_id, base_port, port_count, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)", params![lease.lease_id, namespace, subject.kind.as_str(), subject.key, subject.root, subject.registry_id, base, policy.port_block_size, now])?;
        lease
    };
    connection.execute("INSERT OR IGNORE INTO workspace_port_subjects (lease_id, subject_kind, subject_key) VALUES (?1,?2,?3)", params![lease.lease_id, subject.kind.as_str(), subject.key])?;
    if lease.registry_workspace_id.is_none() && subject.registry_id.is_some() {
        connection.execute("UPDATE workspace_port_leases SET registry_workspace_id=?2, updated_at=?3 WHERE lease_id=?1", params![lease.lease_id, subject.registry_id, now])?;
        lease.registry_workspace_id = subject.registry_id.map(str::to_owned);
        lease.updated_at = now;
    }
    // Explicit ensure is the only operation that revokes an explicit release.
    connection.execute("DELETE FROM workspace_port_released_subjects WHERE namespace_key=?1 AND subject_kind=?2 AND subject_key=?3", params![namespace, subject.kind.as_str(), subject.key])?;
    Ok(lease)
}

/// Remove one reference, releasing only unreferenced blocks. Must be called in
/// the caller's write transaction, including registry deletion/rollback.
pub(crate) fn release_subject_in_transaction(
    connection: &Connection,
    namespace: Option<&str>,
    kind: PortSubjectKind,
    key: &str,
) -> Result<(), PortLeaseError> {
    release_subject_reference_in_transaction(connection, namespace, kind, key, None)
}

pub(crate) fn release_subject_reference_in_transaction(
    connection: &Connection,
    namespace: Option<&str>,
    kind: PortSubjectKind,
    key: &str,
    lease_id: Option<&str>,
) -> Result<(), PortLeaseError> {
    if let Some(namespace) = namespace.filter(|_| lease_id.is_none()) {
        // No FK to the block: this decision survives its final owner's release.
        // Namespace-less calls remove the registry row itself, not an idle lease.
        connection.execute("INSERT OR IGNORE INTO workspace_port_released_subjects (namespace_key, subject_kind, subject_key) VALUES (?1,?2,?3)", params![namespace, kind.as_str(), key])?;
    }
    let ids: Vec<String> = {
        let mut statement = connection.prepare("SELECT lease_id FROM workspace_port_subjects WHERE subject_kind=?1 AND subject_key=?2 AND (?4 IS NULL OR lease_id=?4) AND lease_id IN (SELECT lease_id FROM workspace_port_leases WHERE ?3 IS NULL OR namespace_key=?3)")?;
        let rows = statement.query_map(
            params![kind.as_str(), key, namespace, lease_id],
            |row| row.get(0),
        )?;
        rows.collect::<Result<_, _>>()?
    };
    for id in ids {
        connection.execute("DELETE FROM workspace_port_subjects WHERE lease_id=?1 AND subject_kind=?2 AND subject_key=?3", params![id, kind.as_str(), key])?;
        let next: Option<(String, String)> = connection.query_row("SELECT subject_kind, subject_key FROM workspace_port_subjects WHERE lease_id=?1 ORDER BY subject_kind, subject_key LIMIT 1", [&id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        if let Some((next_kind, next_key)) = next {
            connection.execute("UPDATE workspace_port_leases SET subject_kind=?2, subject_key=?3, registry_workspace_id=(SELECT s.subject_key FROM workspace_port_subjects s JOIN workspace_registry r ON r.workspace_id=s.subject_key WHERE s.lease_id=?1 AND s.subject_kind='registry' ORDER BY s.subject_key LIMIT 1), updated_at=?4 WHERE lease_id=?1", params![id, next_kind, next_key, crate::service::now_ms()])?;
        } else {
            connection.execute("DELETE FROM workspace_port_leases WHERE lease_id=?1", [&id])?;
        }
    }
    Ok(())
}

pub(crate) fn resolve_registry<'a>(
    records: &'a [WorkspaceRecord],
    cwd: &Path,
) -> Option<&'a WorkspaceRecord> {
    records
        .iter()
        .filter_map(|record| {
            let root = std::fs::canonicalize(&record.execution_root).ok()?;
            cwd.starts_with(&root)
                .then_some((root.components().count(), record))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, record)| record)
}

pub(crate) fn external_leases(
    connection: &Connection,
    namespace: &str,
) -> Result<Vec<WorkspacePortLease>, PortLeaseError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM workspace_port_leases WHERE namespace_key=?1 AND lease_id IN
         (SELECT lease_id FROM workspace_port_subjects WHERE subject_kind IN ('desktop-session','project-root'))"
    ))?;
    let rows = statement.query_map([namespace], map_lease)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub(crate) fn resolve_external(
    leases: &[WorkspacePortLease],
    namespace: &str,
    cwd: &Path,
) -> Option<WorkspacePortLease> {
    leases
        .iter()
        .filter(|lease| lease.namespace_key == namespace)
        .filter_map(|lease| {
            let root = PathBuf::from(&lease.canonical_root);
            cwd.starts_with(&root)
                .then_some((root.components().count(), lease))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, lease)| lease.clone())
}

pub(crate) fn reconcile(
    store: &crate::store::WorkspaceStore,
) -> Result<Vec<PortLeaseDiagnostic>, PortLeaseError> {
    // The registry snapshot and reference repair share the write lock.
    let tx = Transaction::new_unchecked(&store.connection, TransactionBehavior::Immediate)?;
    let diagnostics = inspect(store, &tx, true)?;
    tx.commit()?;
    Ok(diagnostics)
}

/// Read a consistent ledger snapshot. Occupancy is advisory and never repairs links.
pub(crate) fn list_status(
    store: &crate::store::WorkspaceStore,
) -> Result<WorkspacePortLeaseList, PortLeaseError> {
    list_status_with(store, &mut occupied_ports)
}

fn list_status_with(
    store: &crate::store::WorkspaceStore,
    probe: &mut impl FnMut(&WorkspacePortLease) -> Result<Vec<u32>, PortLeaseError>,
) -> Result<WorkspacePortLeaseList, PortLeaseError> {
    let tx = Transaction::new_unchecked(&store.connection, TransactionBehavior::Deferred)?;
    let diagnostics = inspect(store, &tx, false)?;
    let mut leases = Vec::new();
    for lease in list(&tx)? {
        let mut statement = tx.prepare("SELECT subject_kind, subject_key FROM workspace_port_subjects WHERE lease_id=?1 ORDER BY subject_kind, subject_key")?;
        let subjects = statement
            .query_map([&lease.lease_id], |row| {
                let kind: String = row.get(0)?;
                let kind = match kind.as_str() {
                    "registry" => PortSubjectKind::Registry,
                    "desktop-session" => PortSubjectKind::DesktopSession,
                    "project-root" => PortSubjectKind::ProjectRoot,
                    _ => return Err(rusqlite::Error::InvalidQuery),
                };
                Ok(PortLeaseSubject {
                    kind,
                    key: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let (occupied_ports, occupancy_error) = if lease.namespace_key == HOST_LOOPBACK_NAMESPACE {
            match probe(&lease) {
                Ok(ports) => (Some(ports), None),
                Err(error) => (None, Some(error.to_string())),
            }
        } else {
            (None, None)
        };
        leases.push(WorkspacePortLeaseStatus {
            lease,
            subjects,
            occupied_ports,
            occupancy_error,
        });
    }
    tx.commit()?;
    Ok(WorkspacePortLeaseList {
        leases,
        diagnostics,
    })
}

fn inspect(
    store: &crate::store::WorkspaceStore,
    tx: &Transaction<'_>,
    repair: bool,
) -> Result<Vec<PortLeaseDiagnostic>, PortLeaseError> {
    let records = store.list_workspaces().map_err(PortLeaseError::Store)?;
    let policy = store
        .get_workspace_lifecycle_policy()
        .map_err(PortLeaseError::Store)?
        .unwrap_or_default();
    let leases = list(&tx)?;
    let mut diagnostics = Vec::new();
    for (index, lease) in leases.iter().enumerate() {
        let missing = match std::fs::metadata(&lease.canonical_root) {
            Ok(metadata) => !metadata.is_dir(),
            Err(error) => error.kind() == io::ErrorKind::NotFound,
        };
        if missing {
            diagnostics.push(PortLeaseDiagnostic {
                kind: PortLeaseDiagnosticKind::MissingRoot,
                lease_ids: vec![lease.lease_id.clone()],
                detail: format!(
                    "leased root {} is missing; lease retained until explicit release",
                    lease.canonical_root
                ),
            });
        }
        let root = registry_root(Path::new(&lease.canonical_root))
            .unwrap_or_else(|_| lease.canonical_root.clone());
        let persisted: Vec<String> = {
            let mut statement = tx.prepare("SELECT subject_key FROM workspace_port_subjects WHERE lease_id=?1 AND subject_kind='registry'")?;
            let rows = statement.query_map([&lease.lease_id], |row| row.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let released: Vec<String> = {
            let mut statement = tx.prepare("SELECT subject_key FROM workspace_port_released_subjects WHERE namespace_key=?1 AND subject_kind='registry'")?;
            let rows = statement.query_map([&lease.namespace_key], |row| row.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        // A durable subject reference is authoritative until explicit release.
        // An offline mount or symlink must not erase an extant owner's reference.
        for record in records
            .iter()
            .filter(|record| persisted.contains(&record.workspace_id))
        {
            let diagnostic = match std::fs::canonicalize(&record.execution_root) {
                Err(error) => Some((
                    PortLeaseDiagnosticKind::UnresolvedRegistryRoot,
                    format!(
                        "workspace {} root is unavailable; reference retained: {error}",
                        record.workspace_id
                    ),
                )),
                Ok(path) if path != Path::new(&root) => Some((
                    PortLeaseDiagnosticKind::RegistryRootMismatch,
                    format!(
                        "workspace {} root differs from its leased root; reference retained",
                        record.workspace_id
                    ),
                )),
                Ok(_) => None,
            };
            if let Some((kind, detail)) = diagnostic {
                diagnostics.push(PortLeaseDiagnostic {
                    kind,
                    lease_ids: vec![lease.lease_id.clone()],
                    detail,
                });
            }
        }
        let matches: Vec<_> = records
            .iter()
            .filter(|record| !released.contains(&record.workspace_id))
            .filter(|record| {
                persisted.contains(&record.workspace_id)
                    || registry_root(Path::new(&record.execution_root))
                        .ok()
                        .as_deref()
                        == Some(&root)
            })
            .collect();
        if matches.len() > 1 {
            diagnostics.push(PortLeaseDiagnostic {
                kind: PortLeaseDiagnosticKind::AmbiguousRegistryLink,
                lease_ids: vec![lease.lease_id.clone()],
                detail: format!("multiple registry rows share {root}"),
            });
        }
        // Preserve a valid link, otherwise choose the stable first identity.
        // All matching aliases remain references, so deleting one cannot free peers.
        let selected = matches
            .iter()
            .find(|record| Some(&record.workspace_id) == lease.registry_workspace_id.as_ref())
            .copied()
            .or_else(|| {
                matches
                    .iter()
                    .min_by_key(|record| &record.workspace_id)
                    .copied()
            });
        if repair {
            if let Some(record) = selected {
                tx.execute("UPDATE workspace_port_leases SET registry_workspace_id=?2, subject_key=CASE WHEN subject_kind='registry' THEN ?2 ELSE subject_key END WHERE lease_id=?1", params![lease.lease_id, record.workspace_id])?;
                tx.execute(
                    "DELETE FROM workspace_port_subjects WHERE lease_id=?1 AND subject_kind='registry' AND subject_key NOT IN (SELECT workspace_id FROM workspace_registry)",
                    [&lease.lease_id],
                )?;
                for record in &matches {
                    tx.execute("INSERT OR IGNORE INTO workspace_port_subjects (lease_id,subject_kind,subject_key) VALUES (?1,'registry',?2)", params![lease.lease_id, record.workspace_id])?;
                }
            } else if lease.registry_workspace_id.is_some() {
                tx.execute(
                    "UPDATE workspace_port_leases SET registry_workspace_id=NULL WHERE lease_id=?1",
                    [&lease.lease_id],
                )?;
            }
        }
        if lease.base_port < policy.port_range_start
            || lease.base_port + lease.port_count - 1 > policy.port_range_end
        {
            diagnostics.push(PortLeaseDiagnostic {
                kind: PortLeaseDiagnosticKind::OutOfRange,
                lease_ids: vec![lease.lease_id.clone()],
                detail: "lease is outside current portRangeStart/portRangeEnd; numbers retained"
                    .into(),
            });
        }
        for other in &leases[..index] {
            if other.namespace_key != lease.namespace_key {
                continue;
            }
            let other_root = registry_root(Path::new(&other.canonical_root))
                .unwrap_or_else(|_| other.canonical_root.clone());
            for (condition, kind, detail) in [
                (
                    root == other_root,
                    PortLeaseDiagnosticKind::DuplicateRoot,
                    "duplicate physical root",
                ),
                (
                    lease.base_port < other.base_port + other.port_count
                        && other.base_port < lease.base_port + lease.port_count,
                    PortLeaseDiagnosticKind::Overlap,
                    "overlapping port blocks",
                ),
            ] {
                if condition {
                    diagnostics.push(PortLeaseDiagnostic {
                        kind,
                        lease_ids: vec![other.lease_id.clone(), lease.lease_id.clone()],
                        detail: detail.into(),
                    });
                }
            }
        }
    }
    Ok(diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::WorkspaceStore;
    use std::net::TcpListener;
    use tempfile::TempDir;

    fn allocate(
        store: &WorkspaceStore,
        namespace: &str,
        root: &str,
        policy: WorkspaceLifecyclePolicy,
    ) -> Result<WorkspacePortLease, PortLeaseError> {
        ensure(
            &store.connection,
            namespace,
            LeaseSubject {
                kind: PortSubjectKind::ProjectRoot,
                key: root,
                root,
                registry_id: None,
            },
            policy,
            1,
        )
    }

    fn allocate_project_root(
        store: &WorkspaceStore,
        namespace: &str,
        root: &str,
    ) -> WorkspacePortLease {
        ensure(
            &store.connection,
            namespace,
            LeaseSubject {
                kind: PortSubjectKind::ProjectRoot,
                key: &format!("root:{root}"),
                root,
                registry_id: None,
            },
            Default::default(),
            1,
        )
        .unwrap()
    }

    #[test]
    fn port_root_release_is_lexical_exact_and_preserves_other_owners_and_namespaces() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("never-created");
        let child = root.join("child");
        let root = root.to_str().unwrap();
        let child = child.to_str().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let parent = allocate_project_root(&store, "remote:exact", root);
        let child = allocate_project_root(&store, "remote:exact", child);
        let other_namespace = allocate_project_root(&store, "remote:other", root);
        ensure(
            &store.connection,
            "remote:exact",
            LeaseSubject {
                kind: PortSubjectKind::ProjectRoot,
                key: "project-id",
                root,
                registry_id: None,
            },
            Default::default(),
            1,
        )
        .unwrap();
        let tx =
            Transaction::new_unchecked(&store.connection, TransactionBehavior::Immediate).unwrap();
        release_project_root_reference_in_transaction(
            &tx,
            "remote:exact",
            &Path::new(root).join("./unused/../"),
            None,
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(read_subject(
            &store.connection,
            "remote:exact",
            PortSubjectKind::ProjectRoot,
            &format!("root:{root}")
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            read_subject(
                &store.connection,
                "remote:exact",
                PortSubjectKind::ProjectRoot,
                "project-id"
            )
            .unwrap()[0]
                .lease_id,
            parent.lease_id
        );
        let remaining = list(&store.connection).unwrap();
        assert_eq!(remaining.len(), 3);
        assert!(remaining
            .iter()
            .any(|lease| lease.lease_id == child.lease_id));
        assert!(remaining
            .iter()
            .any(|lease| lease.lease_id == other_namespace.lease_id));
        assert!(normalize_project_root_path(Path::new("relative")).is_err());
    }

    #[test]
    fn port_root_alias_survives_reopen_and_releases_only_the_recorded_root() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("offline-root");
        let alias = dir.path().join("offline-alias");
        let other = dir.path().join("other-root");
        let (lease, other) = {
            let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
            let lease = allocate_project_root(&store, "remote:alias", root.to_str().unwrap());
            let other = allocate_project_root(&store, "remote:alias", other.to_str().unwrap());
            record_project_root_alias(&store.connection, &lease, &alias).unwrap();
            (lease, other)
        };
        // The original alias can now point elsewhere. Release still follows
        // its durable mapping, without accessing either current directory.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&other.canonical_root, &alias).unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let tx =
            Transaction::new_unchecked(&store.connection, TransactionBehavior::Immediate).unwrap();
        release_project_root_reference_in_transaction(
            &tx,
            "remote:alias",
            &alias,
            Some(&other.lease_id),
        )
        .unwrap();
        assert_eq!(list(&tx).unwrap().len(), 2, "lease selection must be exact");
        release_project_root_reference_in_transaction(&tx, "remote:alias", &alias, None).unwrap();
        tx.commit().unwrap();
        assert_eq!(list(&store.connection).unwrap(), vec![other]);
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT count(*) FROM workspace_port_root_aliases WHERE lease_id=?1",
                    [lease.lease_id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn port_root_release_normalizes_persisted_roots_and_retains_the_original_subject_key() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let raw_root = format!("{}//./checkout/unused/../", dir.path().display());
        let requested = dir.path().join("checkout");
        let lease = allocate_project_root(&store, "remote:normalized", &raw_root);
        let other = allocate_project_root(
            &store,
            "remote:normalized",
            requested.join("child").to_str().unwrap(),
        );
        let tx =
            Transaction::new_unchecked(&store.connection, TransactionBehavior::Immediate).unwrap();
        release_project_root_reference_in_transaction(&tx, "remote:normalized", &requested, None)
            .unwrap();
        tx.commit().unwrap();
        assert_eq!(list(&store.connection).unwrap(), [other]);
        assert!(read_subject(
            &store.connection,
            "remote:normalized",
            PortSubjectKind::ProjectRoot,
            &lease.subject_key
        )
        .unwrap()
        .is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn port_root_release_normalizes_verbatim_disk_and_unc_prefixes() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        for (recorded, requested) in [
            (r"\\?\c:\workspace\.\repo", r"C:\workspace\repo"),
            (
                r"\\?\UNC\server\share\workspace\repo",
                r"\\server\share\workspace\repo",
            ),
        ] {
            assert_eq!(
                normalize_project_root_path(Path::new(recorded)).unwrap(),
                normalize_project_root_path(Path::new(requested)).unwrap()
            );
            allocate_project_root(&store, "remote:windows", recorded);
            let tx = Transaction::new_unchecked(&store.connection, TransactionBehavior::Immediate)
                .unwrap();
            release_project_root_reference_in_transaction(
                &tx,
                "remote:windows",
                Path::new(requested),
                None,
            )
            .unwrap();
            tx.commit().unwrap();
            assert!(list(&store.connection).unwrap().is_empty());
        }
    }

    #[test]
    fn port_missing_root_diagnostic_never_reclaims_the_lease() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("checkout");
        std::fs::create_dir(&root).unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let lease = allocate_project_root(&store, "remote:missing", root.to_str().unwrap());
        assert!(list_status(&store).unwrap().diagnostics.is_empty());
        std::fs::remove_dir(&root).unwrap();
        for diagnostics in [
            list_status(&store).unwrap().diagnostics,
            reconcile(&store).unwrap(),
        ] {
            let missing: Vec<_> = diagnostics
                .iter()
                .filter(|entry| entry.kind == PortLeaseDiagnosticKind::MissingRoot)
                .collect();
            assert_eq!(missing.len(), 1);
            assert_eq!(missing[0].lease_ids, [lease.lease_id.clone()]);
        }
        assert_eq!(list(&store.connection).unwrap(), [lease]);
    }

    #[test]
    fn port_targeted_release_does_not_tombstone_remaining_subject_roots() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let old = allocate(&store, "remote:targeted", "/old", Default::default()).unwrap();
        let new = ensure(
            &store.connection,
            "remote:targeted",
            LeaseSubject {
                kind: PortSubjectKind::ProjectRoot,
                key: "/old",
                root: "/new",
                registry_id: None,
            },
            Default::default(),
            2,
        )
        .unwrap();
        let tx = Transaction::new_unchecked(&store.connection, TransactionBehavior::Immediate).unwrap();
        release_subject_reference_in_transaction(
            &tx,
            Some("remote:targeted"),
            PortSubjectKind::ProjectRoot,
            "/old",
            Some(&old.lease_id),
        )
        .unwrap();
        tx.commit().unwrap();
        assert_eq!(
            read_subject(
                &store.connection,
                "remote:targeted",
                PortSubjectKind::ProjectRoot,
                "/old"
            )
            .unwrap(),
            vec![new]
        );
        let count: u64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM workspace_port_released_subjects",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn port_list_reports_subjects_and_diagnostics_without_mutation_or_remote_probes() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let lease = allocate(&store, "remote:list", "/a", Default::default()).unwrap();
        store.connection.execute("INSERT INTO workspace_port_subjects (lease_id,subject_kind,subject_key) VALUES (?1,'desktop-session','session')", [&lease.lease_id]).unwrap();
        store.connection.execute("UPDATE workspace_port_leases SET base_port=1024 WHERE lease_id=?1", [&lease.lease_id]).unwrap();
        let before = list(&store.connection).unwrap();
        store.connection.execute_batch("PRAGMA query_only=ON").unwrap();
        let report = list_status_with(&store, &mut |_| {
            panic!("remote namespaces cannot be probed")
        })
        .unwrap();
        assert_eq!(list(&store.connection).unwrap(), before);
        assert_eq!(report.leases.len(), 1);
        assert_eq!(report.leases[0].subjects.len(), 2);
        assert_eq!(report.leases[0].occupied_ports, None);
        assert_eq!(report.leases[0].occupancy_error, None);
        assert!(report
            .diagnostics
            .iter()
            .any(|d| d.kind == PortLeaseDiagnosticKind::OutOfRange));
        store.connection.execute_batch("PRAGMA query_only=OFF").unwrap();
        store
            .connection
            .execute(
                "UPDATE workspace_port_leases SET namespace_key=?1",
                [HOST_LOOPBACK_NAMESPACE],
            )
            .unwrap();
        let report = list_status_with(&store, &mut |_| Ok(vec![1024, 1026])).unwrap();
        assert_eq!(report.leases[0].occupied_ports, Some(vec![1024, 1026]));
        let report = list_status_with(&store, &mut |_| {
            Err(PortLeaseError::Probe {
                port: 1024,
                message: "denied".into(),
            })
        })
        .unwrap();
        assert_eq!(report.leases[0].occupied_ports, None);
        assert_eq!(
            report.leases[0].occupancy_error.as_deref(),
            Some("probe port 1024: denied")
        );
        assert_eq!(list(&store.connection).unwrap()[0].base_port, 1024);
    }

    #[test]
    fn port_settle_checks_candidates_in_order_with_one_total_deadline() {
        use std::cell::Cell;
        let elapsed = Cell::new(Duration::ZERO);
        let mut attempts = [0; 2];
        let candidates = [0, 1];
        let selected = settle_occupancy_with_clock(
            &candidates,
            |candidate| {
                attempts[*candidate] += 1;
                Ok(*candidate == 1 && attempts[1] == 3)
            },
            || elapsed.get(),
            |duration| elapsed.set(elapsed.get() + duration),
        )
        .unwrap();
        assert_eq!(selected, Some(&1));
        assert_eq!(attempts, [3, 3]);
        assert_eq!(elapsed.get(), Duration::from_millis(40));

        elapsed.set(Duration::ZERO);
        let mut checks = 0;
        assert_eq!(
            settle_occupancy_with_clock(
                &candidates,
                |_| {
                    checks += 1;
                    Ok(false)
                },
                || elapsed.get(),
                |duration| elapsed.set(elapsed.get() + duration),
            )
            .unwrap(),
            None
        );
        assert_eq!(elapsed.get(), OCCUPANCY_SETTLE_LIMIT);
        assert_eq!(checks, 50);
        assert_eq!(
            settle_occupancy_with_clock::<u32>(
                &[],
                |_| panic!("empty candidates cannot probe"),
                || Duration::ZERO,
                |_| panic!("empty candidates cannot wait"),
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn port_allocation_settles_only_host_occupied_blocks_after_the_fast_scan() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let policy = WorkspaceLifecyclePolicy {
            port_range_start: 41000,
            port_range_end: 41005,
            port_block_size: 2,
            ..Default::default()
        };
        allocate(&store, "remote:test", "/leased", policy).unwrap();
        store
            .connection
            .execute(
                "UPDATE workspace_port_leases SET namespace_key=?1",
                [HOST_LOOPBACK_NAMESPACE],
            )
            .unwrap();
        let tx =
            Transaction::new_unchecked(&store.connection, TransactionBehavior::Immediate).unwrap();
        let mut busy_checks = 0;
        let selected = find_available_block(&tx, HOST_LOOPBACK_NAMESPACE, policy, &mut |port| {
            assert!(port >= 41002, "leased blocks must never be probed");
            if port == 41002 {
                busy_checks += 1;
            }
            Ok(port == 41002)
        })
        .unwrap();
        assert_eq!(selected, 41004);
        assert_eq!(busy_checks, 1, "a free block avoids the settle pass");

        let mut busy_checks = 0;
        let selected = find_available_block(&tx, HOST_LOOPBACK_NAMESPACE, policy, &mut |port| {
            assert!(port >= 41002);
            if port == 41002 {
                busy_checks += 1;
                return Ok(busy_checks <= 2);
            }
            Ok(port == 41004)
        })
        .unwrap();
        assert_eq!(selected, 41002);
        assert_eq!(busy_checks, 3);

        assert_eq!(
            find_available_block(&tx, HOST_LOOPBACK_NAMESPACE, policy, &mut |port| {
                assert!(port >= 41002);
                Ok(true)
            }),
            Err(PortLeaseError::Exhausted {
                start: 41000,
                end: 41005,
                block_size: 2
            })
        );
        assert!(matches!(
            find_available_block(
                &tx,
                HOST_LOOPBACK_NAMESPACE,
                WorkspaceLifecyclePolicy {
                    port_range_end: 41001,
                    ..policy
                },
                &mut |_| panic!("overlap exhaustion cannot probe or settle")
            ),
            Err(PortLeaseError::Exhausted { .. })
        ));
    }

    #[test]
    fn port_idle_release_settles_transient_occupancy_but_refuses_persistent_occupancy() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let mut lease = allocate(
            &store,
            "remote:test",
            "/a",
            WorkspaceLifecyclePolicy {
                port_block_size: 3,
                ..Default::default()
            },
        )
        .unwrap();
        lease.namespace_key = HOST_LOOPBACK_NAMESPACE.into();
        let busy_port = lease.base_port + 2;
        let mut checks = 0;
        require_idle_with(&lease, &mut |port| {
            if port == busy_port {
                checks += 1;
                return Ok(checks <= 2);
            }
            Ok(false)
        })
        .unwrap();
        assert_eq!(checks, 3);
        assert_eq!(
            require_idle_with(&lease, &mut |port| Ok(port == busy_port)),
            Err(PortLeaseError::Occupied {
                lease_id: lease.lease_id.clone(),
                ports: vec![busy_port]
            })
        );
        let error = PortLeaseError::Probe {
            port: busy_port,
            message: "permission denied".into(),
        };
        assert_eq!(
            require_idle_with(&lease, &mut |_| Err(error.clone())),
            Err(error)
        );
        assert_eq!(list(&store.connection).unwrap().len(), 1);
    }

    #[test]
    fn repeated_ensure_retains_numbers_after_policy_change_and_projects_env() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let lease = allocate(
            &store,
            "container:a",
            "/a",
            WorkspaceLifecyclePolicy::default(),
        )
        .unwrap();
        let changed = WorkspaceLifecyclePolicy {
            port_range_start: 60000,
            port_range_end: 60000,
            port_block_size: 1,
            ..Default::default()
        };
        assert_eq!(
            lease,
            allocate(&store, "container:a", "/a", changed).unwrap()
        );
        assert_eq!(
            uuid::Uuid::parse_str(&lease.lease_id)
                .unwrap()
                .get_version_num(),
            7
        );
        assert_eq!(
            port_lease_env(&lease),
            BTreeMap::from([
                ("COGNIA_PORT".into(), "41000".into()),
                ("COGNIA_PORT_COUNT".into(), "10".into()),
                ("PORT".into(), "41000".into()),
            ])
        );
        assert_eq!(
            allocate(
                &store,
                "container:b",
                "/b",
                WorkspaceLifecyclePolicy::default()
            )
            .unwrap()
            .base_port,
            lease.base_port
        );
        assert!(matches!(
            occupied_ports(&lease),
            Err(PortLeaseError::ProbeUnavailable(_))
        ));
    }

    #[test]
    fn separate_connections_serialize_allocations_and_mixed_sizes_never_overlap() {
        let dir = TempDir::new().unwrap();
        let first = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let second = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = [first, second]
            .into_iter()
            .enumerate()
            .map(|(index, store)| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    allocate(
                        &store,
                        "remote:test",
                        &format!("/{index}"),
                        WorkspaceLifecyclePolicy {
                            port_block_size: if index == 0 { 10 } else { 7 },
                            ..Default::default()
                        },
                    )
                    .unwrap()
                })
            })
            .collect();
        let leases: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(
            leases[0].base_port + leases[0].port_count <= leases[1].base_port
                || leases[1].base_port + leases[1].port_count <= leases[0].base_port
        );
    }

    #[test]
    fn listener_inside_block_is_skipped_and_existing_occupancy_is_report_only() {
        let policy = WorkspaceLifecyclePolicy {
            port_block_size: 3,
            ..isolated_host_policy()
        };
        let start = policy.port_range_start;
        let port = start + 1;
        let _listener = TcpListener::bind(("127.0.0.1", port as u16)).unwrap();
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let lease = allocate(&store, HOST_LOOPBACK_NAMESPACE, "/a", policy).unwrap();
        assert!(lease.base_port > port);
        assert_eq!((lease.base_port - start) % 3, 0);
        let held = eventually(|| TcpListener::bind(("127.0.0.1", lease.base_port as u16)).ok());
        assert!(occupied_ports(&lease).unwrap().contains(&lease.base_port));
        assert_eq!(
            lease,
            allocate(&store, HOST_LOOPBACK_NAMESPACE, "/a", policy).unwrap()
        );
        drop(held);
    }

    #[test]
    fn ipv6_listener_is_occupied_and_unavailable_errors_are_narrow() {
        assert!(ipv6_unavailable(&io::Error::from(
            io::ErrorKind::AddrNotAvailable
        )));
        assert!(!ipv6_unavailable(&io::Error::from(
            io::ErrorKind::PermissionDenied
        )));
        let port = isolated_host_policy().port_range_start as u16;
        match TcpListener::bind(("::1", port)) {
            Ok(listener) => {
                assert!(probe(u32::from(listener.local_addr().unwrap().port())).unwrap())
            }
            Err(error) if ipv6_unavailable(&error) => {}
            Err(error) => panic!("IPv6 probe failed: {error}"),
        }
    }

    #[test]
    fn port_wildcard_listeners_skip_candidate_blocks_without_reuse_or_self_conflicts() {
        for ip in [
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
        ] {
            let policy = isolated_host_policy();
            let port = policy.port_range_start + 1;
            let listener = match bind_probe_socket(SocketAddr::new(ip, port as u16)) {
                Ok(socket) => socket,
                Err(error) if ip.is_ipv6() && ipv6_unavailable(&error) => continue,
                Err(error) => panic!("wildcard listener bind: {error}"),
            };
            listener.listen(1).unwrap();
            let dir = TempDir::new().unwrap();
            let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
            let lease = allocate(&store, HOST_LOOPBACK_NAMESPACE, "/wildcard", policy).unwrap();
            assert!(lease.base_port > port);
            assert!(probe(port).unwrap());
            // A probe must not collide with its own wildcard bind.
            eventually(|| (!probe(lease.base_port).unwrap()).then_some(()));
            drop(listener);
            eventually(|| (!probe(port).unwrap()).then_some(()));
        }
    }

    #[test]
    fn exhaustion_and_inclusive_upper_bound_do_not_overflow() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let policy = WorkspaceLifecyclePolicy {
            port_range_start: 65535,
            port_range_end: 65535,
            port_block_size: 1,
            ..Default::default()
        };
        let lease = allocate(&store, "remote:test", "/a", policy).unwrap();
        assert_eq!(lease.base_port, 65535);
        let error = allocate(&store, "remote:test", "/b", policy).unwrap_err();
        assert!(matches!(error, PortLeaseError::Exhausted { .. }));
        for setting in ["portRangeStart", "portRangeEnd", "portBlockSize"] {
            assert!(error.to_string().contains(setting));
        }
        let invalid = WorkspaceLifecyclePolicy {
            port_block_size: u32::MAX,
            ..policy
        };
        assert!(matches!(
            allocate(&store, "remote:test", "/c", invalid),
            Err(PortLeaseError::InvalidPolicy(_))
        ));
        assert_eq!(list(&store.connection).unwrap().len(), 1);
        for sql in [
            "UPDATE workspace_port_leases SET base_port=1023",
            "UPDATE workspace_port_leases SET port_count=0",
            "UPDATE workspace_port_leases SET port_count=2",
            "UPDATE workspace_port_leases SET base_port=65536",
        ] {
            assert!(store.connection.execute(sql, []).is_err());
        }
    }

    #[test]
    fn reconcile_reports_overlaps_and_out_of_range_without_reassigning_or_reclaiming() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        let a = allocate(
            &store,
            "remote:test",
            "/offline/a",
            WorkspaceLifecyclePolicy::default(),
        )
        .unwrap();
        let b = allocate(
            &store,
            "remote:test",
            "/offline/b",
            WorkspaceLifecyclePolicy::default(),
        )
        .unwrap();
        store
            .connection
            .execute(
                "UPDATE workspace_port_leases SET base_port=?1 WHERE lease_id=?2",
                params![a.base_port + 1, b.lease_id],
            )
            .unwrap();
        let before = list(&store.connection).unwrap();
        let policy = WorkspaceLifecyclePolicy {
            port_range_start: 60000,
            port_range_end: 60999,
            ..Default::default()
        };
        store.put_workspace_lifecycle_policy(&policy).unwrap();
        let diagnostics = reconcile(&store).unwrap();
        assert_eq!(
            diagnostics
                .iter()
                .filter(|entry| entry.kind == PortLeaseDiagnosticKind::OutOfRange)
                .count(),
            2
        );
        assert!(diagnostics
            .iter()
            .any(|entry| entry.kind == PortLeaseDiagnosticKind::Overlap));
        assert_eq!(before, list(&store.connection).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn reconcile_reports_legacy_physical_duplicates_without_changing_roots() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir(&root).unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024).unwrap();
        allocate(
            &store,
            "remote:test",
            root.to_str().unwrap(),
            WorkspaceLifecyclePolicy::default(),
        )
        .unwrap();
        allocate(
            &store,
            "remote:test",
            alias.to_str().unwrap(),
            WorkspaceLifecyclePolicy::default(),
        )
        .unwrap();
        let before = list(&store.connection).unwrap();
        assert!(reconcile(&store)
            .unwrap()
            .iter()
            .any(|entry| entry.kind == PortLeaseDiagnosticKind::DuplicateRoot));
        assert_eq!(before, list(&store.connection).unwrap());
    }
    #[test]
    fn best_of_n_test_port_probe_is_scoped_nested_and_thread_local() {
        assert_eq!(TEST_PORT_OCCUPANCY.with(std::cell::Cell::get), None);
        {
            let _outer = TestPortProbeGuard::vacant();
            assert_eq!(probe(41000).unwrap(), false);
            {
                let _inner = TestPortProbeGuard::vacant();
                assert_eq!(probe(41000).unwrap(), false);
            }
            assert_eq!(TEST_PORT_OCCUPANCY.with(std::cell::Cell::get), Some(false));
            assert_eq!(std::thread::spawn(|| TEST_PORT_OCCUPANCY.with(std::cell::Cell::get)).join().unwrap(), None);
        }
        assert_eq!(TEST_PORT_OCCUPANCY.with(std::cell::Cell::get), None);
    }

}
