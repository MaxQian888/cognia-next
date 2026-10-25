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
//! Optional `COGNIA_COLLAB_URL` / `COGNIA_COLLAB_ORG_ID` are inherited by the
//! child as a pair; credentials are never forwarded and come from the CLI's
//! 0600 Logto session file. A multi-tenant server sets `COGNIA_COLLAB_URL`
//! alone for its own standing checks, which is not a brain collaboration
//! config, so the URL is withheld from the child unless the org id is set too
//! (see [`withhold_unpaired_collab_url`]).

use std::borrow::Cow;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{watch, Mutex};

use cognia_companion::jwt::issue_service_jwt;
use cognia_companion::{ws_bridge, SharedState};
use cognia_core::supervision_backoff::CrashBackoff;

/// Env var naming the brain entry script. Set by `Dockerfile.cognia-server`.
pub use cognia_companion::runtime::BRAIN_ENTRY_ENV;

/// How often the supervisor re-mints and pushes a fresh service token over
/// the bridge (tokens live 24h; refresh at half-life).
const TOKEN_REFRESH_INTERVAL: Duration = Duration::from_secs(12 * 3600);

/// Pause after a failed `spawn` attempt (binary missing etc.) so a
/// permanently-broken config doesn't hot-loop between backoff table entries.
const SPAWN_ERROR_PAUSE: Duration = Duration::from_secs(1);

/// Exit code of a brain the server refused (`BRAIN_REFUSED_EXIT_CODE` in
/// `cli/src/serve/protocol.ts`, EX_CONFIG).
pub const BRAIN_REFUSED_EXIT_CODE: i32 = 78;

/// How often a parked supervisor looks for a replaced brain entry.
const PARKED_ENTRY_POLL: Duration = Duration::from_secs(30);

/// How one child's run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildOutcome {
    /// Exited, crashed or was killed by the ready watchdog: respawn.
    Exited,
    /// The server refused it. This build will be refused again, so stop.
    Refused,
    /// Shutdown was requested.
    Shutdown,
}

/// What identifies the installed brain build: replacing it changes the
/// entry's size or modification time.
fn entry_identity(entry: &std::path::Path) -> Option<(u64, std::time::SystemTime)> {
    let meta = std::fs::metadata(entry).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

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
    /// `wss://127.0.0.1:<bound port>/internal/bridge`.
    pub bridge_url: String,
    pub data_dir: PathBuf,
    pub account_id: String,
    /// Stable 256-bit DEK from the encrypted server secret store. It is sent
    /// only through the child environment and never argv or logs.
    pub account_content_key: String,
    pub host_id: String,
    pub tls_fingerprint: String,
    /// Path to the companion `tls.pem`, exported as `NODE_EXTRA_CA_CERTS`
    /// so Node trusts the self-signed loopback cert.
    pub node_extra_ca_certs: Option<PathBuf>,
    /// How long a fresh child has to complete the bridge hello.
    pub ready_timeout: Duration,
    /// How often a parked supervisor looks for a replaced brain entry.
    pub parked_entry_poll: Duration,
}

impl BrainConfig {
    /// Standard config for a bound server port. `entry` comes from
    /// `COGNIA_BRAIN_ENTRY`.
    // The constructor deliberately names every credential/path field at the
    // process-spawn boundary so no security-sensitive value is defaulted.
    #[allow(clippy::too_many_arguments)]
    pub fn for_port(
        entry: PathBuf,
        port: u16,
        data_dir: PathBuf,
        account_id: String,
        account_content_key: String,
        host_id: String,
        tls_fingerprint: String,
        node_extra_ca_certs: Option<PathBuf>,
    ) -> Self {
        Self {
            entry,
            server_url: format!("https://127.0.0.1:{port}"),
            bridge_url: format!("wss://127.0.0.1:{port}/internal/bridge"),
            data_dir,
            account_id,
            account_content_key,
            host_id,
            tls_fingerprint,
            node_extra_ca_certs,
            ready_timeout: Duration::from_secs(90),
            parked_entry_poll: PARKED_ENTRY_POLL,
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
        (
            "COGNIA_ACCOUNT_CONTENT_KEY".to_string(),
            config.account_content_key.clone(),
        ),
        ("COGNIA_HOST_ID".to_string(), config.host_id.clone()),
    ];
    if let Some(pem) = &config.node_extra_ca_certs {
        env.push(("NODE_EXTRA_CA_CERTS".to_string(), pem.display().to_string()));
    }
    env
}

/// Whether to withhold `COGNIA_COLLAB_URL` from the brain child.
///
/// `cognia serve` refuses a URL without an org id (half a collaboration
/// endpoint), and a multi-tenant server always sets the URL for its own
/// collab standing checks. Inherited as is, that refusal crash-looped the
/// brain on every multi-tenant deploy that had no single collaboration org.
pub fn withhold_unpaired_collab_url(url: Option<&str>, org_id: Option<&str>) -> bool {
    let set = |value: Option<&str>| value.is_some_and(|value| !value.trim().is_empty());
    set(url) && !set(org_id)
}

/// Snapshot for `/healthz` — see [`brain_status`]. Defined by the companion
/// core, which reads it through `companion_api::runtime::BRAIN`.
pub use cognia_companion::runtime::BrainStatus;

/// Publish the supervisor so `/healthz` and `/metrics` can report the brain
/// without threading through `CompanionState` (same idiom as
/// `TLS_FINGERPRINT`). `None` clears it.
pub fn install_brain(supervisor: Option<Arc<BrainSupervisor>>) {
    use cognia_companion::runtime::BRAIN;
    match supervisor {
        Some(supervisor) => {
            BRAIN.set(supervisor);
        }
        None => {
            BRAIN.clear();
        }
    }
}

/// The installed supervisor's status, if any (`None` on desktop).
pub fn brain_status() -> Option<BrainStatus> {
    cognia_companion::runtime::brain_status()
}

impl cognia_companion::runtime::BrainProbe for BrainSupervisor {
    fn status(&self) -> BrainStatus {
        BrainSupervisor::status(self)
    }
}

pub struct BrainSupervisor {
    config: BrainConfig,
    person: bool,
    person_authority: Option<Arc<cognia_companion::person_partition::PersonBrainAuthority>>,
    /// Signing secret source for token minting (rotations picked up on the
    /// next spawn / refresh).
    state: SharedState,
    backoff: Mutex<CrashBackoff>,
    running: AtomicBool,
    /// Respawning stopped after a refusal (see [`ChildOutcome::Refused`]).
    parked: AtomicBool,
    restart_count: AtomicU64,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
}

#[derive(Debug, Default)]
struct ReadyWatchdog {
    fired: bool,
}

impl ReadyWatchdog {
    fn is_armed(&self, was_ready: bool) -> bool {
        !was_ready && !self.fired
    }

