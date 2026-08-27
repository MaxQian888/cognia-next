//! Companion event-channel catalog and per-connection subscription.
//!
//! # Why this exists
//!
//! [`EventBus`](super::event_bus::EventBus) is a single `broadcast` channel:
//! every published frame is delivered to every live subscriber, and the only
//! server-side filters were "is this frame targeted at another device" and
//! "does it belong to another tenant". There was no notion of a client asking
//! for a *subset*, and no notion of a channel being off-limits to a paired
//! phone but fine for the loopback brain.
//!
//! That was survivable only because `register_default_event_channels` fanned
//! out a hardcoded 18 channels. The moment that list grows — which it must,
//! because `browser_*` / `codeserver_*` / `plugin_python_*` commands are
//! remotely callable while their result stream is not remotely reachable —
//! every added channel would be pushed to every connected device whether it
//! wanted the traffic or not. Bandwidth is the lesser half; the real cost is
//! that channels carrying page content, editor buffers, and provider request
//! logs would start arriving at devices that never asked for them.
//!
//! So the subscription lands *before* the widening.
//!
//! # Model
//!
//! - The **catalog** ([`EVENT_CHANNELS`]) is the closed set of channels that
//!   may leave the host. A channel that is not catalogued is not deliverable
//!   — deny, don't shrug. Host-local UI plumbing (`tray://*`, `pet://*`,
//!   `menu://*`, window geometry) is deliberately absent: it means nothing to
//!   a remote client and there is no version of "the phone receives
//!   `tray://open-logs`" that is correct.
//! - Each entry declares a [`ChannelAudience`], so a channel can be limited to
//!   the loopback brain without also hiding it from the brain.
//! - Each entry declares `default_on`. The `true` set is exactly what reaches
//!   remote clients today, so an existing client that never learns to send a
//!   `subscribe` frame observes no behavioral change at all. Everything added
//!   by the widening is `false` — opt-in, by name.
//! - Each entry declares `tauri_forwarded`, i.e. whether
//!   `register_default_event_channels` installs a `tauri::listen` for it. This
//!   is not derivable from the name: several channels reach the bus by direct
//!   `publish` and would be *double*-delivered if also listened for, and
//!   `perf://frame` would be actively downgraded — its remote path is a
//!   device-targeted `publish_ephemeral_to`, so adding a listener would
//!   broadcast the local-delivery frames to every subscriber instead.
//!
//! # Wire protocol
//!
//! A client widens or narrows its stream by sending one control frame:
//!
//! ```json
//! { "type": "subscribe", "mode": "add", "channels": ["browser://navigated"] }
//! ```
//!
//! and receives the resulting state, including anything the host refused:
//!
//! ```json
//! {
//!   "type": "subscribed",
//!   "channels": ["browser://navigated", "claude://message", "…"],
//!   "rejected": [{ "channel": "tray://open-logs", "reason": "unknown_channel" }]
//! }
//! ```
//!
//! Refusals are named rather than dropped. A silently ignored subscription is
//! the same failure mode as a reachable command with an unreachable event
//! stream: the caller is told everything worked and then waits forever.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

/// Which connections may receive a channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelAudience {
    /// Paired devices and the loopback brain alike.
    Any,
    /// The loopback headless brain only (`scope = "service"`).
    ///
    /// Used for channels that are *requests addressed to the renderer* rather
    /// than observations: the brain is the party that answers them, and a
    /// paired phone receiving them would be reading someone else's mail.
    ServiceOnly,
}

// ---------------------------------------------------------------------------
// Connection scope
// ---------------------------------------------------------------------------

/// The authenticated scope of one event-stream connection.
///
/// Mirrors the JWT `scope` claim: the public `/ws/events` route is always
/// [`Device`](ConnectionScope::Device), the loopback `/internal/events` route
/// is always [`Service`](ConnectionScope::Service).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionScope {
    Device,
    Service,
}

impl ConnectionScope {
    /// Map a raw JWT scope claim. Anything that is not exactly `"service"` is
    /// treated as a device — the conservative direction, since `Device` is the
    /// strictly smaller capability.
    pub fn from_claim(scope: &str) -> Self {
        if scope == "service" {
            Self::Service
        } else {
            Self::Device
        }
    }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/// One catalogued event channel.
pub struct EventChannelSpec {
    /// Exact channel name, or a prefix pattern ending in `*`.
    ///
    /// Prefix patterns exist only for families whose channel names are built
    /// at runtime and therefore cannot be enumerated: connector transports
    /// mint `connectors://onebot/{adapter_id}/event`-style names per adapter.
    /// A prefix entry is the honest representation of "this whole family is
    /// one capability".
    pub pattern: &'static str,
    /// Who may receive it.
    pub audience: ChannelAudience,
    /// Whether a connection that never sent a `subscribe` frame receives it.
    ///
    /// The `true` set is frozen to what reaches remote clients today. Adding a
    /// channel here is a behavioral change for every already-deployed client
    /// and needs its own justification; adding one with `false` is not.
    pub default_on: bool,
    /// Whether `register_default_event_channels` installs a `tauri::listen`
    /// bridging this channel into the bus.
    ///
    /// `false` means the channel reaches the bus some other way (a direct
    /// `publish` from Rust) and a listener would duplicate or distort it.
    pub tauri_forwarded: bool,
    /// What the channel carries, and why it is (or is not) on by default.
    pub note: &'static str,
}

impl EventChannelSpec {
    /// Whether `event_type` is covered by this entry.
    pub fn matches(&self, event_type: &str) -> bool {
        match self.pattern.strip_suffix('*') {
            Some(prefix) => event_type.starts_with(prefix),
            None => self.pattern == event_type,
        }
    }

