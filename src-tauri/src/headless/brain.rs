//! Brain supervisor (ADR-0059 W4 / R8) — spawns and supervises the headless
//! Node brain (`cognia-agent serve`) exactly as the desktop supervises the
//! sidecar: spawn lock, generation epochs, crash backoff (shared
//! `supervision_backoff`), a readiness watchdog, and log piping.
//!
//! # Readiness
//!
//! The brain is "ready" when it completes the bridge WS handshake — the
//! `hello` frame flips `ws_bridge`'s readiness watch. A child that never
//! hellos within [`BrainConfig::ready_timeout`] is killed and the crash
//! backoff escalates.
//!
//! # Env contract (canonical, keep in sync with `cli/src/serve`)
//!
//! `COGNIA_SERVER_URL`, `COGNIA_SERVICE_TOKEN` (env-only, never argv, re-
//! minted per spawn), `COGNIA_BRIDGE_URL`, `COGNIA_TLS_FINGERPRINT`,
//! `COGNIA_DATA_DIR`, `COGNIA_LOCAL_ACCOUNT_ID`, and `NODE_EXTRA_CA_CERTS`
//! pointed at the companion `tls.pem` (the self-signed cert's SANs include
//! `127.0.0.1` / `localhost` — verified in `companion_api/tls.rs`).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::RwLock as PlRwLock;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{watch, Mutex};

use crate::companion_api::jwt::issue_service_jwt;
use crate::companion_api::{ws_bridge, SharedState};
use crate::supervision_backoff::CrashBackoff;

/// Env var naming the brain entry script. Set by `Dockerfile.cognia-server`.
pub const BRAIN_ENTRY_ENV: &str = "COGNIA_BRAIN_ENTRY";

/// How often the supervisor re-mints and pushes a fresh service token over
/// the bridge (tokens live 24h; refresh at half-life).
const TOKEN_REFRESH_INTERVAL: Duration = Duration::from_secs(12 * 3600);

/// Pause after a failed `spawn` attempt (binary missing etc.) so a
/// permanently-broken config doesn't hot-loop between backoff table entries.
const SPAWN_ERROR_PAUSE: Duration = Duration::from_secs(1);

/// Everything needed to launch one brain child. Pure data — env construction
/// is unit-tested via [`build_brain_env`].
#[derive(Debug, Clone)]
pub struct BrainConfig {
    /// Absolute path to the brain bundle (`cognia-agent` entry, run as
    /// `node <entry> serve`).
    pub entry: PathBuf,
    /// `https://127.0.0.1:<bound port>` — loopback; the service token is
    /// loopback-gated.
    pub server_url: String,
    /// `wss://127.0.0.1:<bound port>/ws/v1/bridge`.
    pub bridge_url: String,
    pub data_dir: PathBuf,
    pub account_id: String,
    pub tls_fingerprint: String,
    /// Path to the companion `tls.pem`, exported as `NODE_EXTRA_CA_CERTS`
    /// so Node trusts the self-signed loopback cert.
    pub node_extra_ca_certs: Option<PathBuf>,
    /// How long a fresh child has to complete the bridge hello.
    pub ready_timeout: Duration,
}

impl BrainConfig {
    /// Standard config for a bound server port. `entry` comes from
    /// `COGNIA_BRAIN_ENTRY`.
    pub fn for_port(
        entry: PathBuf,
        port: u16,
        data_dir: PathBuf,
        account_id: String,
        tls_fingerprint: String,
        node_extra_ca_certs: Option<PathBuf>,
    ) -> Self {
        Self {
            entry,
            server_url: format!("https://127.0.0.1:{port}"),
            bridge_url: format!("wss://127.0.0.1:{port}/ws/v1/bridge"),
            data_dir,
            account_id,
            tls_fingerprint,
            node_extra_ca_certs,
            ready_timeout: Duration::from_secs(90),
        }
    }
}

/// Build the child env per the canonical contract. Pure — unit-tested.
/// The service token travels ONLY here (never argv).
pub fn build_brain_env(config: &BrainConfig, service_token: &str) -> Vec<(String, String)> {
    let mut env = vec![
        ("COGNIA_SERVER_URL".to_string(), config.server_url.clone()),
        (
            "COGNIA_SERVICE_TOKEN".to_string(),
            service_token.to_string(),
        ),
        ("COGNIA_BRIDGE_URL".to_string(), config.bridge_url.clone()),
        (
            "COGNIA_TLS_FINGERPRINT".to_string(),
            config.tls_fingerprint.clone(),
        ),
        (
            "COGNIA_DATA_DIR".to_string(),
            config.data_dir.display().to_string(),
        ),
        (
            "COGNIA_LOCAL_ACCOUNT_ID".to_string(),
            config.account_id.clone(),
        ),
    ];
    if let Some(pem) = &config.node_extra_ca_certs {
        env.push(("NODE_EXTRA_CA_CERTS".to_string(), pem.display().to_string()));
    }
    env
}