    fn mark_fired(&mut self) {
        self.fired = true;
    }
}

/// Level tags the brain can put in front of a line. `fatal` has no `log`
/// counterpart and collapses to `Error`, matching the frontend's mapping.
const BRAIN_LEVEL_TAGS: [(&str, log::Level); 6] = [
    ("TRACE", log::Level::Trace),
    ("DEBUG", log::Level::Debug),
    ("INFO", log::Level::Info),
    ("WARN", log::Level::Warn),
    ("ERROR", log::Level::Error),
    ("FATAL", log::Level::Error),
];

/// How far into a line a level tag may sit. Past that we would start eating
/// message text that merely happens to bracket a level word.
const BRAIN_TAG_SCAN_CHARS: usize = 48;

/// Drop ANSI escape sequences, borrowing when there are none.
///
/// A supervised child emits no colour — `packages/logging` yields the clock,
/// the icon and the colour the moment it sees a piped stdout — but
/// `FORCE_COLOR` is the documented way to keep colour in `docker logs`, and a
/// coloured line begins `\x1b[34m[INFO]\x1b[0m …`. The CSI introducer is
/// itself a `[`, so the tag scan below would pair it with the `]` of the real
/// tag, test `"34m[INFO"` against the level table, miss, and resume PAST the
/// tag — flattening every child line to the supervisor's default level with
/// the escapes still embedded.
fn strip_ansi(line: &str) -> Cow<'_, str> {
    if !line.contains('\x1b') {
        return Cow::Borrowed(line);
    }
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            out.push(ch);
            continue;
        }
        // CSI (`\x1b[`) runs to a final byte in `@`..=`~`. Any other escape is
        // two bytes, so dropping the introducer alone is enough.
        if let Some('[') = chars.next() {
            for c in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&c) {
                    break;
                }
            }
        }
    }
    Cow::Owned(out)
}

/// The level a line claims, and the byte offset its message starts at.
/// `None` when no bracketed group in the head names a level.
fn scan_brain_level(line: &str) -> Option<(log::Level, usize)> {
    let head_end = line
        .char_indices()
        .nth(BRAIN_TAG_SCAN_CHARS)
        .map_or(line.len(), |(index, _)| index);
    let mut cursor = 0usize;
    while cursor < head_end {
        let open = cursor + line[cursor..head_end].find('[')?;
        let close = open + line[open..head_end].find(']')?;
        if let Some((_, level)) = BRAIN_LEVEL_TAGS
            .iter()
            .find(|(name, _)| line[open + 1..close].eq_ignore_ascii_case(name))
        {
            return Some((*level, close + 1));
        }
        cursor = close + 1;
    }
    None
}

