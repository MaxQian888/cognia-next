//! Which host events wake a backgrounded phone, and what the push says.
//!
//! Host-neutral: the desktop registers one Tauri listener per
//! [`PUSH_TRIGGER_CHANNELS`] entry, the headless server subscribes to its
//! event bus once and filters on the same list, and both hand each event to
//! [`fan_out_push`]. Every push carries ids and a deep link only; the
//! sanitizers below are what keep a window title, a message body or a tool
//! input off a lock screen.

/// Channel announcing an inbound IM message (ADR-0131). Named because the
/// event-bus registration, the push trigger, and the body builder all
/// reference it.
pub const CONNECTOR_MESSAGE_ADDED_CHANNEL: &str = "connector://message-added";

/// Channel announcing that an unattended run is parked on a person (ADR-0224
/// A7): a tool approval a Bot or scheduled turn raised, or a Bot's own
/// approval step. Named because the push trigger, the body builder and the
/// data allowlist all reference it.
pub const RUN_APPROVAL_PENDING_CHANNEL: &str = "run://approval-pending";

/// Channel carrying host computer-use consent prompts. Named because both the
/// event-bus registration and the push trigger reference it, and because its
/// payload needs channel-specific sanitizing before it can transit a push.
pub const AUTOMATION_CONSENT_CHANNEL: &str = "automation:consent-request";