/// Snapshot for `/healthz` — see [`brain_status`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrainStatus {
    /// A child process is currently alive.
    pub running: bool,
    /// The child completed the bridge hello (data plane live).
    pub ready: bool,
    /// Times a child has been spawned since boot.
    pub restart_count: u64,
    /// Latest RSS gauge from the brain's pong frames (0 = unknown).
    pub rss_bytes: u64,
    /// `brainVersion` from the hello frame, when connected.
    pub version: Option<String>,
}

/// Process-global supervisor handle so `/healthz` can report the brain
/// without threading through `CompanionState` (same idiom as
/// `TLS_FINGERPRINT`).
static BRAIN: PlRwLock<Option<Arc<BrainSupervisor>>> = PlRwLock::new(None);

pub fn install_brain(supervisor: Option<Arc<BrainSupervisor>>) {
    *BRAIN.write() = supervisor;
}

/// The installed supervisor's status, if any (`None` on desktop).
pub fn brain_status() -> Option<BrainStatus> {
    BRAIN.read().as_ref().map(|b| b.status())
}

pub struct BrainSupervisor {
    config: BrainConfig,
    /// Signing secret source for token minting (rotations picked up on the
    /// next spawn / refresh).
    state: SharedState,
    backoff: Mutex<CrashBackoff>,
    running: AtomicBool,
    restart_count: AtomicU64,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
}

impl BrainSupervisor {
    pub fn new(config: BrainConfig, state: SharedState) -> Arc<Self> {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        Arc::new(Self {
            config,
            state,
            backoff: Mutex::new(CrashBackoff::default()),
            running: AtomicBool::new(false),
            restart_count: AtomicU64::new(0),
            shutdown_tx,
            shutdown_rx,
        })
    }

    pub fn status(&self) -> BrainStatus {
        BrainStatus {
            running: self.running.load(Ordering::SeqCst),
            ready: ws_bridge::bridge_connected(),
            restart_count: self.restart_count.load(Ordering::SeqCst),
            rss_bytes: ws_bridge::brain_rss_bytes(),
            version: ws_bridge::brain_hello().map(|h| h.brain_version),
        }
    }

    /// Signal the supervision loop to kill the child and stop respawning.
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    fn mint_token(&self) -> Result<String, String> {
        let secret = self.state.secret.read().clone();
        issue_service_jwt(&secret, &self.config.account_id)
            .map(|(token, _exp)| token)
            .map_err(|e| format!("failed to mint brain service token: {e}"))
    }

    /// Start the supervision loop. Runs until [`BrainSupervisor::shutdown`].
    pub fn start(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let this = Arc::clone(self);
        tokio::spawn(async move { this.run().await })
    }

    async fn run(&self) {
        let mut shutdown = self.shutdown_rx.clone();
        loop {
            if *shutdown.borrow() {
                break;
            }

            // Crash backoff (interruptible by shutdown).
            let remaining = self.backoff.lock().await.remaining(Instant::now());
            if let Some(rem) = remaining {
                log::info!(
                    "brain supervisor: crash backoff, respawning in {} ms",
                    rem.as_millis()
                );
                tokio::select! {
                    _ = tokio::time::sleep(rem) => {}
                    _ = shutdown.changed() => continue,
                }
            }

            match self.spawn_once().await {
                Ok(child) => {
                    self.supervise_child(child, &mut shutdown).await;
                }
                Err(e) => {
                    log::error!("brain supervisor: spawn failed: {e}");
                    self.backoff.lock().await.note_failure(Instant::now());
                    tokio::select! {
                        _ = tokio::time::sleep(SPAWN_ERROR_PAUSE) => {}
                        _ = shutdown.changed() => {}
                    }
                }
            }
        }
        log::info!("brain supervisor: stopped");
    }

    async fn spawn_once(&self) -> Result<tokio::process::Child, String> {
        if !self.config.entry.exists() {
            return Err(format!(
                "brain entry not found at {} (check {BRAIN_ENTRY_ENV})",
                self.config.entry.display()
            ));
        }
        let token = self.mint_token()?;

        let mut cmd = Command::new("node");
        cmd.arg(&self.config.entry)
            .arg("serve")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in build_brain_env(&self.config, &token) {
            cmd.env(k, v);
        }
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.spawn()
            .map_err(|e| format!("failed to spawn brain (is Node >= 20 on PATH?): {e}"))
    }