/// Split a child line into the level it claims and the message after it.
///
/// The brain runs `packages/logging`, which prints its own `[LEVEL]` tag —
/// and, on a terminal, a clock and an icon in front of it. Stamping the
/// supervisor's own `[INFO]` on top buried real child warnings and printed
/// two level tags per line (`[INFO] [brain] [3:34:42 PM] i [INFO] ...`), so
/// take the first bracketed group that names a level, drop everything up to
/// and including it, and report at that level. Untagged lines — the CLI's own
/// `serve: ...` writes — come back whole at `default_level`.
///
/// Colour is stripped first; see [`strip_ansi`] for why the scan cannot see it.
fn classify_brain_line(line: &str, default_level: log::Level) -> (log::Level, Cow<'_, str>) {
    let clean = strip_ansi(line);
    let Some((level, start)) = scan_brain_level(&clean) else {
        // Untagged lines come back byte-for-byte (minus colour): a `serve:`
        // write is the message, not a prefix around one.
        return (default_level, clean);
    };
    let message = match clean {
        Cow::Borrowed(text) => Cow::Borrowed(text[start..].trim_start()),
        Cow::Owned(text) => Cow::Owned(text[start..].trim_start().to_owned()),
    };
    (level, message)
}

impl BrainSupervisor {
    pub fn new(config: BrainConfig, state: SharedState) -> Arc<Self> {
        Self::with_profile(config, state, false)
    }

    pub fn new_person(config: BrainConfig, state: SharedState) -> Arc<Self> {
        Self::with_profile(config, state, true)
    }

    fn with_profile(config: BrainConfig, state: SharedState, person: bool) -> Arc<Self> {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        Arc::new(Self {
            person_authority: person.then(|| cognia_companion::person_partition::PersonBrainAuthority::new(config.account_id.clone())),
            config,
            person,
            state,
            backoff: Mutex::new(CrashBackoff::default()),
            running: AtomicBool::new(false),
            parked: AtomicBool::new(false),
            restart_count: AtomicU64::new(0),
            shutdown_tx,
            shutdown_rx,
        })
    }

    pub fn status(&self) -> BrainStatus {
        BrainStatus {
            running: self.running.load(Ordering::SeqCst),
            ready: self.ready(),
            restart_count: self.restart_count.load(Ordering::SeqCst),
            rss_bytes: if self.person { ws_bridge::account_rss_bytes(&self.config.account_id) } else { ws_bridge::brain_rss_bytes() },
            version: if self.person { None } else { ws_bridge::brain_hello().map(|h| h.brain_version) },
            refusal: if self.person { None } else { ws_bridge::brain_refusal() },
            parked: self.parked.load(Ordering::SeqCst),
        }
    }

    /// Signal the supervision loop to kill the child and stop respawning.
    pub fn shutdown(&self) {
        if let Some(authority) = &self.person_authority { authority.stop(); }
        let _ = self.shutdown_tx.send(true);
    }

    pub(crate) fn person_authority(&self) -> Option<Arc<cognia_companion::person_partition::PersonBrainAuthority>> {
        self.person_authority.clone()
    }

    async fn child_env(&self, token: &str) -> Vec<(String, String)> {
        let mut env = build_brain_env(&self.config, token);
        if self.person {
            env.push(("COGNIA_BRAIN_PROFILE".into(), "person".into()));
            env.push(("COGNIA_PERSON_CHAT".into(), "tool-less".into())); // P6c A-D Host contract.
            // P6d: Host capability advertisement. The TS brain deliberately
            // does not consume COGNIA_PERSON_EXECUTION until P6e (Rule 7).
            if cognia_companion::host_surface_gate::person_execution_available().await {
                env.push(("COGNIA_PERSON_EXECUTION".into(), "sandboxed".into()));
            }
        }
        env
    }

    fn mint_token(&self) -> Result<String, String> {
        let secret = self.state.secret.read().clone();
        let issued = if self.person {
            let generation = self.person_authority.as_ref().and_then(|authority| authority.current())
                .ok_or_else(|| "person child is not active".to_string())?;
            cognia_companion::jwt::issue_person_brain_jwt(&secret, &self.config.account_id, &generation)
        } else { issue_service_jwt(&secret, &self.config.account_id) };
        issued
            .map(|(token, _exp)| token)
            .map_err(|e| format!("failed to mint brain service token: {e}"))
    }

    pub fn is_stopping(&self) -> bool { *self.shutdown_rx.borrow() }