    /// Whether a connection at `scope` may receive this channel.
    pub fn permits(&self, scope: ConnectionScope) -> bool {
        match self.audience {
            ChannelAudience::Any => true,
            ChannelAudience::ServiceOnly => scope == ConnectionScope::Service,
        }
    }
}

/// The closed set of remotely deliverable event channels.
///
/// Ordering is by family, not alphabetical, so the `default_on` block reads as
/// one decision rather than twenty-two scattered ones.
pub static EVENT_CHANNELS: &[EventChannelSpec] = &[
    // -----------------------------------------------------------------------
    // Reachable today (`default_on: true`).
    //
    // This block is the pre-subscription behaviour, transcribed. Eighteen come
    // from `register_default_event_channels`; the rest are published straight
    // into the bus by Rust call sites that never went through Tauri's event
    // system, so they were reachable without ever appearing in that list.
    // -----------------------------------------------------------------------
    EventChannelSpec {
        pattern: "claude://message",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "primary chat stream; carries assistant text and tool traffic",
    },
    EventChannelSpec {
        pattern: "claude://message-added",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "message-repository mutation; carries message bodies",
    },
    EventChannelSpec {
        pattern: "claude://message-updated",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "message-repository mutation; carries message bodies",
    },
    EventChannelSpec {
        pattern: "claude://message-deleted",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "message-repository mutation; ids only",
    },
    EventChannelSpec {
        pattern: "transcript://revision",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "session identity plus a monotonic revision; carries no content",
    },
    EventChannelSpec {
        pattern: "goal://status",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "/goal lifecycle transitions for remote watchers",
    },
    EventChannelSpec {
        pattern: "host-consent://requested",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "escalation ask for an admin lease, and its answer; device id plus \
               the operation names, no secrets. Must reach paired devices by \
               default — on a headless host another device IS the approver, and \
               a channel nobody subscribed to would leave the ask unanswerable.",
    },
    EventChannelSpec {
        pattern: "automation:consent-request",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "host computer-use HITL prompt; carries a screen thumbnail and window title",
    },
    EventChannelSpec {
        pattern: "ocr://download-progress",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "model download progress; counters only",
    },
    EventChannelSpec {
        pattern: "companion://device-paired",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "pairing lifecycle, for multi-device observation. Emitted by \
               `api::register_handler` after a device registers (ADR-0127); \
               `lib/companion/event-bridge.ts` mirrors it into `pairedDevices`",
    },
    EventChannelSpec {
        pattern: "companion://device-seen",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "presence heartbeat emitted by the JWT middleware",
    },
    EventChannelSpec {
        pattern: "workflow://run-status",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "workflow run transitions, including per-step advances",
    },
    EventChannelSpec {
        pattern: "workflow://approval-request",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "HITL approval gate; title and message ride the authenticated socket only",
    },
    EventChannelSpec {
        pattern: "workflow://approval-resolved",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "approval resolution, so pending lists clear immediately",
    },
    EventChannelSpec {
        pattern: "workflow://step-execute",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "desktop-issued remote step request; full params ride the socket",
    },
    EventChannelSpec {
        pattern: "sync://invalidate",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "table-scoped sync invalidation; table names (+ optional conversation key) only",
    },
    EventChannelSpec {
        // ADR-0131 cross-shell inbox relay. Distinct from `sync://invalidate`
        // because it is the NOTIFIABLE half: invalidate says "re-pull table
        // X", this says "a human message arrived in conversation Y" and is
        // what `register_push_trigger` wakes a backgrounded phone for.
        // Ids + href only — never message text (it transits APNs/FCM).
        // `default_on: false` so a client that never asked keeps its
        // bandwidth; the mobile shell subscribes explicitly.
        pattern: "connector://message-added",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "inbound IM message arrived; ids + deep-link href only",
    },
    EventChannelSpec {
        pattern: "git://status-changed",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "native git watcher signal; the only push refresh remote SCM clients get",
    },
    EventChannelSpec {
        pattern: "task-workspace://resources-changed",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "task resource invalidation; ids, paths, and summaries only",
    },
    EventChannelSpec {
        pattern: "fleet://update",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "full agent-fleet snapshot for the remote island mirror",
    },
    EventChannelSpec {
        pattern: "host-state://action",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: false,
        note: "host-state actions; published straight into the bus by the renderer bridge, \
               so a listener would double-deliver",
    },
    // The other two channels the sidecar host publishes straight into the bus
    // alongside `claude://message` (src-tauri/src/claude/host.rs:125,197). They
    // never appeared in the eighteen-entry registration list because they never
    // needed to — a direct publish reaches every subscriber — which is exactly
    // why they have to be named here now.
    EventChannelSpec {
        pattern: "a2ui://dispatch",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: false,
        note: "A2UI surface dispatch; carries rendered surface payloads for the remote UI",
    },
    EventChannelSpec {
        pattern: "agent://message",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: false,
        note: "canonical ADR-0090 agent event stream; carries agent output",
    },
    EventChannelSpec {
        pattern: "notification://remote",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: false,
        note: "the payload of the remote_notification_publish RPC. Delivering it is the \
               entire purpose of that command, so it cannot be opt-in",
    },
    EventChannelSpec {
        pattern: "perf://frame",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: false,
        note: "performance sample. Its remote path is a device-targeted \
               publish_ephemeral_to; a listener would broadcast the local-delivery \
               frames to every subscriber instead of the one that asked",
    },
    // Ordered before the family entry it overrides purely for readability;
    // `spec_for` prefers exact matches regardless of position.
    EventChannelSpec {
        pattern: "connectors://lark-oauth/callback",
        audience: ChannelAudience::ServiceOnly,
        default_on: true,
        tauri_forwarded: false,
        note: "Lark OAuth redirect. Carries the authorization CODE, so it is pulled out \
               of the connectors:// family and pinned to the brain. It is already \
               targeted at SERVICE_DEVICE_ID by publish_ephemeral_to and kept out of \
               replay; this entry makes the restriction hold even if that call site \
               changes. default_on because the brain must receive it unprompted for \
               the OAuth exchange to complete",
    },
    EventChannelSpec {
        pattern: "connectors://*",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: false,
        note: "connector transports. Names are minted per adapter at runtime, so the \
               family is one capability and no exact listener can exist — the desktop \
               shell therefore still routes these to the renderer only, and they reach \
               remote clients in headless mode via ConnectorEventEmitter. Carries \
               inbound platform messages verbatim",
    },
    // -----------------------------------------------------------------------
    // Opt-in (`default_on: false`).
    //
    // These are the channels whose absence made an allowlisted command a
    // silent no-op: the RPC returns 200 and the result stream never arrives.
    // Registered so they *can* flow, delivered only to a client that named
    // them.
    // -----------------------------------------------------------------------

    // Embedded browser — the canonical names live in `lib/browser/protocol.ts`.
    EventChannelSpec {
        pattern: "browser://navigated",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "navigation committed; carries the destination URL",
    },
    EventChannelSpec {
        pattern: "browser://loaded",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "page load finished; carries the URL and title",
    },
    EventChannelSpec {
        pattern: "browser://element-selected",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "element picker result; carries selectors and element text",
    },
    EventChannelSpec {
        pattern: "browser://snapshot",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "DOM-changed marker (`{paneId,url,seq,mutations,reason}` — an \
               invalidation, not the snapshot itself). Emitted by \
               `browser::commands::handle_navigation` from the overlay's \
               MutationObserver sentinel and on load / route change (ADR-0127); \
               opt-in for remote subscribers",
    },
    EventChannelSpec {
        pattern: "browser://console",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "captured console output, batched (`{paneId,entries[]}`); can carry \
               page data, so opt-in. Emitted by `browser::commands::handle_navigation` \
               from the overlay's push sentinel (ADR-0127); the DevTools drawer \
               listens locally",
    },
    EventChannelSpec {
        pattern: "browser://network",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "captured network activity, batched (`{paneId,entries[]}`); carries \
               request URLs, so opt-in. Emitted like browser://console (ADR-0127)",
    },
    EventChannelSpec {
        pattern: "browser://proxy-error",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "embedded-browser proxy failure; carries the failing URL and reason",
    },
    // Pro IDE / code-server.
    EventChannelSpec {
        pattern: "codeserver://download-progress",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "code-server binary download progress; counters only",
    },
    EventChannelSpec {
        pattern: "codeserver://instance-exited",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "code-server process exit; ids and exit status",
    },
    EventChannelSpec {
        pattern: "codeserver://editor-event",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "editor activity from the IDE agent channel; carries file paths and buffer state",
    },
    EventChannelSpec {
        pattern: "codeserver://broker-request",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "a request the renderer must answer, not an observation",
    },
    EventChannelSpec {
        pattern: "codeserver://broker-notification",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "IDE broker notification addressed to the renderer",
    },
    // Plugin runtime.
    EventChannelSpec {
        pattern: "plugin:python",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "python plugin bridge results; carries tool output",
    },
    EventChannelSpec {
        pattern: "plugin:file-change",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "plugin dev-server file watch; paths only",
    },
    EventChannelSpec {
        pattern: "plugin://runtime-changed",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "plugin runtime lifecycle; ids and status",
    },
    EventChannelSpec {
        pattern: "plugin-wasm://renderer-request",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "WASM host asking the renderer to run a call; the brain is what answers it",
    },
    EventChannelSpec {
        pattern: "plugin-wasm://renderer-cancel",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "cancellation for an in-flight renderer request",
    },
    // Computer use.
    EventChannelSpec {
        pattern: "automation:event",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "computer-use action results; can carry screen content, so opt-in",
    },
    EventChannelSpec {
        pattern: "automation:kill-switch",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "automation emergency stop; a remote supervisor needs to see it fire",
    },
    EventChannelSpec {
        pattern: "automation:uia-event",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "desktop accessibility event feeding workflow desktop triggers. Its `name` \
               field is the focused element's accessible name and can carry user text, \
               so opt-in",
    },
    EventChannelSpec {
        pattern: "automation:backend-init-failed",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "computer-use backend failed to initialise; backend name and error string",
    },
    // External agents.
    EventChannelSpec {
        pattern: "external-agent://spawn",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "external agent session started; ids and the resolved binary",
    },
    EventChannelSpec {
        pattern: "external-agent://stdout",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "parsed external agent output; carries agent text",
    },
    EventChannelSpec {
        pattern: "external-agent://stdout-raw",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "unparsed external agent output; carries agent text verbatim",
    },
    EventChannelSpec {
        pattern: "external-agent://stderr",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "external agent diagnostics; can carry local paths",
    },
    EventChannelSpec {
        pattern: "external-agent://state-change",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "external agent lifecycle transition; ids and status",
    },
    EventChannelSpec {
        pattern: "external-agent://exit",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "external agent exit; ids and exit code",
    },
    // Provider gateway — brain-only: these carry prompt and routing detail.
    EventChannelSpec {
        pattern: "gateway://request-log",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "provider request log; carries prompt and routing metadata, brain-only",
    },
    EventChannelSpec {
        pattern: "gateway://request-outcome",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "provider request outcome; brain-only for the same reason",
    },
    EventChannelSpec {
        pattern: "gateway://decide",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "routing decision the brain must answer. Its payload includes promptText — \
               the user's prompt verbatim — and the headless gateway host publishes it \
               straight into the bus, so before this catalog it reached every paired \
               device. Narrowing it is a deliberate fix, not a regression",
    },
    EventChannelSpec {
        pattern: "gateway://translation-loss",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "names of IR fields dropped in provider translation — field names only, \
               never their values",
    },
    // Assorted observational streams.
    EventChannelSpec {
        pattern: "jobs://exited",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "background job exit; ids and status",
    },
    EventChannelSpec {
        pattern: "jobs://monitor-fired",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "background job monitor trigger; ids and status",
    },
    EventChannelSpec {
        pattern: "mcp://oauth/login-completed",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "MCP OAuth completion signal; no token material in the payload",
    },
    EventChannelSpec {
        pattern: "session-import://changed",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "external session file watch; ids and paths",
    },
    EventChannelSpec {
        pattern: "ccswitch://db-changed",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "coding-agent settings database change signal",
    },
    EventChannelSpec {
        pattern: "plan://status",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "plan lifecycle transitions; ids and status only. The twin of goal://status, \
               which has been remotely reachable all along while this one was not",
    },
    EventChannelSpec {
        pattern: "scheduler:task-due",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "scheduled task fired; ids only",
    },
    EventChannelSpec {
        pattern: "integration:delivery-available",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "marketplace integration delivery wake signal; ids only",
    },
    EventChannelSpec {
        pattern: "workflow:trigger",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "workflow trigger fired; ids and trigger kind",
    },
    EventChannelSpec {
        pattern: "workflow://run-terminal",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "terminal workflow run; had a push trigger but no socket path at all",
    },
    EventChannelSpec {
        pattern: "workflow://approval-pending",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "approval pending wake-up; had a push trigger but no socket path",
    },
    EventChannelSpec {
        pattern: "workflow://step-pending",
        audience: ChannelAudience::Any,
        default_on: false,
        tauri_forwarded: true,
        note: "remote step pending wake-up; had a push trigger but no socket path",
    },
    EventChannelSpec {
        pattern: "orchestration-proxy:exec",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "MCP orchestration proxy exec request the brain answers",
    },
    EventChannelSpec {
        pattern: "crash://captured",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "crash diagnostic snapshot; host-internal detail, brain-only",
    },
];

/// Look up the catalog entry covering `event_type`.
pub fn spec_for(event_type: &str) -> Option<&'static EventChannelSpec> {
    // Exact entries win over prefix entries so a specific channel can carry a
    // different audience than its family.
    EVENT_CHANNELS
        .iter()
        .find(|spec| !spec.pattern.ends_with('*') && spec.matches(event_type))
        .or_else(|| EVENT_CHANNELS.iter().find(|spec| spec.matches(event_type)))
}