    async fn supervise_child(
        &self,
        mut child: tokio::process::Child,
        shutdown: &mut watch::Receiver<bool>,
    ) {
        self.running.store(true, Ordering::SeqCst);
        self.restart_count.fetch_add(1, Ordering::SeqCst);

        // Pipe child output to the server log.
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    log::info!("[brain] {line}");
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    log::warn!("[brain.stderr] {line}");
                }
            });
        }

        let mut ready_rx = ws_bridge::subscribe_bridge_ready();
        let mut was_ready = *ready_rx.borrow();
        let ready_deadline = tokio::time::sleep(self.config.ready_timeout);
        tokio::pin!(ready_deadline);
        let mut refresh_ticker = tokio::time::interval(TOKEN_REFRESH_INTERVAL);
        refresh_ticker.tick().await; // consume the immediate tick

        loop {
            tokio::select! {
                status = child.wait() => {
                    match status {
                        Ok(s) => log::warn!("brain exited: {s}"),
                        Err(e) => log::error!("brain wait error: {e}"),
                    }
                    // Any exit is a failure for backoff purposes; a healthy
                    // run reset the counter at hello time, so a single crash
                    // after a long healthy run respawns immediately.
                    self.backoff.lock().await.note_failure(Instant::now());
                    break;
                }

                changed = ready_rx.changed(), if !was_ready => {
                    if changed.is_err() {
                        continue;
                    }
                    if *ready_rx.borrow() {
                        was_ready = true;
                        self.backoff.lock().await.reset();
                        log::info!("brain supervisor: bridge hello received — brain ready");
                    }
                }

                _ = &mut ready_deadline, if !was_ready => {
                    log::error!(
                        "brain did not complete the bridge hello within {}s; killing",
                        self.config.ready_timeout.as_secs()
                    );
                    let _ = child.start_kill();
                    // Loop continues; child.wait() observes the kill.
                }

                _ = refresh_ticker.tick() => {
                    match self.mint_token() {
                        Ok(token) => {
                            if let Err(e) = ws_bridge::send_token_refresh(token) {
                                log::warn!("brain supervisor: token refresh not delivered: {e}");
                            }
                        }
                        Err(e) => log::error!("brain supervisor: token re-mint failed: {e}"),
                    }
                }

                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        log::info!("brain supervisor: shutdown — killing brain");
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        break;
                    }
                }
            }
        }

        self.running.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{
        deny_list::DenyList, desktop_messages_bridge::DesktopMessagesBridge,
        desktop_writes_bridge::DesktopWritesBridge, event_bus::EventBus,
        idempotency::IdempotencyCache, pair_code_lru::PairCodeLru, push::PushTokenRegistry,
        rate_limit::RateLimiter, redemption_lru::RedemptionLru, sync_bridge::SyncBridge,
        sync_registry::SyncTableRegistry, CompanionState,
    };
    use parking_lot::RwLock;

    fn test_state() -> SharedState {
        Arc::new(CompanionState {
            secret: RwLock::new(b"test-secret-32-bytes-exactly____".to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: SyncBridge::new(),
            desktop_messages_bridge: DesktopMessagesBridge::new(),
            desktop_writes_bridge: DesktopWritesBridge::new(),
            sync_registry: SyncTableRegistry::with_defaults(),
            rate_limiter: RateLimiter::with_defaults(),
            push_tokens: PushTokenRegistry::new(),
        })
    }

    fn test_config(entry: PathBuf, ready_timeout: Duration) -> BrainConfig {
        BrainConfig {
            entry,
            server_url: "https://127.0.0.1:7890".into(),
            bridge_url: "wss://127.0.0.1:7890/ws/v1/bridge".into(),
            data_dir: PathBuf::from("/data"),
            account_id: "local_acct_a".into(),
            tls_fingerprint: "ff00".into(),
            node_extra_ca_certs: Some(PathBuf::from("/data/cognia/companion/tls.pem")),
            ready_timeout,
        }
    }

    #[test]
    fn build_brain_env_matches_the_canonical_contract() {
        let config = test_config(PathBuf::from("brain.mjs"), Duration::from_secs(90));
        let env = build_brain_env(&config, "tok-123");
        let get = |k: &str| {
            env.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("COGNIA_SERVER_URL"), Some("https://127.0.0.1:7890"));
        assert_eq!(get("COGNIA_SERVICE_TOKEN"), Some("tok-123"));
        assert_eq!(
            get("COGNIA_BRIDGE_URL"),
            Some("wss://127.0.0.1:7890/ws/v1/bridge")
        );
        assert_eq!(get("COGNIA_TLS_FINGERPRINT"), Some("ff00"));
        assert_eq!(get("COGNIA_LOCAL_ACCOUNT_ID"), Some("local_acct_a"));
        assert!(get("COGNIA_DATA_DIR").is_some());
        assert!(get("NODE_EXTRA_CA_CERTS").unwrap().ends_with("tls.pem"));
    }

    #[test]
    fn for_port_derives_loopback_urls() {
        let c = BrainConfig::for_port(
            PathBuf::from("x.mjs"),
            7777,
            PathBuf::from("/d"),
            "a".into(),
            "fp".into(),
            None,
        );
        assert_eq!(c.server_url, "https://127.0.0.1:7777");
        assert_eq!(c.bridge_url, "wss://127.0.0.1:7777/ws/v1/bridge");
        // No CA path → no NODE_EXTRA_CA_CERTS entry.
        assert!(!build_brain_env(&c, "t")
            .iter()
            .any(|(k, _)| k == "NODE_EXTRA_CA_CERTS"));
    }

    /// A missing entry script fails spawn, advances backoff, and the loop
    /// stops promptly on shutdown — no panic, no hot loop.
    #[tokio::test]
    async fn missing_entry_fails_spawn_and_stops_on_shutdown() {
        let config = test_config(
            PathBuf::from("Z:/definitely/not/here/brain.mjs"),
            Duration::from_millis(200),
        );
        let sup = BrainSupervisor::new(config, test_state());
        let handle = sup.start();

        tokio::time::sleep(Duration::from_millis(300)).await;
        let status = sup.status();
        assert!(!status.running);
        assert_eq!(status.restart_count, 0, "spawn never succeeded");

        sup.shutdown();
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("loop must stop on shutdown")
            .expect("join");
    }

    /// A child that exits immediately is respawned with escalating backoff;
    /// the restart counter climbs. Requires node; skips gracefully without.
    #[tokio::test]
    async fn exiting_child_is_respawned_with_backoff() {
        if !crate::external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }
        // Readiness rides the process-global ws_bridge watch — hold the slot
        // lock so concurrent ws_bridge tests can't flip it mid-test.
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        crate::companion_api::ws_bridge::test_support::clear_socket_for_testing();
        let tmp = tempfile::tempdir().expect("tempdir");
        let entry = tmp.path().join("exit-now.mjs");
        std::fs::write(&entry, "process.exit(3);\n").expect("write");

        let config = test_config(entry, Duration::from_secs(5));
        let sup = BrainSupervisor::new(config, test_state());
        let handle = sup.start();

        // First failure has zero backoff, second waits 250ms — within ~3s we
        // must observe at least 2 spawns.
        let mut spawns = 0;
        for _ in 0..60 {
            spawns = sup.status().restart_count;
            if spawns >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(spawns >= 2, "child must be respawned (saw {spawns})");

        sup.shutdown();
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("loop must stop on shutdown")
            .expect("join");
    }

    /// A child that never hellos is killed at the ready deadline and the
    /// supervisor moves on (restart counter climbs past it). Requires node.
    #[tokio::test]
    async fn never_ready_child_is_killed_by_the_watchdog() {
        if !crate::external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }
        // A concurrent ws_bridge test flipping READY would disarm the
        // watchdog under test — hold the slot lock for the duration.
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        crate::companion_api::ws_bridge::test_support::clear_socket_for_testing();
        let tmp = tempfile::tempdir().expect("tempdir");
        let entry = tmp.path().join("sleep-forever.mjs");
        std::fs::write(&entry, "setInterval(() => {}, 60_000);\n").expect("write");

        let config = test_config(entry, Duration::from_millis(300));
        let sup = BrainSupervisor::new(config, test_state());
        let handle = sup.start();

        let mut spawns = 0;
        for _ in 0..100 {
            spawns = sup.status().restart_count;
            if spawns >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            spawns >= 2,
            "watchdog must kill the never-ready child so it respawns (saw {spawns})"
        );

        sup.shutdown();
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("loop must stop on shutdown")
            .expect("join");
    }

    #[test]
    fn install_brain_round_trip() {
        // Only this test touches the global slot.
        assert!(brain_status().is_none());
        let sup = BrainSupervisor::new(
            test_config(PathBuf::from("x.mjs"), Duration::from_secs(1)),
            test_state(),
        );
        install_brain(Some(Arc::clone(&sup)));
        let status = brain_status().expect("installed");
        assert!(!status.running);
        install_brain(None);
        assert!(brain_status().is_none());
    }
}