    fn ready(&self) -> bool {
        if self.person { ws_bridge::account_connected(&self.config.account_id) } else { ws_bridge::bridge_connected() }
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
                Ok((child, generation)) => {
                    let outcome = self.supervise_child(child, generation, &mut shutdown).await;
                    if outcome == ChildOutcome::Refused {
                        self.park(&mut shutdown).await;
                    }
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

    /// Stop respawning a brain the server refused, and wait for a different
    /// build: the brain entry is replaced (an update swapped it), or the
    /// process restarts. Respawning the same build would be refused for the
    /// same reason every time, so the supervisor reports the state instead
    /// of looping (ADR-0224 A10).
    async fn park(&self, shutdown: &mut watch::Receiver<bool>) {
        let installed = entry_identity(&self.config.entry);
        self.parked.store(true, Ordering::SeqCst);
        match ws_bridge::brain_refusal() {
            Some(refusal) => log::error!(
                "brain supervisor: the server refused the brain ({}): brain {} contract {}, \
                 server {} contract {}. Not respawning until the brain is replaced; update \
                 the host so its server and brain come from the same build",
                refusal.reason,
                refusal.brain.version,
                refusal.brain.contract_version,
                refusal.server.version,
                refusal.server.contract_version,
            ),
            None => log::error!(
                "brain supervisor: the brain exited because it does not match this server; \
                 not respawning until it is replaced"
            ),
        }
        loop {
            tokio::select! {
                _ = tokio::time::sleep(self.config.parked_entry_poll) => {
                    if entry_identity(&self.config.entry) != installed {
                        log::info!("brain supervisor: the brain entry changed; respawning");
                        break;
                    }
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        break;
                    }
                }
            }
        }
        self.parked.store(false, Ordering::SeqCst);
        self.backoff.lock().await.reset();
    }

    async fn spawn_once(&self) -> Result<(tokio::process::Child, Option<cognia_companion::person_partition::PersonChildGeneration>), String> {
        if !self.config.entry.exists() {
            return Err(format!(
                "brain entry not found at {} (check {BRAIN_ENTRY_ENV})",
                self.config.entry.display()
            ));
        }
        let node =
            cognia_core::node_runtime::node_executable().map_err(|error| error.to_string())?;
        let generation = self.person_authority.as_ref().and_then(|authority| authority.begin_child());
        let token = self.mint_token()?;
        let mut cmd = Command::new(&node);
        cmd.arg(&self.config.entry)
            .arg("serve")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd.env_remove("COGNIA_BRAIN_PROFILE");
        cmd.env_remove("COGNIA_PERSON_EXECUTION"); // P6d never inherit the operator environment.
        cmd.env_remove("COGNIA_PERSON_CHAT"); // P6c is advertised only by this supervisor.
        if withhold_unpaired_collab_url(
            std::env::var("COGNIA_COLLAB_URL").ok().as_deref(),
            std::env::var("COGNIA_COLLAB_ORG_ID").ok().as_deref(),
        ) {
            cmd.env_remove("COGNIA_COLLAB_URL");
        }
        for (k, v) in self.child_env(&token).await {
            cmd.env(k, v);
        }
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.spawn().map(|child| (child, generation)).map_err(|e| {
            format!(
                "failed to spawn brain with Node.js at {}: {e}",
                node.display()
            )
        })
    }

    async fn supervise_child(
        &self,
        mut child: tokio::process::Child,
        // Owned by this future: exit and cancellation invalidate authority
        // before run() can park, back off or start a successor.
        mut generation: Option<cognia_companion::person_partition::PersonChildGeneration>,
        shutdown: &mut watch::Receiver<bool>,
    ) -> ChildOutcome {
        self.running.store(true, Ordering::SeqCst);
        let mut refusals = ws_bridge::subscribe_refusals();
        refusals.mark_unchanged();
        let mut refused = false;
        let mut outcome = ChildOutcome::Exited;
        self.restart_count.fetch_add(1, Ordering::SeqCst);

        // Pipe child output to the server log, keeping the level the child
        // claimed instead of flattening every line to INFO.
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let (level, message) = classify_brain_line(&line, log::Level::Info);
                    log::log!(level, "[brain] {message}");
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    // Anything on stderr is a warning at minimum even when the
                    // child left it untagged; a tagged ERROR still lands as one.
                    let (level, message) = classify_brain_line(&line, log::Level::Warn);
                    log::log!(level.min(log::Level::Warn), "[brain.stderr] {message}");
                }
            });
        }

        let mut ready_rx = ws_bridge::subscribe_bridge_ready();
        let mut was_ready = self.ready();
        let mut person_ready_tick = tokio::time::interval(Duration::from_millis(50));
        let ready_deadline = tokio::time::sleep(self.config.ready_timeout);
        tokio::pin!(ready_deadline);
        let mut ready_watchdog = ReadyWatchdog::default();
        let mut refresh_ticker = tokio::time::interval(TOKEN_REFRESH_INTERVAL);
        refresh_ticker.tick().await; // consume the immediate tick

        loop {
            tokio::select! {
                status = child.wait() => {
                    // Revoke as soon as exit is observed, before any await
                    // while updating backoff or preparing the successor.
                    drop(generation.take());
                    match &status {
                        Ok(s) => log::warn!("brain exited: {s}"),
                        Err(e) => log::error!("brain wait error: {e}"),
                    }
                    if refused
                        || status
                            .as_ref()
                            .is_ok_and(|s| s.code() == Some(BRAIN_REFUSED_EXIT_CODE))
                    {
                        outcome = ChildOutcome::Refused;
                        break;
                    }
                    // Any exit is a failure for backoff purposes; a healthy
                    // run reset the counter at hello time, so a single crash
                    // after a long healthy run respawns immediately.
                    self.backoff.lock().await.note_failure(Instant::now());
                    break;
                }

                // The server refused this child. One built before it could
                // read `hello_refused` keeps reconnecting into the same
                // refusal, so stop it here instead of waiting out the
                // watchdog.
                changed = refusals.changed(), if !self.person && !refused && !was_ready => {
                    if changed.is_err() || ws_bridge::brain_refusal().is_none() {
                        continue;
                    }
                    refused = true;
                    let _ = child.start_kill();
                    // Loop continues; child.wait() observes the kill.
                }

                changed = ready_rx.changed(), if !self.person && !was_ready => {
                    if changed.is_err() {
                        continue;
                    }
                    if *ready_rx.borrow() {
                        was_ready = true;
                        self.backoff.lock().await.reset();
                        log::info!("brain supervisor: bridge hello received — brain ready");
                    }
                }

                _ = person_ready_tick.tick(), if self.person && !was_ready => {
                    if self.ready() { was_ready = true; self.backoff.lock().await.reset(); }
                }

                _ = &mut ready_deadline, if ready_watchdog.is_armed(was_ready) => {
                    drop(generation.take());
                    ready_watchdog.mark_fired();
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
                            let refreshed = if self.person { ws_bridge::send_account_token_refresh(&self.config.account_id, token) }
                                else { ws_bridge::send_token_refresh(token) };
                            if let Err(e) = refreshed {
                                log::warn!("brain supervisor: token refresh not delivered: {e}");
                            }
                        }
                        Err(e) => log::error!("brain supervisor: token re-mint failed: {e}"),
                    }
                }

                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        drop(generation.take());
                        log::info!("brain supervisor: shutdown — killing brain");
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        outcome = ChildOutcome::Shutdown;
                        break;
                    }
                }
            }
        }

        self.running.store(false, Ordering::SeqCst);
        outcome
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use cognia_companion::{
        deny_list::DenyList, desktop_messages_bridge::DesktopMessagesBridge,
        desktop_writes_bridge::DesktopWritesBridge, event_bus::EventBus,
        idempotency::IdempotencyCache, push::PushTokenRegistry, rate_limit::RateLimiter,
        sync_bridge::SyncBridge, sync_registry::SyncTableRegistry, CompanionState,
    };
    use parking_lot::RwLock;

    pub(crate) fn test_state() -> SharedState {
        Arc::new(CompanionState {
            secret: RwLock::new(b"test-secret-32-bytes-exactly____".to_vec()),
            deny_list: Arc::new(DenyList::new()),
            renderer: None,
            runtime: cognia_companion::runtime::unwired(),
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

    pub(crate) fn test_config(entry: PathBuf, ready_timeout: Duration) -> BrainConfig {
        BrainConfig {
            entry,
            server_url: "https://127.0.0.1:7890".into(),
            bridge_url: "wss://127.0.0.1:7890/internal/bridge".into(),
            data_dir: PathBuf::from("/data"),
            account_id: "local_acct_a".into(),
            account_content_key: "11".repeat(32),
            host_id: "host-test".into(),
            tls_fingerprint: "ff00".into(),
            node_extra_ca_certs: Some(PathBuf::from("/data/cognia/companion/tls.pem")),
            ready_timeout,
            parked_entry_poll: Duration::from_millis(50),
        }
    }

    #[test]
    fn a_collab_url_reaches_the_brain_only_with_its_org_id() {
        assert!(withhold_unpaired_collab_url(Some("http://collab:8080"), None));
        assert!(withhold_unpaired_collab_url(Some("http://collab:8080"), Some("  ")));
        assert!(!withhold_unpaired_collab_url(Some("http://collab:8080"), Some("org_acme")));
        assert!(!withhold_unpaired_collab_url(None, None));
        assert!(!withhold_unpaired_collab_url(Some(""), None));
        // An org id alone stays: `cognia serve` names that misconfiguration.
        assert!(!withhold_unpaired_collab_url(None, Some("org_acme")));
    }

    #[tokio::test]
    async fn p6d_execution_advertisement_requires_conforming_pool_and_is_person_only() {
        use cognia_companion::{environment_pool, host_surface_gate};
        let _slot = ws_bridge::test_support::lock_slot().await;
        struct Restore(Option<environment_pool::PoolServices>, Option<std::ffi::OsString>, Option<std::ffi::OsString>);
        impl Drop for Restore { fn drop(&mut self) {
            environment_pool::uninstall(); if let Some(pool) = self.0.take() { environment_pool::install(pool); }
            for (key, value) in [("COGNIA_EXECUTION",self.1.take()),("COGNIA_PERSON_EXECUTION",self.2.take())] {
                match value { Some(value) => unsafe { std::env::set_var(key,value) }, None => unsafe { std::env::remove_var(key) } }
            }
        } }
        let _restore = Restore(environment_pool::installed(),std::env::var_os("COGNIA_EXECUTION"),std::env::var_os("COGNIA_PERSON_EXECUTION"));
        unsafe { std::env::set_var("COGNIA_EXECUTION","enabled"); std::env::set_var("COGNIA_PERSON_EXECUTION","forged-parent"); }
        let config = test_config(PathBuf::from("brain.mjs"), Duration::from_secs(1));
        let operator = BrainSupervisor::new(config.clone(),test_state());
        let person = BrainSupervisor::new_person(config,test_state());
        let advertised = |env: Vec<(String,String)>| env.into_iter().find(|(key,_)| key == "COGNIA_PERSON_EXECUTION").map(|(_,value)| value);
        environment_pool::uninstall();
        assert_eq!(advertised(person.child_env("token").await),None);
        environment_pool::install(environment_pool::person_pool_test_support(vec![serde_json::from_value(serde_json::json!("container")).unwrap()]));
        assert!(!host_surface_gate::person_execution_available().await);
        assert_eq!(advertised(person.child_env("token").await),None);
        // The tier helper pins VM/container as insufficient for this local path.
        environment_pool::install(environment_pool::person_pool_test_support(vec![
            serde_json::from_value(serde_json::json!("gvisor")).unwrap()]));
        assert_eq!(advertised(person.child_env("token").await),Some("sandboxed".into()));
        assert_eq!(advertised(operator.child_env("token").await),None);
        environment_pool::install(environment_pool::person_remote_pool_test_support(vec![
            serde_json::from_value(serde_json::json!("gvisor")).unwrap()]));
        assert!(!host_surface_gate::person_execution_available().await);
        assert_eq!(advertised(person.child_env("token").await),None);
        environment_pool::install(environment_pool::person_pool_test_support(vec![
            serde_json::from_value(serde_json::json!("gvisor")).unwrap()]));
        unsafe { std::env::set_var("COGNIA_EXECUTION","disabled"); }
        assert_eq!(advertised(person.child_env("token").await),None);
        assert!(include_str!("brain.rs").contains("cmd.env_remove(\"COGNIA_PERSON_EXECUTION\")"));
    }

    #[tokio::test]
    async fn p6c_person_supervisor_advertises_tool_less_chat_with_distinct_scope_and_profile() {
        let _slot = ws_bridge::test_support::lock_slot().await;
        let config = test_config(PathBuf::from("brain.mjs"), Duration::from_secs(1));
        let state = test_state();
        let operator = BrainSupervisor::new(config.clone(), state.clone());
        assert_eq!(operator.child_env("token").await, build_brain_env(&config, "token"));
        let person = BrainSupervisor::new_person(config.clone(), state);
        let _generation = person.person_authority().unwrap().begin_child().unwrap();
        let mut expected = build_brain_env(&config, "token");
        expected.push(("COGNIA_BRAIN_PROFILE".into(), "person".into()));
        expected.push(("COGNIA_PERSON_CHAT".into(), "tool-less".into()));
        assert_eq!(person.child_env("token").await, expected);
        let token = person.mint_token().unwrap();
        assert!(cognia_companion::jwt::verify(&person.state.secret.read(), &token, "service").is_err());
        assert_eq!(cognia_companion::jwt::verify(&person.state.secret.read(), &token, "person-brain").unwrap().account_id, Some(config.account_id));
    }

    #[tokio::test]
    async fn p5_child_tokens_and_refresh_are_fenced_per_start_and_crash_respawn() {
        let _slot = ws_bridge::test_support::lock_slot().await;
        let config = test_config(PathBuf::from("missing-brain.mjs"), Duration::from_secs(1));
        let supervisor = BrainSupervisor::new_person(config.clone(), test_state());
        let authority = supervisor.person_authority().unwrap();
        let first_child = authority.begin_child().unwrap();
        let decode = |token: &str| cognia_companion::jwt::verify_person_brain(&supervisor.state.secret.read(), token).unwrap();
        let first = decode(&supervisor.mint_token().unwrap());
        let refresh = decode(&supervisor.mint_token().unwrap());
        assert_eq!(first.generation, refresh.generation);
        assert!(authority.accepts(&first.generation));
        // This guard is also dropped by run() on crash, watchdog kill and
        // cancelled supervision, before the backoff/respawn path.
        drop(first_child);
        assert!(!authority.accepts(&first.generation));
        assert!(supervisor.mint_token().is_err());
        let _second_child = authority.begin_child().unwrap();
        let second = decode(&supervisor.mint_token().unwrap());
        assert_ne!(second.generation, first.generation);
        assert!(!authority.accepts(&first.generation));
        assert_eq!(second.generation, decode(&supervisor.mint_token().unwrap()).generation);
        supervisor.shutdown();
        assert!(!authority.accepts(&second.generation));
        assert!(authority.begin_child().is_none(), "shutdown cannot race a new spawn into authority");
        let restarted = BrainSupervisor::new_person(config, test_state());
        let _new_child = restarted.person_authority().unwrap().begin_child().unwrap();
        let token = cognia_companion::jwt::verify_person_brain(&restarted.state.secret.read(), &restarted.mint_token().unwrap()).unwrap();
        assert_ne!(token.generation, second.generation, "persisted content key cannot revive a token on server restart");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn p5_exited_child_invalidates_auth_before_crash_respawn() {
        let _slot = ws_bridge::test_support::lock_slot().await;
        let supervisor = BrainSupervisor::new_person(test_config(PathBuf::from("unused"), Duration::from_secs(1)), test_state());
        let authority = supervisor.person_authority().unwrap();
        let child_generation = authority.begin_child().unwrap();
        let token = cognia_companion::jwt::verify_person_brain(&supervisor.state.secret.read(), &supervisor.mint_token().unwrap()).unwrap();
        let child = Command::new("/bin/sh").arg("-c").arg("exit 7").kill_on_drop(true).spawn().unwrap();
        let mut shutdown = supervisor.shutdown_rx.clone();
        assert_eq!(supervisor.supervise_child(child, Some(child_generation), &mut shutdown).await, ChildOutcome::Exited);
        assert!(!authority.accepts(&token.generation));
        let _respawn = authority.begin_child().unwrap();
        assert!(!authority.accepts(&token.generation));
        let refresh = cognia_companion::jwt::verify_person_brain(&supervisor.state.secret.read(), &supervisor.mint_token().unwrap()).unwrap();
        assert_ne!(refresh.generation, token.generation);
    }

    #[test]
    fn ready_watchdog_disarms_after_its_first_timeout() {
        let mut watchdog = ReadyWatchdog::default();

        assert!(watchdog.is_armed(false));
        watchdog.mark_fired();
        assert!(!watchdog.is_armed(false));
        assert!(!watchdog.is_armed(true));
    }

    #[test]
    fn build_brain_env_matches_the_canonical_contract() {
        let config = test_config(PathBuf::from("brain.mjs"), Duration::from_secs(90));
        let env = build_brain_env(&config, "tok-123");
        let expected_content_key = "11".repeat(32);
        let get = |k: &str| {
            env.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("COGNIA_SERVER_URL"), Some("https://127.0.0.1:7890"));
        assert_eq!(get("COGNIA_SERVICE_TOKEN"), Some("tok-123"));
        assert_eq!(
            get("COGNIA_BRIDGE_URL"),
            Some("wss://127.0.0.1:7890/internal/bridge")
        );
        assert_eq!(get("COGNIA_TLS_FINGERPRINT"), Some("ff00"));
        assert_eq!(get("COGNIA_LOCAL_ACCOUNT_ID"), Some("local_acct_a"));
        assert_eq!(
            get("COGNIA_ACCOUNT_CONTENT_KEY"),
            Some(expected_content_key.as_str())
        );
        assert_eq!(get("COGNIA_HOST_ID"), Some("host-test"));
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
            "22".repeat(32),
            "host-a".into(),
            "fp".into(),
            None,
        );
        assert_eq!(c.server_url, "https://127.0.0.1:7777");
        assert_eq!(c.bridge_url, "wss://127.0.0.1:7777/internal/bridge");
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
        if !cognia_external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }
        // Readiness rides the process-global ws_bridge watch — hold the slot
        // lock so concurrent ws_bridge tests can't flip it mid-test.
        let _guard = cognia_companion::ws_bridge::test_support::lock_slot().await;
        cognia_companion::ws_bridge::test_support::clear_socket_for_testing();
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
        if !cognia_external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }
        // A concurrent ws_bridge test flipping READY would disarm the
        // watchdog under test — hold the slot lock for the duration.
        let _guard = cognia_companion::ws_bridge::test_support::lock_slot().await;
        cognia_companion::ws_bridge::test_support::clear_socket_for_testing();
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

    /// Wait until `done(status)` holds, or fail after ~5 s.
    async fn wait_for(sup: &BrainSupervisor, what: &str, done: impl Fn(&BrainStatus) -> bool) {
        for _ in 0..100 {
            if done(&sup.status()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed out waiting for: {what} (status {:?})", sup.status());
    }

    /// A brain that exits with the refusal code is not respawned into the
    /// same refusal: the supervisor parks, and a replaced entry wakes it.
    /// Requires node.
    #[tokio::test]
    async fn a_refused_brain_parks_the_supervisor_until_the_brain_is_replaced() {
        if !cognia_external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }
        let _guard = cognia_companion::ws_bridge::test_support::lock_slot().await;
        cognia_companion::ws_bridge::test_support::clear_socket_for_testing();
        cognia_companion::ws_bridge::test_support::clear_refusal_for_testing();
        let tmp = tempfile::tempdir().expect("tempdir");
        let entry = tmp.path().join("refused.mjs");
        std::fs::write(
            &entry,
            format!("process.exit({BRAIN_REFUSED_EXIT_CODE});\n"),
        )
        .expect("write");

        let sup = BrainSupervisor::new(
            test_config(entry.clone(), Duration::from_secs(5)),
            test_state(),
        );
        let handle = sup.start();
        wait_for(&sup, "parked after the refusal", |s| s.parked).await;
        // Well past the zero-backoff respawn: still one spawn.
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            sup.status().restart_count,
            1,
            "a refused build is not respawned"
        );
        assert!(!sup.status().running);

        // An update replaces the brain: the supervisor tries the new build.
        std::fs::write(&entry, "setInterval(() => {}, 60_000); // a newer build\n")
            .expect("rewrite");
        wait_for(&sup, "respawned after the entry changed", |s| {
            s.restart_count >= 2 && !s.parked
        })
        .await;

        sup.shutdown();
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("loop must stop on shutdown")
            .expect("join");
    }

    /// A brain from before `hello_refused` keeps reconnecting after the
    /// server refuses it; the supervisor stops it at the refusal instead of
    /// waiting out the ready watchdog, and parks. Requires node.
    #[tokio::test]
    async fn a_refusal_stops_a_brain_that_would_keep_reconnecting() {
        if !cognia_external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }
        let _guard = cognia_companion::ws_bridge::test_support::lock_slot().await;
        cognia_companion::ws_bridge::test_support::clear_socket_for_testing();
        cognia_companion::ws_bridge::test_support::clear_refusal_for_testing();
        let tmp = tempfile::tempdir().expect("tempdir");
        let entry = tmp.path().join("reconnects-forever.mjs");
        std::fs::write(&entry, "setInterval(() => {}, 60_000);\n").expect("write");

        // A watchdog far longer than the test: only the refusal can stop it.
        let sup = BrainSupervisor::new(test_config(entry, Duration::from_secs(60)), test_state());
        let handle = sup.start();
        wait_for(&sup, "child running", |s| s.running).await;

        cognia_companion::ws_bridge::test_support::refuse_for_testing("contract_mismatch");
        wait_for(&sup, "parked after the refusal", |s| s.parked && !s.running).await;
        let status = sup.status();
        assert_eq!(status.restart_count, 1);
        assert_eq!(
            status.refusal.expect("refusal reported").reason,
            "contract_mismatch"
        );

        sup.shutdown();
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("loop must stop on shutdown")
            .expect("join");
        cognia_companion::ws_bridge::test_support::clear_refusal_for_testing();
    }

    #[test]
    fn a_bare_level_tag_sets_the_level_and_is_stripped() {
        let (level, message) =
            classify_brain_line("[WARN] [scheduler] queue is backed up", log::Level::Info);
        assert_eq!(level, log::Level::Warn);
        assert_eq!(message, "[scheduler] queue is backed up");
    }

    #[test]
    fn a_clock_and_icon_in_front_of_the_tag_are_stripped_too() {
        // What `packages/logging` prints when it thinks it owns a terminal.
        let (level, message) = classify_brain_line(
            "[3:34:42 PM] \u{2139}\u{fe0f} [INFO] [scheduler] Registered executor for task type: chat",
            log::Level::Warn,
        );
        assert_eq!(level, log::Level::Info);
        assert_eq!(
            message,
            "[scheduler] Registered executor for task type: chat"
        );
    }

    #[test]
    fn fatal_collapses_to_error() {
        let (level, message) = classify_brain_line("[FATAL] vault unreachable", log::Level::Info);
        assert_eq!(level, log::Level::Error);
        assert_eq!(message, "vault unreachable");
    }

    #[test]
    fn an_untagged_line_keeps_its_text_and_the_default_level() {
        // The CLI's own `serve:` writes carry no tag and must survive whole.
        let (level, message) = classify_brain_line(
            "serve: headless runtime started: a2ui-dispatch",
            log::Level::Info,
        );
        assert_eq!(level, log::Level::Info);
        assert_eq!(message, "serve: headless runtime started: a2ui-dispatch");

        let (level, message) = classify_brain_line("node:internal/errors stack", log::Level::Warn);
        assert_eq!(level, log::Level::Warn);
        assert_eq!(message, "node:internal/errors stack");
    }

    #[test]
    fn a_level_word_deep_in_the_message_is_not_a_tag() {
        let line =
            "serve: retry budget exhausted while draining the outbound queue, [INFO] follows";
        let (level, message) = classify_brain_line(line, log::Level::Info);
        assert_eq!(level, log::Level::Info);
        assert_eq!(message, line, "the message must not be truncated");
    }

    #[test]
    fn colour_does_not_hide_the_level_tag() {
        // `FORCE_COLOR` (the documented way to keep colour in `docker logs`)
        // makes the child paint its own tag. The CSI introducer is a `[`, so
        // an unstripped scan pairs it with the tag's `]` and walks past it.
        let (level, message) = classify_brain_line(
            "\x1b[31m[ERROR]\x1b[0m [gateway] upstream refused",
            log::Level::Info,
        );
        assert_eq!(level, log::Level::Error);
        assert_eq!(message, "[gateway] upstream refused");
    }

    #[test]
    fn stderr_lines_never_drop_below_warn() {
        // The supervisor floors stderr at WARN; an INFO tag must not demote it,
        // and an ERROR tag must still come through as an error.
        let (info, _) = classify_brain_line("[INFO] noise on stderr", log::Level::Warn);
        assert_eq!(info.min(log::Level::Warn), log::Level::Warn);
        let (error, _) = classify_brain_line("[ERROR] spawn failed", log::Level::Warn);
        assert_eq!(error.min(log::Level::Warn), log::Level::Error);
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