/// Human-ish push body for a channel: strip any `scheme://` prefix so e.g.
/// `workflow://run-terminal` renders as `run-terminal`. The phone resolves
/// real display text from its synced mirror via `data`.
///
/// The consent channel gets a real sentence instead, because there is nothing
/// for the phone to resolve it against until the user opens the app — and the
/// whole point is to let them triage from the lock screen. It names the action
/// and the process but **never** the window title: notification text is
/// readable by anyone holding the phone, and the title is the field most
/// likely to carry something private ("Re: severance package.xlsx").
pub fn push_body_for_channel(
    channel: &str,
    data: &serde_json::Map<String, serde_json::Value>,
) -> String {
    if channel == AUTOMATION_CONSENT_CHANNEL {
        let command = data
            .get("command")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("a desktop action");
        return match data
            .get("processName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            Some(process) => format!("Confirm {command} in {process}"),
            None => format!("Confirm {command}"),
        };
    }
    if channel == RUN_APPROVAL_PENDING_CHANNEL {
        // Name the kind of decision, never the run's or the tool's text: a
        // Bot's title is author-written and a tool input can carry anything.
        // The phone reads both with `execution_run_approval_list` once it is unlocked.
        if data.get("type").and_then(|v| v.as_str()) == Some("bot_approval") {
            return "A Bot is waiting for your approval".to_string();
        }
        return match data.get("permissionClass").and_then(|v| v.as_str()) {
            Some("outbound") => "Approve an outbound message from an unattended run",
            Some("secrets") => "Approve secret use by an unattended run",
            Some("hostConfig") => "Approve a host change by an unattended run",
            Some("workspace") => "Approve a workspace change by an unattended run",
            _ => "An unattended run is waiting for your approval",
        }
        .to_string();
    }
    if channel == CONNECTOR_MESSAGE_ADDED_CHANNEL {
        // Name the conversation, never the message. `senderName` is already
        // the display name the operator sees in the Inbox list; when the
        // adapter could not resolve one, fall back to the platform so the
        // notification still says *where* rather than nothing.
        let who = data
            .get("senderName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let platform = data
            .get("platform")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        return match (who, platform) {
            (Some(who), Some(platform)) => format!("New message from {who} on {platform}"),
            (Some(who), None) => format!("New message from {who}"),
            (None, Some(platform)) => format!("New message on {platform}"),
            (None, None) => "New message".to_string(),
        };
    }
    match channel.split_once("://") {
        Some((_, rest)) => rest.to_string(),
        None => channel.to_string(),
    }
}

/// Project an event payload into the `data` map that rides the push.
///
/// Most channels pass through: they already carry ids only. The consent
/// channel does not — its frame holds a screen thumbnail (tens of KB, far past
/// the ~4 KB APNs/FCM payload ceiling, so passing it through would break the
/// push outright) plus the window title and the full command detail, which are
/// exactly the fields decided to stay off the lock screen. Allowlist down to
/// what the phone needs to deep-link; it reads the rest off the authenticated
/// WS frame once opened.
pub fn push_data_for_channel(
    channel: &str,
    raw: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    // Remote Session Control — a decision prompt says WHERE, never WHAT. The
    // raw emit carries the tool name so the renderer can log it and the target
    // device list so this trigger can route; neither may transit APNs/FCM or
    // land on a lock screen. Everything the client needs to open the right
    // decision is an id.
    if channel == NEEDS_INPUT_CHANNEL {
        let mut out = serde_json::Map::new();
        for key in ["sessionId", "requestId", "targetId", "href", "dedupeKey"] {
            if let Some(value) = raw.get(key).and_then(|v| v.as_str()) {
                out.insert(key.into(), serde_json::Value::String(value.to_string()));
            }
        }
        out.insert(
            "source".into(),
            serde_json::Value::String("remote-session".into()),
        );
        return out;
    }
    if channel == RUN_APPROVAL_PENDING_CHANNEL {
        // Ids, the kind, the class and the deep link: everything the phone
        // needs to open the right card, nothing it would show on a lock screen.
        let mut out = serde_json::Map::new();
        for key in [
            "interruptId",
            "runId",
            "type",
            "permissionClass",
            "href",
            "dedupeKey",
        ] {
            if let Some(value) = raw.get(key).and_then(|v| v.as_str()) {
                out.insert(key.into(), serde_json::Value::String(value.to_string()));
            }
        }
        // The phone's notification center files a push by `source` (one of
        // its known sources), groups it by `notificationId`, and a run parked
        // on a person is worth more than an info row.
        let source = if raw.get("href").and_then(|v| v.as_str()) == Some("/scheduler") {
            "scheduler"
        } else {
            "system"
        };
        out.insert("source".into(), serde_json::Value::String(source.into()));
        out.insert("level".into(), serde_json::Value::String("warning".into()));
        if let Some(key) = raw.get("dedupeKey").and_then(|v| v.as_str()) {
            out.insert(
                "notificationId".into(),
                serde_json::Value::String(key.to_string()),
            );
        }
        return out;
    }
    if channel != AUTOMATION_CONSENT_CHANNEL {
        return raw.clone();
    }
    let mut out = serde_json::Map::new();
    if let Some(id) = raw.get("id").and_then(|v| v.as_str()) {
        out.insert("id".into(), serde_json::Value::String(id.to_string()));
    }
    out.insert(
        "source".into(),
        serde_json::Value::String("automation".into()),
    );
    // The consent sheet is mounted app-wide (`mobile-shell-wrapper.tsx`), so
    // any route brings it up; the deep link only has to foreground the app.
    out.insert("href".into(), serde_json::Value::String("/".into()));
    out
}

/// Every channel a backgrounded phone is woken for. The desktop registers one
/// Tauri listener per entry (`register_default_event_channels` in the app's `companion_api::commands`); the headless
/// server subscribes to its event bus once and filters on this list
/// (`cognia-server`). One table, so the two hosts cannot drift on which
/// events are push-worthy.
pub const PUSH_TRIGGER_CHANNELS: &[&str] = &[
    "claude://message-added",
    // Remote Session Control — a watched host session needs a tool-use
    // approval decision; notify a backgrounded watcher so it doesn't wait
    // out the renderer-side backstop. Emitted by
    // `lib/companion/needs-input-notifier.ts`.
    NEEDS_INPUT_CHANNEL,
    // ADR-0061 P2 — terminal workflow runs (failed always; succeeded /
    // cancelled only when a paired device triggered the run — policy lives
    // in `companion-run-events.ts`). Payload carries ids + status only.
    "workflow://run-terminal",
    // ADR-0061 P2 — a workflow is blocked on a human approval; wake
    // backgrounded devices. Ids only (transits APNs/FCM) — the phone
    // fetches the request text via `workflow_approval_list` on open.
    "workflow://approval-pending",
    // ADR-0061 P3 — a remote step is waiting on a device. Ids only; the
    // request params ride the WS frame the device receives on open.
    "workflow://step-pending",
    // Host computer-use is blocked on a HITL consent decision. Without this
    // the prompt reached foreground devices only, so a backgrounded phone
    // never saw it and the broker fail-closed on timeout — i.e. remote
    // supervision silently didn't work whenever the screen was off.
    // The payload is sanitized down to ids by `push_data_for_channel`.
    AUTOMATION_CONSENT_CHANNEL,
    // ADR-0131 cross-shell inbox relay — an inbound IM message landed on this
    // host. Without a push a paired phone only learns about it when it next
    // comes to the foreground, which is exactly the case the relay exists to
    // fix (bot on the desktop, operator on the phone). Payload is ids + the
    // `/inbox/c?key=…` deep link; message text never rides the push.
    CONNECTOR_MESSAGE_ADDED_CHANNEL,
    // ADR-0224 A7 — an unattended run (a Bot, a scheduled task) is parked on a
    // person. Nobody is at the host by design, so the phone is the approver;
    // without a push the run waits out its timeout unseen. Allowlisted down
    // to ids by `push_data_for_channel`.
    RUN_APPROVAL_PENDING_CHANNEL,
];

/// Turn one event on a push-worthy channel into provider pushes for the
/// devices that are not currently listening on a live stream.
///
/// Host-neutral: the desktop calls it from a Tauri listener, the headless
/// server from an event-bus subscriber. Before this was factored out the body
/// lived inside the Tauri listener only, so a cloud Host with push credentials
/// installed (`push_creds::reinstall_persisted_dispatchers`) never sent a
/// single push — every "approval needed" and "message arrived" alert reached
/// foreground WebSocket subscribers and nobody else.
pub async fn fan_out_push(
    registry: std::sync::Arc<crate::push::PushTokenRegistry>,
    dispatchers: std::sync::Arc<crate::push::DispatcherSet>,
    channel: &str,
    raw: &str,
) {
    let raw_data: serde_json::Map<String, serde_json::Value> = serde_json::from_str(raw)
        .ok()
        .and_then(|v: serde_json::Value| v.as_object().cloned())
        .unwrap_or_default();
    // Body is derived from the *raw* payload (it needs the action and
    // process name); `data` is the sanitized projection that actually
    // transits the push provider.
    let payload = crate::push::PushPayload {
        title: Some("cognia".into()),
        body: Some(push_body_for_channel(channel, &raw_data)),
        data: push_data_for_channel(channel, &raw_data),
    };

    // A channel may name the devices the event is for. `Some(vec![])`
    // and `None` are different answers: the first means "the Host
    // computed the audience and it is empty", the second means "this
    // event is account-wide". Only the second broadcasts.
    let targets = push_targets_for(channel, &raw_data);

    for provider in [
        crate::push::PushProvider::Fcm,
        crate::push::PushProvider::Apns,
        crate::push::PushProvider::Hms,
    ] {
        if let Some(d) = dispatchers.for_provider(provider) {
            let _ = registry
                .broadcast_to_offline_targets(provider, &payload, d.as_ref(), targets.as_deref())
                .await;
        }
    }
}

/// The channel this Host emits when a watched session is blocked on a human
/// decision. Declared here rather than inline because both the trigger
/// registration and the payload sanitizer must agree on it.
pub const NEEDS_INPUT_CHANNEL: &str = "companion://needs-input";

/// Which devices an emit is addressed to, or `None` for an account-wide event.
///
/// Only the decision-prompt channel is addressed today. It is addressed because
/// the Host already knows exactly which device holds the control attachment on
/// that session — see `notifiableControllers` in
/// `lib/companion/device-presence-registry.ts`, which is what fills the field.
pub fn push_targets_for(
    channel: &str,
    raw: &serde_json::Map<String, serde_json::Value>,
) -> Option<Vec<String>> {
    if channel != NEEDS_INPUT_CHANNEL {
        return None;
    }
    let listed = raw.get("targetDeviceIds")?.as_array()?;
    Some(
        listed
            .iter()
            .filter_map(|value| value.as_str())
            .map(str::to_owned)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hms_receives_host_event_push_fanout() {
        struct Recorder(std::sync::atomic::AtomicUsize);
        #[async_trait::async_trait]
        impl crate::push::PushDispatcher for Recorder {
            async fn deliver(
                &self,
                _: &crate::push::PushTokenRecord,
                _: &crate::push::PushPayload,
            ) -> crate::push::DeliveryOutcome {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                crate::push::DeliveryOutcome::Sent
            }
        }
        let registry = crate::push::PushTokenRegistry::new();
        registry.register(crate::push::PushTokenRecord {
            device_id: "hms-fanout-phone".into(),
            provider: crate::push::PushProvider::Hms,
            token: "token".into(),
            app_version: None,
            device_locale: None,
            registered_at: 0,
        });
        let dispatchers = crate::push::DispatcherSet::new();
        let recorder = std::sync::Arc::new(Recorder(std::sync::atomic::AtomicUsize::new(0)));
        dispatchers.set_hms(recorder.clone());
        fan_out_push(
            registry,
            dispatchers,
            "workflow://run-terminal",
            r#"{"runId":"run-1"}"#,
        )
        .await;
        assert_eq!(recorder.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    fn empty_data() -> serde_json::Map<String, serde_json::Value> {
        serde_json::Map::new()
    }

    /// A consent frame as it actually arrives: flattened prompt fields, a
    /// window title, a command detail, and a fat base64 thumbnail.
    fn consent_payload() -> serde_json::Map<String, serde_json::Value> {
        let mut m = serde_json::Map::new();
        m.insert("id".into(), serde_json::json!("consent-123"));
        m.insert("command".into(), serde_json::json!("click"));
        m.insert("surface".into(), serde_json::json!("computerUse"));
        m.insert("processName".into(), serde_json::json!("Xcode"));
        m.insert(
            "windowTitle".into(),
            serde_json::json!("Re: severance package.xlsx"),
        );
        m.insert(
            "commandDetail".into(),
            serde_json::json!("rm -rf ~/Documents/secret"),
        );
        m.insert("sessionKey".into(), serde_json::json!("session-a"));
        m.insert(
            "thumbnail".into(),
            serde_json::json!({ "bytes": "A".repeat(40_000), "width": 640, "height": 400, "redacted": false }),
        );
        m
    }

    #[test]
    fn push_body_strips_any_scheme_prefix() {
        assert_eq!(
            push_body_for_channel("claude://message-added", &empty_data()),
            "message-added"
        );
        assert_eq!(
            push_body_for_channel("companion://needs-input", &empty_data()),
            "needs-input"
        );
        assert_eq!(
            push_body_for_channel("workflow://run-terminal", &empty_data()),
            "run-terminal"
        );
        assert_eq!(
            push_body_for_channel("no-scheme", &empty_data()),
            "no-scheme"
        );
    }

    /// A decision prompt must not put the tool name on a lock screen, and the
    /// routing list must not transit the push provider either.
    #[test]
    fn needs_input_push_carries_ids_and_neither_the_tool_name_nor_the_audience() {
        let mut raw = serde_json::Map::new();
        raw.insert("sessionId".into(), serde_json::json!("s-1"));
        raw.insert("requestId".into(), serde_json::json!("req-1"));
        raw.insert(
            "href".into(),
            serde_json::json!("/remote-sessions?session=s-1"),
        );
        raw.insert("dedupeKey".into(), serde_json::json!("req-1"));
        raw.insert("toolName".into(), serde_json::json!("Bash"));
        raw.insert("input".into(), serde_json::json!("rm -rf /"));
        raw.insert("targetDeviceIds".into(), serde_json::json!(["dev-a"]));

        let data = push_data_for_channel(NEEDS_INPUT_CHANNEL, &raw);

        assert_eq!(data.get("sessionId").unwrap(), "s-1");
        assert_eq!(data.get("requestId").unwrap(), "req-1");
        assert_eq!(data.get("source").unwrap(), "remote-session");
        assert!(data.get("toolName").is_none());
        assert!(data.get("input").is_none());
        assert!(data.get("targetDeviceIds").is_none());
    }

    /// `None` (broadcast) and `Some(vec![])` (audience computed, and empty) are
    /// different answers. Collapsing them would turn "no attached device needs
    /// this" back into "wake every paired phone".
    #[test]
    fn needs_input_targets_are_addressed_while_other_channels_broadcast() {
        let mut raw = serde_json::Map::new();
        raw.insert(
            "targetDeviceIds".into(),
            serde_json::json!(["dev-a", "dev-b"]),
        );
        assert_eq!(
            push_targets_for(NEEDS_INPUT_CHANNEL, &raw),
            Some(vec!["dev-a".to_string(), "dev-b".to_string()])
        );

        let mut empty = serde_json::Map::new();
        empty.insert("targetDeviceIds".into(), serde_json::json!([]));
        assert_eq!(push_targets_for(NEEDS_INPUT_CHANNEL, &empty), Some(vec![]));

        // An older client that emits no audience at all still broadcasts, so
        // upgrading the Host never silently stops delivering.
        assert_eq!(push_targets_for(NEEDS_INPUT_CHANNEL, &empty_data()), None);
        assert_eq!(push_targets_for("claude://message-added", &raw), None);
    }

    /// ADR-0131 — the inbound-IM push says WHO and WHERE, never WHAT. The
    /// body is readable on a lock screen, so the message text must never
    /// reach it; `push_data_for_channel` likewise passes ids + href only.
    #[test]
    fn connector_message_added_push_body_names_sender_not_message() {
        let mut data = serde_json::Map::new();
        data.insert("senderName".into(), serde_json::json!("Ada"));
        data.insert("platform".into(), serde_json::json!("Telegram"));
        data.insert("text".into(), serde_json::json!("the secret is 42"));
        let body = push_body_for_channel(CONNECTOR_MESSAGE_ADDED_CHANNEL, &data);
        assert_eq!(body, "New message from Ada on Telegram");
        assert!(
            !body.contains("42"),
            "message text must never ride the push"
        );

        // Missing display name / platform degrade, never panic.
        assert_eq!(
            push_body_for_channel(CONNECTOR_MESSAGE_ADDED_CHANNEL, &empty_data()),
            "New message"
        );
        let mut only_platform = serde_json::Map::new();
        only_platform.insert("platform".into(), serde_json::json!("Slack"));
        assert_eq!(
            push_body_for_channel(CONNECTOR_MESSAGE_ADDED_CHANNEL, &only_platform),
            "New message on Slack"
        );
    }

    #[test]
    fn consent_push_body_names_action_and_process() {
        assert_eq!(
            push_body_for_channel(AUTOMATION_CONSENT_CHANNEL, &consent_payload()),
            "Confirm click in Xcode"
        );
    }

    #[test]
    fn consent_push_body_never_leaks_the_window_title() {
        let body = push_body_for_channel(AUTOMATION_CONSENT_CHANNEL, &consent_payload());
        assert!(
            !body.contains("severance"),
            "lock-screen text must not carry the window title, got {body:?}"
        );
        assert!(
            !body.contains("rm -rf"),
            "lock-screen text must not carry the command detail, got {body:?}"
        );
    }

    #[test]
    fn consent_push_body_degrades_without_a_process_name() {
        let mut payload = consent_payload();
        payload.remove("processName");
        assert_eq!(
            push_body_for_channel(AUTOMATION_CONSENT_CHANNEL, &payload),
            "Confirm click"
        );
    }

    #[test]
    fn consent_push_data_is_allowlisted_to_ids() {
        let data = push_data_for_channel(AUTOMATION_CONSENT_CHANNEL, &consent_payload());
        assert_eq!(data.get("id").and_then(|v| v.as_str()), Some("consent-123"));
        assert_eq!(data.get("href").and_then(|v| v.as_str()), Some("/"));
        for leaked in ["thumbnail", "windowTitle", "commandDetail", "sessionKey"] {
            assert!(
                !data.contains_key(leaked),
                "{leaked} must never transit a push provider"
            );
        }
    }

    #[test]
    fn consent_push_data_stays_under_the_provider_payload_ceiling() {
        // APNs and FCM both cap a notification payload at ~4 KB. The raw frame
        // is far past that because of the thumbnail; the sanitized projection
        // must not be.
        let data = push_data_for_channel(AUTOMATION_CONSENT_CHANNEL, &consent_payload());
        let encoded = serde_json::to_string(&data).expect("data serializes");
        assert!(
            encoded.len() < 4096,
            "sanitized push data is {} bytes, over the ~4 KB provider ceiling",
            encoded.len()
        );
    }

    fn run_approval_payload(
        kind: &str,
        class: Option<&str>,
    ) -> serde_json::Map<String, serde_json::Value> {
        let mut m = serde_json::Map::new();
        m.insert(
            "interruptId".into(),
            serde_json::json!("tool-interrupt:r1:q1"),
        );
        m.insert("runId".into(), serde_json::json!("r1"));
        m.insert("type".into(), serde_json::json!(kind));
        if let Some(class) = class {
            m.insert("permissionClass".into(), serde_json::json!(class));
        }
        m.insert(
            "title".into(),
            serde_json::json!("Post the secret plan to #general"),
        );
        m.insert("href".into(), serde_json::json!("/bots"));
        m.insert(
            "dedupeKey".into(),
            serde_json::json!("run-approval:tool-interrupt:r1:q1"),
        );
        m.insert("expiresAt".into(), serde_json::json!(1_700_000_000_000_u64));
        m
    }

    #[test]
    fn run_approval_pending_is_a_push_trigger() {
        assert!(PUSH_TRIGGER_CHANNELS.contains(&RUN_APPROVAL_PENDING_CHANNEL));
        assert!(!PUSH_TRIGGER_CHANNELS.contains(&"run://approval-resolved"));
    }

    #[test]
    fn run_approval_push_body_names_the_class_never_the_title() {
        for (kind, class, expected) in [
            (
                "tool_approval",
                Some("outbound"),
                "Approve an outbound message from an unattended run",
            ),
            (
                "tool_approval",
                Some("secrets"),
                "Approve secret use by an unattended run",
            ),
            (
                "tool_approval",
                Some("hostConfig"),
                "Approve a host change by an unattended run",
            ),
            (
                "tool_approval",
                Some("workspace"),
                "Approve a workspace change by an unattended run",
            ),
            (
                "tool_approval",
                None,
                "An unattended run is waiting for your approval",
            ),
            ("bot_approval", None, "A Bot is waiting for your approval"),
        ] {
            let body = push_body_for_channel(
                RUN_APPROVAL_PENDING_CHANNEL,
                &run_approval_payload(kind, class),
            );
            assert_eq!(body, expected);
            assert!(!body.contains("secret plan"), "title leaked: {body:?}");
        }
    }

    #[test]
    fn run_approval_push_data_is_allowlisted_to_ids() {
        let data = push_data_for_channel(
            RUN_APPROVAL_PENDING_CHANNEL,
            &run_approval_payload("tool_approval", Some("outbound")),
        );
        assert_eq!(
            data.get("interruptId").and_then(|v| v.as_str()),
            Some("tool-interrupt:r1:q1")
        );
        assert_eq!(
            data.get("permissionClass").and_then(|v| v.as_str()),
            Some("outbound")
        );
        assert_eq!(data.get("href").and_then(|v| v.as_str()), Some("/bots"));
        // Filed under a source the phone's notification center knows, and
        // grouped per question.
        assert_eq!(data.get("source").and_then(|v| v.as_str()), Some("system"));
        assert_eq!(data.get("level").and_then(|v| v.as_str()), Some("warning"));
        assert_eq!(
            data.get("notificationId").and_then(|v| v.as_str()),
            Some("run-approval:tool-interrupt:r1:q1")
        );
        assert!(
            !data.contains_key("title"),
            "the title must never transit a push provider"
        );
        // Non-string values are not carried either.
        assert!(!data.contains_key("expiresAt"));

        let mut scheduled = run_approval_payload("tool_approval", Some("outbound"));
        scheduled.insert("href".into(), serde_json::json!("/scheduler"));
        let data = push_data_for_channel(RUN_APPROVAL_PENDING_CHANNEL, &scheduled);
        assert_eq!(
            data.get("source").and_then(|v| v.as_str()),
            Some("scheduler")
        );
    }

    #[test]
    fn other_channels_pass_their_payload_through_untouched() {
        let mut m = serde_json::Map::new();
        m.insert("runId".into(), serde_json::json!("run-1"));
        let data = push_data_for_channel("workflow://run-terminal", &m);
        assert_eq!(data.get("runId").and_then(|v| v.as_str()), Some("run-1"));
    }
}
