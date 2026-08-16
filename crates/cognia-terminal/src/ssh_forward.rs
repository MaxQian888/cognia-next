//! SSH port-forwarding rules and the live state the renderer reads back.
//!
//! Everything here is synchronous bookkeeping: the shapes that cross the wire,
//! the validation the native side refuses to skip, and the registry that tracks
//! what each rule is actually doing. The tasks that bind sockets and pump bytes
//! live next door in [`crate::ssh`], which owns the russh handle they need.
//!
//! Two invariants are enforced here rather than left to configuration:
//!
//! * **Both ends bind loopback.** [`FORWARD_BIND_ADDRESS`] is a constant, not a
//!   field. A `-L` rule reachable from the LAN would relay strangers onto the
//!   remote network, and a `-R` rule bound to `0.0.0.0` would expose this
//!   machine to everyone who can reach the server — including when the server
//!   has `GatewayPorts` on, which is exactly when the user is least likely to
//!   know.
//! * **Rules fail closed.** `enabled` is a plain `bool` with `#[serde(default)]`,
//!   so a rule that arrives without the field is off, and a rule the user turned
//!   off is dropped by the renderer before it ever reaches this process.

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

/// The only address a forward ever binds, at either end. See the module docs.
pub const FORWARD_BIND_ADDRESS: &str = "127.0.0.1";

/// Bastions a jump chain may traverse before the target.
pub const MAX_JUMP_DEPTH: usize = 5;

/// A local forward (`-L`): this machine listens, the server dials out.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalForward {
    pub id: String,
    pub local_port: u16,
    /// Resolved by the SSH server, not by this machine.
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub enabled: bool,
}

/// A remote forward (`-R`): the server listens, this machine dials out.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteForward {
    pub id: String,
    pub remote_port: u16,
    pub local_host: String,
    pub local_port: u16,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ForwardDirection {
    Local,
    Remote,
}

/// What a rule is doing right now, as opposed to what it was asked to do.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ForwardRunState {
    /// Switched off. No socket is bound and nothing is queued.
    Stopped,
    /// Switched on, not yet bound or not yet accepted by the server.
    Starting,
    /// Carrying traffic: a bound local listener, or a forward the server took.
    Listening,
    /// On, but the SSH connection is down. A `-L` listener stays bound and
    /// queues callers; a `-R` forward is gone until the server is asked again.
    Waiting,
    /// The port could not be bound, or the server refused the forward.
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatus {
    pub id: String,
    pub direction: ForwardDirection,
    /// Human-readable endpoints, already loopback-qualified.
    pub summary: String,
    pub enabled: bool,
    pub state: ForwardRunState,
    pub active_connections: u32,
    /// Callers accepted locally that are still waiting for the link to return.
    pub queued_connections: u32,
    pub error: Option<String>,
}

fn valid_port(port: u16) -> bool {
    port != 0
}

fn valid_host(host: &str) -> bool {
    !host.trim().is_empty() && !host.chars().any(char::is_whitespace)
}

/// Reject rule sets that could not be honoured, before a socket is touched.
///
/// Duplicate ports are rejected rather than deduplicated: two rules claiming one
/// port means the user believes both are in effect, and silently dropping one
/// would send traffic somewhere they did not intend.
pub fn validate_local_forwards(rules: &[LocalForward]) -> Result<(), String> {
    let mut seen = Vec::with_capacity(rules.len());
    for rule in rules {
        if rule.id.trim().is_empty() {
            return Err("SSH local forward is missing an identifier".into());
        }
        if !valid_port(rule.local_port) || !valid_port(rule.remote_port) {
            return Err(format!("SSH local forward {} has an invalid port", rule.id));
        }
        if !valid_host(&rule.remote_host) {
            return Err(format!(
                "SSH local forward {} has an invalid destination host",
                rule.id
            ));
        }
        if seen.contains(&rule.local_port) {
            return Err(format!(
                "SSH local port {} is claimed by more than one forward",
                rule.local_port
            ));
        }
        seen.push(rule.local_port);
    }
    Ok(())
}