/// Catalog entries a connection at `scope` is allowed to ask for.
pub fn available_for(scope: ConnectionScope) -> Vec<&'static EventChannelSpec> {
    EVENT_CHANNELS
        .iter()
        .filter(|spec| spec.permits(scope))
        .collect()
}

/// Channels that need a `tauri::listen` bridge to reach the bus at all.
pub fn tauri_forwarded_channels() -> Vec<&'static str> {
    EVENT_CHANNELS
        .iter()
        .filter(|spec| spec.tauri_forwarded)
        .map(|spec| spec.pattern)
        .collect()
}

// ---------------------------------------------------------------------------
// Subscription requests
// ---------------------------------------------------------------------------

/// How a `subscribe` frame combines with the current subscription.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SubscribeMode {
    /// Replace the current set outright. The default, so a client that wants
    /// an exact stream does not have to reason about what it started with.
    #[default]
    Replace,
    /// Add to the current set.
    Add,
    /// Remove from the current set.
    Remove,
}

/// A client's `subscribe` control frame.
#[derive(Clone, Debug, Deserialize)]
pub struct SubscribeRequest {
    #[serde(default)]
    pub mode: SubscribeMode,
    #[serde(default)]
    pub channels: Vec<String>,
}

/// A channel the host refused, and why.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RejectedChannel {
    pub channel: String,
    pub reason: &'static str,
}

