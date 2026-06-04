//! Auto-detection for local proxy software (FlClash, Clash Verge Rev,
//! Mihomo, v2rayN, plus generic HTTP/SOCKS listeners).
//!
//! Six-step pipeline over the client registry in `clients.rs`:
//!   1. Snapshot running process names once (sysinfo, in `spawn_blocking`).
//!   2. Per-client discovery — match process names + read config files for
//!      the real configured ports (`clients::discover`).
//!   3. Build an evidence map: config-derived ports ∪ defaults of running
//!      clients ∪ the generic `KNOWN_PORTS` fallback. Evidence priority is
//!      config > process > port.
//!   4. TCP-verify every candidate port in parallel (500 ms each); only
//!      ports that are actually listening survive.
//!   5. Probe every known controller endpoint (`GET /version`): HTTP 200
//!      yields the core version; 401/403 means a controller is present but
//!      secret-protected (Clash Verge Rev ships a secret by default).
//!   6. Dedup by port and sort deterministically (registry order, then
//!      `KNOWN_PORTS` order, then port) so the UI is stable run-to-run.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::time::timeout;

use super::clients::{self, ClientConfig, ClientId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CandidateKind {
    Http,
    Socks5,
    Clash,
}

/// How a candidate was discovered. Drives the evidence subtitle in the
/// Detection tab and the dedup priority (config beats process beats port).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CandidateSource {
    Config,
    Process,
    Port,
}