pub fn validate_remote_forwards(rules: &[RemoteForward]) -> Result<(), String> {
    let mut seen = Vec::with_capacity(rules.len());
    for rule in rules {
        if rule.id.trim().is_empty() {
            return Err("SSH remote forward is missing an identifier".into());
        }
        if !valid_port(rule.remote_port) || !valid_port(rule.local_port) {
            return Err(format!(
                "SSH remote forward {} has an invalid port",
                rule.id
            ));
        }
        if !valid_host(&rule.local_host) {
            return Err(format!(
                "SSH remote forward {} has an invalid destination host",
                rule.id
            ));
        }
        if seen.contains(&rule.remote_port) {
            return Err(format!(
                "SSH remote port {} is claimed by more than one forward",
                rule.remote_port
            ));
        }
        seen.push(rule.remote_port);
    }
    Ok(())
}

pub fn describe_local_forward(rule: &LocalForward) -> String {
    format!(
        "{FORWARD_BIND_ADDRESS}:{} \u{2192} {}:{}",
        rule.local_port, rule.remote_host, rule.remote_port
    )
}

pub fn describe_remote_forward(rule: &RemoteForward) -> String {
    format!(
        "remote {FORWARD_BIND_ADDRESS}:{} \u{2192} {}:{}",
        rule.remote_port, rule.local_host, rule.local_port
    )
}

#[derive(Debug, Clone)]
struct RuleRuntime {
    id: String,
    direction: ForwardDirection,
    summary: String,
    enabled: bool,
    state: ForwardRunState,
    active: u32,
    queued: u32,
    error: Option<String>,
}

impl RuleRuntime {
    fn snapshot(&self) -> ForwardStatus {
        ForwardStatus {
            id: self.id.clone(),
            direction: self.direction,
            summary: self.summary.clone(),
            enabled: self.enabled,
            state: self.state,
            active_connections: self.active,
            queued_connections: self.queued,
            error: self.error.clone(),
        }
    }
}

#[derive(Debug, Default)]
struct RegistryState {
    /// Declaration order is the display order, so a plain vector beats a map.
    rules: Vec<RuleRuntime>,
    /// Remote listening port to the rule that claims it, for the inbound
    /// `forwarded-tcpip` callback which knows nothing but the port.
    remote_targets: HashMap<u16, RemoteForward>,
}

/// The live view of a session's forwards, shared between the supervisor task,
/// the per-connection tasks, and whoever answers a status query.
///
/// A single mutex guards it all. The critical sections are counter bumps and a
/// vector scan over a handful of rules, and the alternative — a lock per rule —
/// would make a consistent snapshot impossible, which is the one thing the
/// status query needs.
#[derive(Debug)]
pub struct ForwardRegistry {
    state: StdMutex<RegistryState>,
    /// Bumped whenever the desired enabled-set changes, so the supervisor can
    /// wake without polling.
    control: watch::Sender<u64>,
}