/// Reason codes for [`RejectedChannel`].
pub mod reject_reason {
    /// Not in the catalog — either a typo, or a host-local channel that is
    /// deliberately not deliverable.
    pub const UNKNOWN_CHANNEL: &str = "unknown_channel";
    /// Catalogued, but this connection's scope may not receive it.
    pub const SCOPE_FORBIDDEN: &str = "scope_forbidden";
}

/// The resulting subscription state, echoed back to the client.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SubscriptionOutcome {
    pub channels: Vec<&'static str>,
    pub rejected: Vec<RejectedChannel>,
}

// ---------------------------------------------------------------------------
// EventSubscription
// ---------------------------------------------------------------------------

/// One connection's live subscription.
///
/// Membership is stored as catalog `pattern` pointers rather than owned
/// strings, which makes "subscribed to something that is not in the catalog"
/// unrepresentable instead of merely unlikely.
#[derive(Clone, Debug)]
pub struct EventSubscription {
    scope: ConnectionScope,
    patterns: BTreeSet<&'static str>,
}

impl EventSubscription {
    /// The subscription a connection starts with: every `default_on` channel
    /// its scope permits.
    pub fn defaults_for(scope: ConnectionScope) -> Self {
        Self {
            scope,
            patterns: EVENT_CHANNELS
                .iter()
                .filter(|spec| spec.default_on && spec.permits(scope))
                .map(|spec| spec.pattern)
                .collect(),
        }
    }