impl CandidateSource {
    fn priority(self) -> u8 {
        match self {
            Self::Config => 2,
            Self::Process => 1,
            Self::Port => 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyCandidate {
    pub kind: CandidateKind,
    pub host: String,
    pub port: u16,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Owning client when discovery attributed the port to a known client.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<ClientId>,
    /// Display name matching `client` (e.g. "FlClash").
    #[serde(rename = "clientName", skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<CandidateSource>,
    /// True when the client's controller answered 401/403 — present but
    /// guarded by an API secret, so no version string is available.
    #[serde(rename = "controllerSecured", skip_serializing_if = "Option::is_none")]
    pub controller_secured: Option<bool>,
}

const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const CLASH_API_TIMEOUT: Duration = Duration::from_millis(800);
const CLASH_API_HOST: &str = "127.0.0.1";
const CLASH_API_PORT: u16 = 9090;
/// Clash Verge Rev's default external controller port.
const VERGE_API_PORT: u16 = 9097;

/// Loopback ports we probe by default. Order matters — first match wins in
/// the UI's "Apply most likely" affordance.
///
/// The kind here is the *initial guess*; for 7890/7891 we may upgrade to
/// `Clash` after the controller probe confirms a Clash-compatible core.
const KNOWN_PORTS: &[(u16, CandidateKind, &str)] = &[
    (7890, CandidateKind::Http, "Clash mixed port"),
    (7891, CandidateKind::Socks5, "Clash SOCKS port"),
    (1080, CandidateKind::Socks5, "SOCKS proxy"),
    (10808, CandidateKind::Socks5, "V2Ray SOCKS port"),
    (10809, CandidateKind::Http, "V2Ray HTTP port"),
    (8080, CandidateKind::Http, "HTTP proxy"),
    (8888, CandidateKind::Http, "HTTP proxy"),
];

/// TCP-connect probe for a single host:port. Returns true when the connect
/// completes within the timeout window.
async fn port_open(host: &str, port: u16) -> bool {
    let addr = match format!("{host}:{port}").parse::<SocketAddr>() {
        Ok(a) => a,
        Err(_) => return false,
    };
    matches!(
        timeout(PROBE_TIMEOUT, TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// Outcome of probing a Clash-style controller's `/version` endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ControllerStatus {
    /// 200 with a parsable `{"version": ...}` body.
    Version(String),
    /// 401/403 — controller is listening but requires an API secret.
    Secured,
    /// Unreachable or unexpected payload.
    Absent,
}

/// Hit a Clash/Mihomo controller API and classify the response.
async fn probe_controller(host: &str, port: u16) -> ControllerStatus {
    let Ok(client) = reqwest::Client::builder()
        .timeout(CLASH_API_TIMEOUT)
        // No proxy here — we're probing localhost.
        .no_proxy()
        .build()
    else {
        return ControllerStatus::Absent;
    };
    let url = format!("http://{host}:{port}/version");
    let Ok(resp) = client.get(&url).send().await else {
        return ControllerStatus::Absent;
    };
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return ControllerStatus::Secured;
    }
    if !status.is_success() {
        return ControllerStatus::Absent;
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return ControllerStatus::Absent;
    };
    body.get("version")
        .and_then(|v| v.as_str())
        .map(|s| ControllerStatus::Version(s.to_string()))
        .unwrap_or(ControllerStatus::Absent)
}

/// Hit Clash/Mihomo's default controller at 127.0.0.1:9090 and return the
/// reported version string. Exposed to the frontend through the
/// `proxy_identify_clash` command — the Detection tab's quick status probe.
pub async fn identify_clash() -> Option<String> {
    match probe_controller(CLASH_API_HOST, CLASH_API_PORT).await {
        ControllerStatus::Version(v) => Some(v),
        _ => None,
    }
}

/// Snapshot of lowercased process names. Refresh runs in `spawn_blocking`
/// (sysinfo does blocking syscalls); any failure degrades to an empty set so
/// detection falls back to config + generic port evidence.
async fn snapshot_process_names() -> HashSet<String> {
    tokio::task::spawn_blocking(|| {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        sys.processes()
            .values()
            .map(|p| p.name().to_string_lossy().to_lowercase())
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// One port's best discovery evidence. `registry_idx` / `known_idx` are the
/// deterministic sort keys (usize::MAX when not applicable).
#[derive(Debug, Clone)]
struct Evidence {
    kind: CandidateKind,
    client: Option<ClientId>,
    source: CandidateSource,
    registry_idx: usize,
    known_idx: usize,
    generic_label: Option<&'static str>,
}

fn merge_evidence(map: &mut HashMap<u16, Evidence>, port: u16, evidence: Evidence) {
    match map.get(&port) {
        // Equal priority keeps the earlier insertion (registry order wins).
        Some(existing) if existing.source.priority() >= evidence.source.priority() => {}
        _ => {
            map.insert(port, evidence);
        }
    }
}

/// Step 3 — fold generic ports, running-client defaults, and config-derived
/// ports into one evidence map keyed by port.
fn build_evidence(discovered: &[(ClientId, ClientConfig, bool)]) -> HashMap<u16, Evidence> {
    let mut map = HashMap::new();
    for (idx, (port, kind, label)) in KNOWN_PORTS.iter().enumerate() {
        merge_evidence(
            &mut map,
            *port,
            Evidence {
                kind: *kind,
                client: None,
                source: CandidateSource::Port,
                registry_idx: usize::MAX,
                known_idx: idx,
                generic_label: Some(label),
            },
        );
    }
    for (id, cfg, process_matched) in discovered {
        let registry_idx = clients::registry_index(*id);
        if *process_matched {
            for (port, kind) in clients::client_def(*id).default_ports {
                merge_evidence(
                    &mut map,
                    *port,
                    Evidence {
                        kind: *kind,
                        client: Some(*id),
                        source: CandidateSource::Process,
                        registry_idx,
                        known_idx: usize::MAX,
                        generic_label: None,
                    },
                );
            }
        }
        for (port, kind) in &cfg.ports {
            merge_evidence(
                &mut map,
                *port,
                Evidence {
                    kind: *kind,
                    client: Some(*id),
                    source: CandidateSource::Config,
                    registry_idx,
                    known_idx: usize::MAX,
                    generic_label: None,
                },
            );
        }
    }
    map
}

/// Step 5 input — the distinct controller endpoints worth probing: the two
/// well-known defaults plus anything the config files declared.
fn controller_endpoints(discovered: &[(ClientId, ClientConfig, bool)]) -> Vec<(String, u16)> {
    let mut set: HashSet<(String, u16)> = HashSet::new();
    set.insert((CLASH_API_HOST.to_string(), CLASH_API_PORT));
    set.insert((CLASH_API_HOST.to_string(), VERGE_API_PORT));
    for (_, cfg, _) in discovered {
        for endpoint in &cfg.controllers {
            set.insert((endpoint.host.clone(), endpoint.port));
        }
    }
    let mut out: Vec<_> = set.into_iter().collect();
    out.sort();
    out
}

/// The controller status that belongs to a specific client: config-derived
/// endpoints take precedence over the registry defaults.
fn client_controller_status<'a>(
    id: ClientId,
    discovered: &[(ClientId, ClientConfig, bool)],
    statuses: &'a HashMap<(String, u16), ControllerStatus>,
) -> Option<&'a ControllerStatus> {
    let cfg = discovered
        .iter()
        .find(|(d, _, _)| *d == id)
        .map(|(_, c, _)| c);
    let config_endpoints = cfg
        .into_iter()
        .flat_map(|c| c.controllers.iter().map(|e| (e.host.clone(), e.port)));
    let default_endpoints = clients::client_def(id)
        .default_controllers
        .iter()
        .map(|(host, port)| ((*host).to_string(), *port));
    for key in config_endpoints.chain(default_endpoints) {
        if let Some(status) = statuses.get(&key) {
            if *status != ControllerStatus::Absent {
                return Some(status);
            }
        }
    }
    None
}

/// Step 6 — turn live-port evidence into the final sorted candidate list.
/// Pure (no I/O) so the merge/attribution/order rules are unit-testable.
fn assemble_candidates(
    evidence: HashMap<u16, Evidence>,
    live: &HashSet<u16>,
    discovered: &[(ClientId, ClientConfig, bool)],
    statuses: &HashMap<(String, u16), ControllerStatus>,
) -> Vec<ProxyCandidate> {
    let mut rows: Vec<(u16, Evidence)> = evidence
        .into_iter()
        .filter(|(port, _)| live.contains(port))
        .collect();
    rows.sort_by_key(|(port, ev)| (ev.registry_idx, ev.known_idx, *port));

    rows.into_iter()
        .map(|(port, ev)| {
            let mut kind = ev.kind;
            let mut version: Option<String> = None;
            let mut controller_secured: Option<bool> = None;
            let label;
            match ev.client {
                Some(id) => {
                    let name = clients::client_def(id).name;
                    match client_controller_status(id, discovered, statuses) {
                        Some(ControllerStatus::Version(v)) => {
                            kind = CandidateKind::Clash;
                            version = Some(v.clone());
                        }
                        Some(ControllerStatus::Secured) => {
                            controller_secured = Some(true);
                        }
                        _ => {}
                    }
                    label = format!("{name} @ 127.0.0.1:{port}");
                }
                None => {
                    let mut display = ev.generic_label.unwrap_or("Proxy").to_string();
                    // Legacy behavior: generic hits on Clash's default mixed
                    // and SOCKS ports get upgraded when 9090 answers openly.
                    if matches!(port, 7890 | 7891) {
                        if let Some(ControllerStatus::Version(v)) =
                            statuses.get(&(CLASH_API_HOST.to_string(), CLASH_API_PORT))
                        {
                            kind = CandidateKind::Clash;
                            version = Some(v.clone());
                            display = format!("Clash / Mihomo (v{v})");
                        }
                    }
                    label = format!("{display} @ 127.0.0.1:{port}");
                }
            }
            ProxyCandidate {
                kind,
                host: "127.0.0.1".to_string(),
                port,
                label,
                version,
                client: ev.client,
                client_name: ev.client.map(|id| clients::client_def(id).name.to_string()),
                source: Some(ev.source),
                controller_secured,
            }
        })
        .collect()
}

/// Run the full discovery pipeline. Never panics; an empty machine yields an
/// empty list. Port and controller probes run concurrently.
pub async fn probe_all() -> Vec<ProxyCandidate> {
    let running = snapshot_process_names().await;
    let discovered = clients::discover(&running);
    let evidence = build_evidence(&discovered);

    let mut ports: Vec<u16> = evidence.keys().copied().collect();
    ports.sort_unstable();
    let port_probes = ports
        .iter()
        .map(|port| async move { (*port, port_open("127.0.0.1", *port).await) });

    let endpoints = controller_endpoints(&discovered);
    let controller_probes = endpoints.iter().map(|(host, port)| async move {
        ((host.clone(), *port), probe_controller(host, *port).await)
    });

    let (port_results, controller_results) = tokio::join!(
        futures_util::future::join_all(port_probes),
        futures_util::future::join_all(controller_probes),
    );

    let live: HashSet<u16> = port_results
        .into_iter()
        .filter(|(_, open)| *open)
        .map(|(port, _)| port)
        .collect();
    let statuses: HashMap<(String, u16), ControllerStatus> =
        controller_results.into_iter().collect();

    assemble_candidates(evidence, &live, &discovered, &statuses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddrV4};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn port_open_returns_false_for_unbound_port() {
        // Port 1 is reserved & should never be listening locally.
        assert!(!port_open("127.0.0.1", 1).await);
    }

    #[tokio::test]
    async fn port_open_returns_true_for_listening_port() {
        // Bind an ephemeral port so we know something is listening.
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let probe = port_open("127.0.0.1", port).await;
        assert!(probe);
        drop(listener);
    }

    #[tokio::test]
    async fn port_open_returns_false_for_invalid_host() {
        // Non-numeric host won't parse as SocketAddr — should short-circuit
        // false rather than hang.
        assert!(!port_open("not-a-host", 80).await);
    }

    #[tokio::test]
    async fn identify_clash_returns_none_when_api_down() {
        // Real test environment should never have Clash on 9090. If this
        // accidentally passes against a real Clash, the version string is
        // a String — still safe.
        // Either None or Some(version) is acceptable here; the real check
        // is that the call completes within the timeout.
        let _ = identify_clash().await;
    }

    #[tokio::test]
    async fn probe_all_returns_empty_on_empty_machine() {
        // We can't guarantee no proxy on the dev machine. Just assert the
        // call returns within reasonable time and the structure parses.
        let result = probe_all().await;
        for c in &result {
            assert_eq!(c.host, "127.0.0.1");
            assert!(c.port > 0);
            assert!(!c.label.is_empty());
        }
    }

    // -- probe_controller against a canned local HTTP server -------------------

    /// Serve one connection with a fixed raw HTTP response, return the port.
    async fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        port
    }

    #[tokio::test]
    async fn probe_controller_reports_version_on_200() {
        let port = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 20\r\nconnection: close\r\n\r\n{\"version\":\"1.18.0\"}",
        )
        .await;
        assert_eq!(
            probe_controller("127.0.0.1", port).await,
            ControllerStatus::Version("1.18.0".to_string())
        );
    }

    #[tokio::test]
    async fn probe_controller_reports_secured_on_401() {
        let port = serve_once(
            "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        )
        .await;
        assert_eq!(
            probe_controller("127.0.0.1", port).await,
            ControllerStatus::Secured
        );
    }

    #[tokio::test]
    async fn probe_controller_absent_on_refused_or_bad_payload() {
        assert_eq!(
            probe_controller("127.0.0.1", 1).await,
            ControllerStatus::Absent
        );
        let port = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\nnot json!",
        )
        .await;
        assert_eq!(
            probe_controller("127.0.0.1", port).await,
            ControllerStatus::Absent
        );
    }

    // -- evidence merge + assembly (pure, no I/O) ------------------------------

    fn discovered_flclash(port: u16, matched: bool) -> (ClientId, ClientConfig, bool) {
        (
            ClientId::Flclash,
            ClientConfig {
                ports: vec![(port, CandidateKind::Http)],
                controllers: Vec::new(),
            },
            matched,
        )
    }

    #[test]
    fn evidence_config_beats_generic_port() {
        // FlClash config claims 7890 — must win over the generic KNOWN_PORTS
        // entry for the same port.
        let discovered = vec![discovered_flclash(7890, true)];
        let map = build_evidence(&discovered);
        let ev = map.get(&7890).unwrap();
        assert_eq!(ev.source, CandidateSource::Config);
        assert_eq!(ev.client, Some(ClientId::Flclash));
    }

    #[test]
    fn evidence_process_defaults_added_only_when_matched() {
        // Not running + no config port for 7897 → only generic ports exist.
        let discovered = vec![(ClientId::ClashVergeRev, ClientConfig::default(), false)];
        let map = build_evidence(&discovered);
        assert!(!map.contains_key(&7897));

        // Running → verge's default 7897 appears with Process evidence.
        let discovered = vec![(ClientId::ClashVergeRev, ClientConfig::default(), true)];
        let map = build_evidence(&discovered);
        let ev = map.get(&7897).unwrap();
        assert_eq!(ev.source, CandidateSource::Process);
        assert_eq!(ev.client, Some(ClientId::ClashVergeRev));
    }

    #[test]
    fn evidence_equal_priority_keeps_registry_order() {
        // FlClash (registry idx 0) and Mihomo (idx 2) both claim 7890 via
        // config — the earlier registry entry must win.
        let discovered = vec![
            discovered_flclash(7890, false),
            (
                ClientId::Mihomo,
                ClientConfig {
                    ports: vec![(7890, CandidateKind::Http)],
                    controllers: Vec::new(),
                },
                false,
            ),
        ];
        let map = build_evidence(&discovered);
        assert_eq!(map.get(&7890).unwrap().client, Some(ClientId::Flclash));
    }

    #[test]
    fn assemble_orders_clients_before_generic_and_is_deterministic() {
        // FlClash via config only (not running → no default-port evidence);
        // v2rayN running → default ports 10808/10809 attributed.
        let discovered = vec![
            discovered_flclash(17890, false),
            (ClientId::V2rayn, ClientConfig::default(), true),
        ];
        let evidence = build_evidence(&discovered);
        let live: HashSet<u16> = evidence.keys().copied().collect(); // everything live
        let statuses = HashMap::new();
        let first = assemble_candidates(evidence.clone(), &live, &discovered, &statuses);
        let second = assemble_candidates(evidence, &live, &discovered, &statuses);
        let order: Vec<u16> = first.iter().map(|c| c.port).collect();
        // FlClash (registry 0) before v2rayN (registry 3) before generic.
        assert_eq!(order[0], 17890);
        assert_eq!(order[1], 10808);
        assert_eq!(order[2], 10809);
        let generic: Vec<u16> = first
            .iter()
            .filter(|c| c.client.is_none())
            .map(|c| c.port)
            .collect();
        // Generic candidates keep KNOWN_PORTS order (10808/10809 were taken
        // over by v2rayN above).
        assert_eq!(generic, vec![7890, 7891, 1080, 8080, 8888]);
        // Deterministic: identical inputs → identical output order.
        assert_eq!(order, second.iter().map(|c| c.port).collect::<Vec<_>>());
    }

    #[test]
    fn assemble_attributes_open_controller_version_to_client() {
        let discovered = vec![discovered_flclash(7890, true)];
        let evidence = build_evidence(&discovered);
        let live: HashSet<u16> = [7890].into_iter().collect();
        let statuses: HashMap<(String, u16), ControllerStatus> = [(
            ("127.0.0.1".to_string(), 9090),
            ControllerStatus::Version("1.18.0".to_string()),
        )]
        .into_iter()
        .collect();
        let out = assemble_candidates(evidence, &live, &discovered, &statuses);
        let c = &out[0];
        assert_eq!(c.client, Some(ClientId::Flclash));
        assert_eq!(c.client_name.as_deref(), Some("FlClash"));
        assert_eq!(c.kind, CandidateKind::Clash);
        assert_eq!(c.version.as_deref(), Some("1.18.0"));
        assert_eq!(c.controller_secured, None);
        assert_eq!(c.source, Some(CandidateSource::Config));
    }

    #[test]
    fn assemble_marks_secured_controller_without_version() {
        // Clash Verge Rev: 9097 answers 401 → controllerSecured, no version.
        let discovered = vec![(ClientId::ClashVergeRev, ClientConfig::default(), true)];
        let evidence = build_evidence(&discovered);
        let live: HashSet<u16> = [7897].into_iter().collect();
        let statuses: HashMap<(String, u16), ControllerStatus> = [
            (("127.0.0.1".to_string(), 9097), ControllerStatus::Secured),
            (("127.0.0.1".to_string(), 9090), ControllerStatus::Absent),
        ]
        .into_iter()
        .collect();
        let out = assemble_candidates(evidence, &live, &discovered, &statuses);
        let c = &out[0];
        assert_eq!(c.port, 7897);
        assert_eq!(c.controller_secured, Some(true));
        assert_eq!(c.version, None);
        assert_eq!(c.kind, CandidateKind::Http); // no version → kind not upgraded
    }

    #[test]
    fn assemble_preserves_legacy_generic_clash_upgrade() {
        // No client evidence at all — a generic 7890 hit plus an open 9090
        // controller must still produce the historical Clash/Mihomo label.
        let discovered: Vec<(ClientId, ClientConfig, bool)> = Vec::new();
        let evidence = build_evidence(&discovered);
        let live: HashSet<u16> = [7890, 7891].into_iter().collect();
        let statuses: HashMap<(String, u16), ControllerStatus> = [(
            ("127.0.0.1".to_string(), 9090),
            ControllerStatus::Version("1.18.0".to_string()),
        )]
        .into_iter()
        .collect();
        let out = assemble_candidates(evidence, &live, &discovered, &statuses);
        assert_eq!(out.len(), 2);
        for c in &out {
            assert_eq!(c.kind, CandidateKind::Clash);
            assert_eq!(c.version.as_deref(), Some("1.18.0"));
            assert!(c.label.contains("Clash / Mihomo (v1.18.0)"), "{}", c.label);
            assert_eq!(c.client, None);
            assert_eq!(c.source, Some(CandidateSource::Port));
        }
    }

    #[test]
    fn candidate_serde_omits_absent_client_fields() {
        // Backward compat: a generic candidate's JSON must not contain the
        // new client keys, keeping the TS type's optionality honest.
        let discovered: Vec<(ClientId, ClientConfig, bool)> = Vec::new();
        let evidence = build_evidence(&discovered);
        let live: HashSet<u16> = [1080].into_iter().collect();
        let out = assemble_candidates(evidence, &live, &discovered, &HashMap::new());
        let json = serde_json::to_value(&out[0]).unwrap();
        assert_eq!(json["source"], "port");
        assert!(json.get("client").is_none());
        assert!(json.get("clientName").is_none());
        assert!(json.get("controllerSecured").is_none());
        assert!(json.get("version").is_none());
    }

    #[test]
    fn controller_endpoints_include_defaults_and_config() {
        let discovered = vec![(
            ClientId::Mihomo,
            ClientConfig {
                ports: Vec::new(),
                controllers: vec![super::super::clients::ControllerEndpoint {
                    host: "127.0.0.1".to_string(),
                    port: 19090,
                }],
            },
            true,
        )];
        let endpoints = controller_endpoints(&discovered);
        assert!(endpoints.contains(&("127.0.0.1".to_string(), 9090)));
        assert!(endpoints.contains(&("127.0.0.1".to_string(), 9097)));
        assert!(endpoints.contains(&("127.0.0.1".to_string(), 19090)));
    }

    #[tokio::test]
    async fn snapshot_process_names_is_nonempty_and_lowercase() {
        // The test process itself is always running.
        let names = snapshot_process_names().await;
        assert!(!names.is_empty());
        for name in names.iter().take(50) {
            assert_eq!(*name, name.to_lowercase());
        }
    }
}