impl ForwardRegistry {
    pub fn new(local: &[LocalForward], remote: &[RemoteForward]) -> Self {
        let mut rules: Vec<RuleRuntime> = Vec::with_capacity(local.len() + remote.len());
        let mut remote_targets = HashMap::new();
        for rule in local {
            rules.push(RuleRuntime {
                id: rule.id.clone(),
                direction: ForwardDirection::Local,
                summary: describe_local_forward(rule),
                enabled: rule.enabled,
                state: if rule.enabled {
                    ForwardRunState::Starting
                } else {
                    ForwardRunState::Stopped
                },
                active: 0,
                queued: 0,
                error: None,
            });
        }
        for rule in remote {
            rules.push(RuleRuntime {
                id: rule.id.clone(),
                direction: ForwardDirection::Remote,
                summary: describe_remote_forward(rule),
                enabled: rule.enabled,
                state: if rule.enabled {
                    ForwardRunState::Starting
                } else {
                    ForwardRunState::Stopped
                },
                active: 0,
                queued: 0,
                error: None,
            });
            remote_targets.insert(rule.remote_port, rule.clone());
        }
        Self {
            state: StdMutex::new(RegistryState {
                rules,
                remote_targets,
            }),
            control: watch::channel(0).0,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.lock().rules.is_empty()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.control.subscribe()
    }

    pub fn status(&self) -> Vec<ForwardStatus> {
        self.lock()
            .rules
            .iter()
            .map(RuleRuntime::snapshot)
            .collect()
    }

    /// Record the user's intent. Applying it is the supervisor's job, so the
    /// rule flips to `Starting`/`Stopped` here and reaches its real state once
    /// the socket has actually been bound or dropped.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        {
            let mut state = self.lock();
            let Some(rule) = state.rules.iter_mut().find(|rule| rule.id == id) else {
                return Err(format!("unknown SSH forward {id}"));
            };
            if rule.enabled == enabled {
                return Ok(());
            }
            rule.enabled = enabled;
            rule.error = None;
            rule.state = if enabled {
                ForwardRunState::Starting
            } else {
                rule.active = 0;
                rule.queued = 0;
                ForwardRunState::Stopped
            };
        }
        self.control.send_modify(|generation| *generation += 1);
        Ok(())
    }

    pub fn enabled_ids(&self, direction: ForwardDirection) -> Vec<String> {
        self.lock()
            .rules
            .iter()
            .filter(|rule| rule.direction == direction && rule.enabled)
            .map(|rule| rule.id.clone())
            .collect()
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        self.lock()
            .rules
            .iter()
            .any(|rule| rule.id == id && rule.enabled)
    }

    /// The rule that owns an inbound `forwarded-tcpip` on `remote_port`, or
    /// `None` when the port is unclaimed or its rule is switched off — an
    /// unsolicited channel is rejected rather than dialled.
    pub fn remote_target(&self, remote_port: u16) -> Option<RemoteForward> {
        let state = self.lock();
        let rule = state.remote_targets.get(&remote_port)?;
        state
            .rules
            .iter()
            .any(|candidate| candidate.id == rule.id && candidate.enabled)
            .then(|| rule.clone())
    }

    pub fn mark(&self, id: &str, next: ForwardRunState, error: Option<String>) {
        let mut state = self.lock();
        if let Some(rule) = state.rules.iter_mut().find(|rule| rule.id == id) {
            rule.state = next;
            rule.error = error;
        }
    }

    fn adjust(&self, id: &str, apply: impl FnOnce(&mut RuleRuntime)) {
        let mut state = self.lock();
        if let Some(rule) = state.rules.iter_mut().find(|rule| rule.id == id) {
            apply(rule);
        }
    }

    pub fn connection_queued(&self, id: &str) {
        self.adjust(id, |rule| rule.queued = rule.queued.saturating_add(1));
    }

    /// A queued caller either got its channel or gave up; either way it stops
    /// being queued.
    pub fn connection_dequeued(&self, id: &str) {
        self.adjust(id, |rule| rule.queued = rule.queued.saturating_sub(1));
    }

    pub fn connection_opened(&self, id: &str) {
        self.adjust(id, |rule| rule.active = rule.active.saturating_add(1));
    }

    pub fn connection_closed(&self, id: &str) {
        self.adjust(id, |rule| rule.active = rule.active.saturating_sub(1));
    }

    /// The link is back and this rule's socket survived the outage, so it is
    /// carrying traffic again. A rule that failed to bind in the first place
    /// keeps its failure — a reconnect does not make a taken port free.
    pub fn resume(&self, id: &str) {
        self.adjust(id, |rule| {
            if rule.state == ForwardRunState::Waiting {
                rule.state = ForwardRunState::Listening;
            }
        });
    }

    /// The SSH link went away. Local listeners survive and keep queueing, so
    /// they report `Waiting`; remote forwards died with the connection and are
    /// re-requested when it returns.
    pub fn connection_lost(&self) {
        let mut state = self.lock();
        for rule in state.rules.iter_mut().filter(|rule| rule.enabled) {
            rule.active = 0;
            if rule.direction == ForwardDirection::Remote {
                rule.queued = 0;
            }
            if rule.state != ForwardRunState::Failed {
                rule.state = ForwardRunState::Waiting;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(id: &str, port: u16) -> LocalForward {
        LocalForward {
            id: id.into(),
            local_port: port,
            remote_host: "db.internal".into(),
            remote_port: 5432,
            enabled: true,
        }
    }

    fn remote(id: &str, port: u16) -> RemoteForward {
        RemoteForward {
            id: id.into(),
            remote_port: port,
            local_host: "localhost".into(),
            local_port: 3000,
            enabled: true,
        }
    }

    #[test]
    fn rules_arriving_without_the_enabled_flag_stay_off() {
        // The renderer drops disabled rules before sending, so a rule that
        // reaches this process should be on. A payload missing the field is a
        // shape we did not write, and the safe reading is "not requested".
        let rule: LocalForward = serde_json::from_str(
            r#"{"id":"lfwd-1","localPort":8080,"remoteHost":"db","remotePort":5432}"#,
        )
        .expect("local forward parses");
        assert!(!rule.enabled);

        let rule: RemoteForward = serde_json::from_str(
            r#"{"id":"rfwd-1","remotePort":8080,"localHost":"localhost","localPort":3000}"#,
        )
        .expect("remote forward parses");
        assert!(!rule.enabled);
    }

    #[test]
    fn duplicate_ports_are_rejected_rather_than_silently_deduplicated() {
        assert!(validate_local_forwards(&[local("a", 8080), local("b", 9090)]).is_ok());
        let error = validate_local_forwards(&[local("a", 8080), local("b", 8080)]).unwrap_err();
        assert!(error.contains("8080"), "{error}");

        assert!(validate_remote_forwards(&[remote("a", 1), remote("b", 2)]).is_ok());
        let error = validate_remote_forwards(&[remote("a", 7), remote("b", 7)]).unwrap_err();
        assert!(error.contains('7'), "{error}");
    }

    #[test]
    fn invalid_ports_and_hosts_are_refused() {
        let mut rule = local("a", 0);
        assert!(validate_local_forwards(&[rule.clone()]).is_err());

        rule = local("a", 8080);
        rule.remote_port = 0;
        assert!(validate_local_forwards(&[rule.clone()]).is_err());

        rule = local("a", 8080);
        rule.remote_host = "bad host".into();
        assert!(validate_local_forwards(&[rule.clone()]).is_err());

        rule = local("a", 8080);
        rule.id = "  ".into();
        assert!(validate_local_forwards(&[rule]).is_err());

        let mut rule = remote("a", 0);
        assert!(validate_remote_forwards(&[rule.clone()]).is_err());
        rule = remote("a", 8080);
        rule.local_host = String::new();
        assert!(validate_remote_forwards(&[rule]).is_err());
    }

    #[test]
    fn summaries_name_the_loopback_bind_so_the_ui_cannot_imply_a_wider_one() {
        assert_eq!(
            describe_local_forward(&local("a", 8080)),
            "127.0.0.1:8080 → db.internal:5432"
        );
        assert_eq!(
            describe_remote_forward(&remote("a", 8080)),
            "remote 127.0.0.1:8080 → localhost:3000"
        );
    }

    #[test]
    fn a_new_registry_reports_the_requested_rules_as_starting() {
        let registry = ForwardRegistry::new(&[local("l1", 8080)], &[remote("r1", 9000)]);
        let status = registry.status();
        assert_eq!(status.len(), 2);
        assert_eq!(status[0].direction, ForwardDirection::Local);
        assert_eq!(status[0].state, ForwardRunState::Starting);
        assert_eq!(status[1].direction, ForwardDirection::Remote);
        assert_eq!(status[1].state, ForwardRunState::Starting);
        assert!(status.iter().all(|rule| rule.error.is_none()));
    }

    #[test]
    fn a_disabled_rule_starts_stopped_and_claims_no_inbound_channel() {
        let mut rule = remote("r1", 9000);
        rule.enabled = false;
        let registry = ForwardRegistry::new(&[], &[rule]);
        assert_eq!(registry.status()[0].state, ForwardRunState::Stopped);
        // An inbound `forwarded-tcpip` for a switched-off rule must not be
        // dialled through to the local target.
        assert_eq!(registry.remote_target(9000), None);
    }

    #[test]
    fn toggling_a_rule_wakes_the_supervisor_and_clears_its_counters() {
        let registry = ForwardRegistry::new(&[local("l1", 8080)], &[]);
        let mut control = registry.subscribe();
        registry.mark("l1", ForwardRunState::Listening, None);
        registry.connection_opened("l1");
        registry.connection_queued("l1");

        registry.set_enabled("l1", false).expect("known rule");
        assert!(control.has_changed().expect("sender alive"));
        let status = &registry.status()[0];
        assert!(!status.enabled);
        assert_eq!(status.state, ForwardRunState::Stopped);
        assert_eq!(status.active_connections, 0);
        assert_eq!(status.queued_connections, 0);

        control.mark_unchanged();
        // A no-op toggle must not wake the supervisor into a pointless
        // reconcile pass.
        registry.set_enabled("l1", false).expect("known rule");
        assert!(!control.has_changed().expect("sender alive"));

        registry.set_enabled("l1", true).expect("known rule");
        assert_eq!(registry.status()[0].state, ForwardRunState::Starting);
    }

    #[test]
    fn toggling_an_unknown_rule_is_an_error_rather_than_a_silent_no_op() {
        let registry = ForwardRegistry::new(&[local("l1", 8080)], &[]);
        let error = registry.set_enabled("nope", true).unwrap_err();
        assert!(error.contains("nope"), "{error}");
    }

    #[test]
    fn counters_track_queueing_and_never_underflow() {
        let registry = ForwardRegistry::new(&[local("l1", 8080)], &[]);
        registry.connection_queued("l1");
        registry.connection_queued("l1");
        assert_eq!(registry.status()[0].queued_connections, 2);

        registry.connection_dequeued("l1");
        registry.connection_opened("l1");
        let status = &registry.status()[0];
        assert_eq!(status.queued_connections, 1);
        assert_eq!(status.active_connections, 1);

        // A close without a matching open (a task torn down mid-flight) must
        // not wrap the counter around to four billion.
        registry.connection_closed("l1");
        registry.connection_closed("l1");
        registry.connection_dequeued("l1");
        registry.connection_dequeued("l1");
        let status = &registry.status()[0];
        assert_eq!(status.active_connections, 0);
        assert_eq!(status.queued_connections, 0);
    }

    #[test]
    fn losing_the_link_parks_enabled_rules_without_disturbing_stopped_ones() {
        let mut off = local("l2", 9090);
        off.enabled = false;
        let registry = ForwardRegistry::new(&[local("l1", 8080), off], &[remote("r1", 9000)]);
        registry.mark("l1", ForwardRunState::Listening, None);
        registry.mark("r1", ForwardRunState::Listening, None);
        registry.connection_opened("l1");
        registry.connection_queued("l1");

        registry.connection_lost();

        let status = registry.status();
        // The local listener is still bound, so its queued callers survive the
        // outage and are served once the link returns.
        assert_eq!(status[0].state, ForwardRunState::Waiting);
        assert_eq!(status[0].active_connections, 0);
        assert_eq!(status[0].queued_connections, 1);
        assert_eq!(status[1].state, ForwardRunState::Stopped);
        // The server forgot the remote forward when the connection dropped;
        // nothing can be queued for it until it is requested again.
        assert_eq!(status[2].state, ForwardRunState::Waiting);
        assert_eq!(status[2].queued_connections, 0);
    }

    #[test]
    fn a_failed_rule_stays_failed_across_a_reconnect_so_the_reason_survives() {
        let registry = ForwardRegistry::new(&[local("l1", 8080)], &[]);
        registry.mark(
            "l1",
            ForwardRunState::Failed,
            Some("address already in use".into()),
        );

        registry.connection_lost();

        let status = &registry.status()[0];
        assert_eq!(status.state, ForwardRunState::Failed);
        assert_eq!(status.error.as_deref(), Some("address already in use"));
    }

    #[test]
    fn enabled_ids_are_reported_per_direction() {
        let mut off = local("l2", 9090);
        off.enabled = false;
        let registry = ForwardRegistry::new(&[local("l1", 8080), off], &[remote("r1", 9000)]);
        assert_eq!(
            registry.enabled_ids(ForwardDirection::Local),
            vec!["l1".to_string()]
        );
        assert_eq!(
            registry.enabled_ids(ForwardDirection::Remote),
            vec!["r1".to_string()]
        );
        assert!(registry.is_enabled("l1"));
        assert!(!registry.is_enabled("l2"));
        assert!(!registry.is_enabled("absent"));
    }

    #[test]
    fn an_empty_rule_set_needs_no_supervisor() {
        assert!(ForwardRegistry::new(&[], &[]).is_empty());
        assert!(!ForwardRegistry::new(&[local("l1", 1)], &[]).is_empty());
    }
}