    pub fn scope(&self) -> ConnectionScope {
        self.scope
    }

    /// Whether a frame on `event_type` should be delivered.
    ///
    /// The scope check is repeated here rather than trusted from subscribe
    /// time: `patterns` is durable across a connection's lifetime, and a
    /// delivery-time check is the one that actually gates the socket write.
    pub fn allows(&self, event_type: &str) -> bool {
        match spec_for(event_type) {
            Some(spec) => spec.permits(self.scope) && self.patterns.contains(spec.pattern),
            // Uncatalogued channels are not deliverable. This is the deliberate
            // half of the design: host-local UI events, and anything added
            // without a catalog entry, stay on the host rather than quietly
            // fanning out to every paired device.
            None => false,
        }
    }

    /// Currently subscribed patterns, sorted.
    pub fn channels(&self) -> Vec<&'static str> {
        self.patterns.iter().copied().collect()
    }

    /// Apply a client `subscribe` frame and report the result.
    pub fn apply(&mut self, request: &SubscribeRequest) -> SubscriptionOutcome {
        let mut rejected = Vec::new();
        let mut resolved = Vec::new();

        for requested in &request.channels {
            match spec_for(requested) {
                Some(spec) if spec.permits(self.scope) => resolved.push(spec.pattern),
                Some(_) => rejected.push(RejectedChannel {
                    channel: requested.clone(),
                    reason: reject_reason::SCOPE_FORBIDDEN,
                }),
                None => rejected.push(RejectedChannel {
                    channel: requested.clone(),
                    reason: reject_reason::UNKNOWN_CHANNEL,
                }),
            }
        }

        match request.mode {
            SubscribeMode::Replace => {
                self.patterns = resolved.into_iter().collect();
            }
            SubscribeMode::Add => {
                self.patterns.extend(resolved);
            }
            SubscribeMode::Remove => {
                for pattern in resolved {
                    self.patterns.remove(pattern);
                }
            }
        }

        SubscriptionOutcome {
            channels: self.channels(),
            rejected,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn request(mode: SubscribeMode, channels: &[&str]) -> SubscribeRequest {
        SubscribeRequest {
            mode,
            channels: channels.iter().map(|c| (*c).to_owned()).collect(),
        }
    }

    // ── catalog shape ────────────────────────────────────────────────────────

    #[test]
    fn catalog_patterns_are_unique() {
        let mut seen = BTreeSet::new();
        for spec in EVENT_CHANNELS {
            assert!(
                seen.insert(spec.pattern),
                "duplicate catalog entry for {}",
                spec.pattern
            );
        }
    }

    #[test]
    fn every_catalog_entry_carries_a_written_note() {
        for spec in EVENT_CHANNELS {
            assert!(
                spec.note.len() > 20,
                "{} needs a real note explaining what it carries",
                spec.pattern
            );
        }
    }

    /// The `default_on` set is the pre-subscription behaviour. Changing it
    /// changes what every already-deployed client receives without that client
    /// asking, so it is pinned here rather than left to review.
    #[test]
    fn the_default_on_set_is_exactly_what_reached_clients_before_subscriptions() {
        let mut defaults: Vec<&str> = EVENT_CHANNELS
            .iter()
            .filter(|spec| spec.default_on)
            .map(|spec| spec.pattern)
            .collect();
        defaults.sort_unstable();

        assert_eq!(
            defaults,
            vec![
                "a2ui://dispatch",
                "agent://message",
                "automation:consent-request",
                "claude://message",
                "claude://message-added",
                "claude://message-deleted",
                "claude://message-updated",
                "companion://device-paired",
                "companion://device-seen",
                "connectors://*",
                "connectors://lark-oauth/callback",
                "fleet://update",
                "git://status-changed",
                "goal://status",
                "host-consent://requested",
                "host-state://action",
                "notification://remote",
                "ocr://download-progress",
                "perf://frame",
                "sync://invalidate",
                "task-workspace://resources-changed",
                "transcript://revision",
                "workflow://approval-request",
                "workflow://approval-resolved",
                "workflow://run-status",
                "workflow://step-execute",
            ]
        );
    }

    /// A service-only channel may legitimately be `default_on` — the brain has
    /// to receive `connectors://lark-oauth/callback` without asking for the
    /// OAuth exchange to finish. What must never happen is one of them landing
    /// in a *device's* starting set, so that is what gets asserted.
    #[test]
    fn no_service_only_channel_reaches_a_device_by_default() {
        let device = EventSubscription::defaults_for(ConnectionScope::Device);
        for spec in EVENT_CHANNELS {
            if spec.audience == ChannelAudience::ServiceOnly {
                assert!(
                    !device.channels().contains(&spec.pattern),
                    "{} is service-only but is in the device default set",
                    spec.pattern
                );
            }
        }
    }

    #[test]
    fn the_oauth_callback_is_pinned_to_the_brain() {
        // It rides the connectors:// family's name space but carries an
        // authorization code, so the exact entry must win.
        let spec = spec_for("connectors://lark-oauth/callback").expect("exact entry");
        assert_eq!(spec.audience, ChannelAudience::ServiceOnly);

        let device = EventSubscription::defaults_for(ConnectionScope::Device);
        assert!(!device.allows("connectors://lark-oauth/callback"));
        // ...while a sibling in the same family still reaches devices.
        assert!(device.allows("connectors://onebot/adapter-7/event"));

        let brain = EventSubscription::defaults_for(ConnectionScope::Service);
        assert!(brain.allows("connectors://lark-oauth/callback"));
    }

    /// `tauri::Listener::listen` takes an exact name, so a pattern entry could
    /// never fire — declaring one `tauri_forwarded` would be a silent no-op.
    #[test]
    fn no_prefix_family_claims_to_be_tauri_forwarded() {
        for spec in EVENT_CHANNELS {
            if spec.pattern.ends_with('*') {
                assert!(
                    !spec.tauri_forwarded,
                    "{} is a prefix family; tauri::listen cannot bridge it",
                    spec.pattern
                );
            }
        }
    }

    // ── matching ─────────────────────────────────────────────────────────────

    #[test]
    fn prefix_entries_cover_runtime_minted_names() {
        let spec = spec_for("connectors://onebot/adapter-7/event").expect("family entry");
        assert_eq!(spec.pattern, "connectors://*");

        let spec = spec_for("connectors://lark-intent").expect("family entry");
        assert_eq!(spec.pattern, "connectors://*");
    }

    #[test]
    fn exact_entries_win_over_the_family_entry() {
        // No exact override of `connectors://*` exists today, but the lookup
        // order is what makes adding one safe, so it is pinned.
        let spec = spec_for("codeserver://broker-request").expect("exact entry");
        assert_eq!(spec.pattern, "codeserver://broker-request");
        assert_eq!(spec.audience, ChannelAudience::ServiceOnly);
    }

    #[test]
    fn host_local_channels_are_not_catalogued() {
        for channel in [
            "tray://open-logs",
            "pet://suspend",
            "pet-popup://hidden",
            "app://close-requested",
            "fleet://island-geometry",
            "selection://candidate",
            "tray-panel://shown",
            "deep-link://received",
            "shortcut://triggered",
            "menu://settings",
        ] {
            assert!(
                spec_for(channel).is_none(),
                "{channel} is host-local UI plumbing and must not be remotely deliverable"
            );
        }
    }

    // ── defaults ─────────────────────────────────────────────────────────────

    #[test]
    fn device_defaults_exclude_service_only_channels() {
        let sub = EventSubscription::defaults_for(ConnectionScope::Device);
        assert!(sub.allows("claude://message"));
        assert!(!sub.allows("gateway://request-log"));
    }

    #[test]
    fn an_uncatalogued_channel_is_never_delivered() {
        let device = EventSubscription::defaults_for(ConnectionScope::Device);
        let service = EventSubscription::defaults_for(ConnectionScope::Service);
        assert!(!device.allows("tray://open-logs"));
        assert!(!service.allows("tray://open-logs"));
    }

    #[test]
    fn opt_in_channels_are_absent_until_requested() {
        let mut sub = EventSubscription::defaults_for(ConnectionScope::Device);
        assert!(!sub.allows("browser://navigated"));

        let outcome = sub.apply(&request(SubscribeMode::Add, &["browser://navigated"]));
        assert!(outcome.rejected.is_empty());
        assert!(sub.allows("browser://navigated"));
        // Adding must not disturb what was already there.
        assert!(sub.allows("claude://message"));
    }

    // ── scope enforcement ────────────────────────────────────────────────────

    #[test]
    fn a_device_asking_for_a_service_only_channel_is_told_no() {
        let mut sub = EventSubscription::defaults_for(ConnectionScope::Device);
        let outcome = sub.apply(&request(SubscribeMode::Add, &["gateway://request-log"]));

        assert_eq!(
            outcome.rejected,
            vec![RejectedChannel {
                channel: "gateway://request-log".to_owned(),
                reason: reject_reason::SCOPE_FORBIDDEN,
            }]
        );
        assert!(!sub.allows("gateway://request-log"));
    }

    #[test]
    fn the_brain_may_take_service_only_channels() {
        let mut sub = EventSubscription::defaults_for(ConnectionScope::Service);
        let outcome = sub.apply(&request(SubscribeMode::Add, &["gateway://request-log"]));

        assert!(outcome.rejected.is_empty());
        assert!(sub.allows("gateway://request-log"));
    }

    #[test]
    fn an_unknown_channel_is_named_in_the_reply_not_dropped() {
        let mut sub = EventSubscription::defaults_for(ConnectionScope::Device);
        let outcome = sub.apply(&request(
            SubscribeMode::Add,
            &["browser://navigated", "tray://open-logs"],
        ));

        assert_eq!(
            outcome.rejected,
            vec![RejectedChannel {
                channel: "tray://open-logs".to_owned(),
                reason: reject_reason::UNKNOWN_CHANNEL,
            }]
        );
        // The valid half of the request still applies — a partial refusal does
        // not discard the rest.
        assert!(sub.allows("browser://navigated"));
    }

    // ── modes ────────────────────────────────────────────────────────────────

    #[test]
    fn replace_narrows_to_exactly_what_was_asked_for() {
        let mut sub = EventSubscription::defaults_for(ConnectionScope::Device);
        let outcome = sub.apply(&request(SubscribeMode::Replace, &["claude://message"]));

        assert_eq!(outcome.channels, vec!["claude://message"]);
        assert!(sub.allows("claude://message"));
        assert!(!sub.allows("sync://invalidate"));
    }

    #[test]
    fn remove_drops_only_the_named_channels() {
        let mut sub = EventSubscription::defaults_for(ConnectionScope::Device);
        sub.apply(&request(SubscribeMode::Remove, &["claude://message"]));

        assert!(!sub.allows("claude://message"));
        assert!(sub.allows("sync://invalidate"));
    }

    #[test]
    fn an_empty_replace_silences_the_stream() {
        let mut sub = EventSubscription::defaults_for(ConnectionScope::Device);
        let outcome = sub.apply(&request(SubscribeMode::Replace, &[]));

        assert!(outcome.channels.is_empty());
        assert!(!sub.allows("claude://message"));
    }

    #[test]
    fn mode_defaults_to_replace_when_the_frame_omits_it() {
        let parsed: SubscribeRequest =
            serde_json::from_str(r#"{"channels":["claude://message"]}"#).expect("parse");
        assert_eq!(parsed.mode, SubscribeMode::Replace);
    }

    #[test]
    fn a_subscribe_frame_parses_from_the_documented_wire_shape() {
        let parsed: SubscribeRequest =
            serde_json::from_str(r#"{"mode":"add","channels":["browser://navigated"]}"#)
                .expect("parse");
        assert_eq!(parsed.mode, SubscribeMode::Add);
        assert_eq!(parsed.channels, vec!["browser://navigated"]);
    }

    // ── discovery ────────────────────────────────────────────────────────────

    #[test]
    fn available_for_hides_service_only_entries_from_devices() {
        let device: Vec<&str> = available_for(ConnectionScope::Device)
            .iter()
            .map(|spec| spec.pattern)
            .collect();
        assert!(device.contains(&"browser://navigated"));
        assert!(!device.contains(&"gateway://request-log"));

        let service: Vec<&str> = available_for(ConnectionScope::Service)
            .iter()
            .map(|spec| spec.pattern)
            .collect();
        assert!(service.contains(&"gateway://request-log"));
    }

    #[test]
    fn tauri_forwarded_channels_are_all_exact_names() {
        let forwarded = tauri_forwarded_channels();
        assert!(forwarded.contains(&"claude://message"));
        assert!(forwarded.contains(&"browser://navigated"));
        assert!(
            !forwarded.iter().any(|name| name.ends_with('*')),
            "tauri::listen takes an exact name; a pattern would never fire"
        );
    }

    /// The catalog spells channel names out so the whole set reads in one
    /// place, but several of them already have a canonical constant at the
    /// emit site. Bind the two together: a rename there must not leave a
    /// catalog entry silently matching nothing.
    #[test]
    fn catalog_names_match_their_canonical_constants() {
        for (catalogued, canonical) in [
            (
                "task-workspace://resources-changed",
                crate::task_workspace::RESOURCE_EVENT,
            ),
            ("fleet://update", crate::fleet::UPDATE_EVENT),
            ("perf://frame", crate::perf::sampler::FRAME_EVENT),
            (
                "automation:consent-request",
                super::super::commands::AUTOMATION_CONSENT_CHANNEL,
            ),
            (
                "host-consent://requested",
                super::super::host_consent::CONSENT_CHANNEL,
            ),
            (
                "codeserver://instance-exited",
                crate::codeserver::process::CODESERVER_EXITED_EVENT,
            ),
            (
                "codeserver://editor-event",
                crate::codeserver::agent_channel::CODESERVER_EDITOR_EVENT,
            ),
            (
                "codeserver://broker-request",
                crate::codeserver::agent_channel::CODESERVER_BROKER_REQUEST_EVENT,
            ),
            (
                "codeserver://broker-notification",
                crate::codeserver::agent_channel::CODESERVER_BROKER_NOTIFICATION_EVENT,
            ),
            (
                "session-import://changed",
                crate::session_import_watch::SESSION_CHANGED_EVENT,
            ),
            ("claude://message", crate::claude::sidecar::SIDECAR_EVENT),
            ("a2ui://dispatch", crate::claude::sidecar::A2UI_EVENT),
            ("agent://message", crate::claude::sidecar::AGENT_EVENT),
        ] {
            assert_eq!(
                catalogued, canonical,
                "catalog entry drifted from the constant at its emit site"
            );
            assert!(
                spec_for(canonical).is_some(),
                "{canonical} lost its catalog entry"
            );
        }
    }

    /// Channels whose remote delivery is a targeted or direct publish must not
    /// also get a listener — `perf://frame` in particular would go from
    /// "delivered to the one device that asked" to "broadcast to everyone".
    /// ADR-0131 cross-shell inbox relay pins both of its channels: the
    /// invalidate channel must stay `default_on` (every companion already
    /// relies on it) while the new notifiable channel must stay opt-in, and
    /// both must be Tauri-forwarded or the desktop host's `emit` never
    /// reaches a paired device.
    #[test]
    fn inbox_relay_channels_keep_their_contract() {
        let invalidate = spec_for("sync://invalidate").expect("catalogued");
        assert!(invalidate.default_on, "companions rely on this by default");
        assert!(invalidate.tauri_forwarded);

        let added = spec_for("connector://message-added").expect("catalogued");
        assert!(
            !added.default_on,
            "message-added is opt-in; it wakes push and must be asked for"
        );
        assert!(
            added.tauri_forwarded,
            "the desktop host publishes it with a Tauri emit"
        );
        assert!(matches!(added.audience, ChannelAudience::Any));
    }

    #[test]
    fn directly_published_channels_are_not_also_listened_for() {
        for channel in ["perf://frame", "host-state://action"] {
            let spec = spec_for(channel).expect("catalogued");
            assert!(
                !spec.tauri_forwarded,
                "{channel} reaches the bus by direct publish; a listener would distort it"
            );
        }
    }
}
