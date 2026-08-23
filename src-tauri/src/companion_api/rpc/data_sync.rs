use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "register_push_token",
    "revoke_push_token",
    "remote_notification_publish",
    "sync_list_tables",
    "sync_pull",
    "message_update",
    "message_delete",
    "session_list",
    "message_get_by_session",
    "transcript_capabilities",
    "session_timeline",
    "session_turn_messages",
    "message_send",
    "background_job_list",
    "background_job_read",
    "background_job_kill",
    "background_job_spawn_scheduled",
    "background_monitor_list",
    "background_monitor_cancel",
    "background_monitor_register_scheduled",
    "workflow_approval_list",
    "workflow_approval_respond",
    "character_upsert",
    "character_delete",
    "character_bind_twin",
    "skill_set_enabled",
    "plugin_set_enabled",
    "mcp_set_enabled",
    "mcp_set_tool_rules",
    "adapter_update_policy",
    "twin_profile_get",
    "host_capabilities",
    "host_feature_manifest",
    "host_state_snapshot",
    "host_state_submit",
    "host_state_status",
    "provider_diagnostics_status",
    "provider_diagnostics_history",
    "provider_diagnostics_start",
    "provider_diagnostics_cancel",
    "connector_send",
    "connector_enqueue_outbound",
    "connector_approve_draft",
    "connector_reject_draft",
    "workflow_trigger_manual",
    "twin_ingest_source",
    "device_capabilities_report",
    "session_attach",
    "session_detach",
    "session_attachment_upload_init",
    "session_attachment_upload_chunk",
    "session_attachment_upload_commit",
    "session_attachment_upload_abort",
    "goal_pause",
    "goal_resume",
    "goal_stop",
    "team_task_move",
    "team_task_create",
    "team_task_comment",
    "team_run_pause",
    "team_run_resume",
    "team_run_stop",
    "agent_task_start",
    "agent_task_pause",
    "agent_task_resume",
    "agent_task_cancel",
    "agent_task_comment",
    "agent_task_move",
    "workflow_create",
    "workflow_update",
    "workflow_delete",
    "workflow_run_list",
    "workflow_cancel_run",
    "workflow_schedule_pause",
    "workflow_schedule_resume",
    "scheduled_task_list",
    "scheduled_task_get",
    "scheduled_task_runs",
    "scheduled_task_statistics",
    "scheduled_task_upcoming",
    "scheduled_task_export",
    "scheduled_task_create",
    "scheduled_task_update",
    "scheduled_task_delete",
    "scheduled_task_pause",
    "scheduled_task_resume",
    "scheduled_task_run_now",
    "scheduled_task_backfill",
    "scheduled_task_import",
    "scheduled_task_cleanup",
    "scheduled_task_emit_event",
    "workflow_step_result",
    "twin_delete",
    "twin_source_list",
    "twin_source_update",
    "twin_source_delete",
    "twin_job_status",
    "twin_job_cancel",
    "twin_job_pause",
    "twin_job_resume",
    "twin_job_retry",
    "twin_create",
    "twin_source_create",
    "twin_draft_review",
    "twin_profile_update",
    "goal_create",
    "goal_update",
    "goal_status",
    "memory_search",
    "memory_list",
    "memory_store",
    "memory_update",
    "memory_forget",
    "retrieval_profile_dek_export",
    "conversation_overrides_update",
    "backup_export",
    "backup_import",
    "external_agent_list",
    "external_agent_update",
    "perf_close_lease",
    "perf_hotspots",
    "perf_lease_snapshot",
    "perf_list_traces",
    "perf_open_lease",
    "perf_read_observations",
    "perf_renew_lease",
    "perf_trace_close",
    "perf_trace_open",
    "perf_trace_read_chunk",
    "perf_system_details",
];

fn validate_content_protocol(
    table: &str,
    content_protocol_version: Option<u64>,
) -> Result<(), (StatusCode, Json<RpcError>)> {
    if table == "memories" && content_protocol_version != Some(1) {
        return Err(RpcError::upgrade_required(
            "retrieval content protocol v1 is required for memory sync".to_string(),
        ));
    }
    Ok(())
}

/// Whether a durable-waitpoint command must be answered by the host's TS layer
/// rather than the local Rust `workflow_waitpoint` mirror.
///
/// True only on headless hosts: the mirror's sole writer is the
/// `workflow_waitpoint_create` Tauri command, which a Node brain cannot reach,
/// so its Dexie holds the only copy of a pending approval. On a Tauri host the
/// renderer mirrors every waitpoint into SQLite, and answering natively is what
/// lets a paired device decide while the WebView is asleep.
fn waitpoint_command_needs_ts_authority(name: &str, headless: bool) -> bool {
    headless && matches!(name, "workflow_approval_list" | "workflow_approval_respond")
}

pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &super::super::dispatch_host::DispatchHost,
    device_id: &str,
    account_id: Option<&str>,
    scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    use tauri::Manager as _;

    let _ = (state, host, device_id, account_id, scope);
    let result = match name {
        // ── Sync down (M4.7) ──────────────────────────────────────────────────

        "register_push_token" => {
            // Wave 3.4 — phone hands its FCM/APNs token to the desktop
            // so the dispatcher can route inbound events to the device
            // when no WS subscription is live. Idempotent: re-registering
            // overwrites the previous record.
            let provider_str: String = required(&args, "provider")?;
            let token: String = required(&args, "token")?;
            let provider = match provider_str.as_str() {
                "fcm" => crate::companion_api::push::PushProvider::Fcm,
                "apns" => crate::companion_api::push::PushProvider::Apns,
                other => {
                    return Err(RpcError::malformed(format!(
                        "register_push_token.provider must be 'fcm' or 'apns', got '{other}'"
                    )));
                }
            };
            let app_version: Option<String> = optional(&args, "app_version")?;
            let device_locale: Option<String> = optional(&args, "device_locale")?;
            state
                .push_tokens
                .register(crate::companion_api::push::PushTokenRecord {
                    device_id: device_id.to_string(),
                    provider,
                    token,
                    app_version,
                    device_locale,
                    registered_at: chrono::Utc::now().timestamp_millis(),
                });
            Ok(Value::Null)
        }

        "revoke_push_token" => {
            // Phone explicitly clears its token (sign-out / token rotation).
            state.push_tokens.revoke(device_id);
            Ok(Value::Null)
        }

        "remote_notification_publish" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let title: String = required(&args, "title")?;
            let body: String = required(&args, "body")?;
            let level: Option<String> = optional(&args, "level")?;
            let level = level.unwrap_or_else(|| "info".into());
            if title.trim().is_empty() || title.len() > 160 || title.chars().any(char::is_control) {
                return Err(RpcError::malformed(
                    "remote_notification_publish.title must be 1..160 printable bytes".into(),
                ));
            }
            if body.trim().is_empty() || body.len() > 2_000 {
                return Err(RpcError::malformed(
                    "remote_notification_publish.body must be 1..2000 bytes".into(),
                ));
            }
            if !matches!(level.as_str(), "info" | "success" | "warning" | "error") {
                return Err(RpcError::malformed(
                    "remote_notification_publish.level is invalid".into(),
                ));
            }
            let href: Option<String> = optional(&args, "href")?;
            if href.as_deref().is_some_and(|value| {
                !value.starts_with('/') || value.starts_with("//") || value.len() > 512
            }) {
                return Err(RpcError::malformed(
                    "remote_notification_publish.href must be an app-relative path".into(),
                ));
            }
            let id: Option<String> = optional(&args, "id")?;
            let id = id.unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
            if id.trim().is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
                return Err(RpcError::malformed(
                    "remote_notification_publish.id must be 1..128 printable bytes".into(),
                ));
            }
            // Optional originating subsystem (`NotificationSource` on the TS
            // side: scheduler / workflow / connector / …) so a companion files
            // the record under the right source preference. Free-form but
            // bounded; the client falls back to `system` when absent/unknown.
            let source: Option<String> = optional(&args, "source")?;
            if source.as_deref().is_some_and(|value| {
                value.trim().is_empty()
                    || value.len() > 64
                    || !value
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':')
            }) {
                return Err(RpcError::malformed(
                    "remote_notification_publish.source must be 1..64 [A-Za-z0-9_:-] bytes".into(),
                ));
            }
            state.event_bus.publish(
                "notification://remote".to_string(),
                json!({
                    "id": id,
                    "title": title,
                    "body": body,
                    "level": level,
                    "href": href,
                    "source": source,
                    "createdAt": chrono::Utc::now().timestamp_millis(),
                }),
            );
            Ok(json!({ "id": id }))
        }

        "sync_list_tables" => {
            // Wave 3.5 introspection — surface every registered Dexie
            // table the phone is allowed to mirror. Used by the mobile
            // shell to discover plugin-added tables without a release.
            let descriptors = state.sync_registry.list();
            let payload: Vec<serde_json::Value> = descriptors
                .into_iter()
                .map(|d| {
                    serde_json::json!({
                        "name": d.name,
                        "description": d.description,
                        "hasTombstones": d.has_tombstones,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "tables": payload }))
        }

        "sync_pull" => {
            let table: String = required(&args, "table")?;
            let since: i64 = optional::<i64>(&args, "since")?.unwrap_or(0);
            let content_protocol_version = optional::<u64>(&args, "content_protocol_version")?;
            validate_content_protocol(&table, content_protocol_version)?;
            let account_id = account_id.ok_or_else(|| {
        RpcError::forbidden("sync_pull requires an account-bound device principal")
            })?;
            // Wave 3.5 — table allowlist now lives on the declarative
            // `SyncTableRegistry` (`sync_registry.rs`) so plugins can
            // register new tables at boot without a code edit here.
            // The `with_defaults()` factory seeds the 9 Wave 1+2 tables.
            if !state.sync_registry.contains(&table) {
                return Err(RpcError::malformed(format!(
                    "table '{table}' is not exposed to mobile sync"
                )));
            }
            let bridge = std::sync::Arc::clone(&state.sync_bridge);
            // Connected brain first, desktop WebView second (ADR-0059 R4/R5);
            // 503 while a headless server's brain is down — sync has no
            // degraded-store path.
            let transport = super::super::ws_bridge::resolve_bridge_transport(state)
                .map_err(RpcError::service_unavailable)?;
            // The principal's `account_id` is a *tenant*; the responder on the
            // far side (`desktop-sync-source`) checks it against its unlocked
            // local account id and refuses a mismatch. Translating here is the
            // same fix applied to `companion://device-paired`: two id spaces
            // that only matched while the tenant was a hardcoded literal.
            let account_namespace =
                crate::companion_api::host_identity::event_namespace_for_tenant(account_id);
            bridge
                .pull(
                    transport.as_ref(),
                    table,
                    since,
                    account_namespace,
                    content_protocol_version,
                    crate::companion_api::sync_bridge::DEFAULT_TIMEOUT,
                )
                .await
                .map_err(RpcError::internal)
        }

        // ── Desktop-message bridge (Mobile completeness P2) ──────────────────
        //
        // All five message / session RPCs route through `DataPlane::pick`,
        // which selects the Tauri-bridge variant (existing desktop flow) or
        // the Direct variant against a `SqliteAppStore` in headless mode
        // (Phase D). The return shape is identical so the rest of the RPC
        // pipeline stays unchanged.

        "message_update" => {
            let session_id: String = required(&args, "session_id")?;
            let message_id: String = required(&args, "message_id")?;
            let updates: Value = required(&args, "updates")?;
            let dp = pick_data_plane(state)?;
            let result = dp
                .update_message(session_id.clone(), message_id, updates)
                .await
                .map_err(RpcError::internal)?;
            publish_direct_transcript_revision(state, &dp, &session_id).await;
            Ok(result)
        }

        "message_delete" => {
            let session_id: String = required(&args, "session_id")?;
            let message_id: String = required(&args, "message_id")?;
            let dp = pick_data_plane(state)?;
            let result = dp
                .delete_message(session_id.clone(), message_id)
                .await
                .map_err(RpcError::internal)?;
            publish_direct_transcript_revision(state, &dp, &session_id).await;
            Ok(result)
        }

        "session_list" => {
            let limit: u32 = required(&args, "limit")?;
            let offset: u32 = required(&args, "offset")?;
            let before: Option<i64> = optional(&args, "before")?;
            let dp = pick_data_plane(state)?;
            dp.list_sessions(limit, offset, before)
                .await
                .map_err(RpcError::internal)
        }

        "message_get_by_session" => {
            let session_id: String = required(&args, "session_id")?;
            let limit: Option<u32> = optional(&args, "limit")?;
            let offset: Option<u32> = optional(&args, "offset")?;
            let dp = pick_data_plane(state)?;
            dp.get_messages_by_session(session_id, limit, offset)
                .await
                .map_err(RpcError::internal)
        }

        "transcript_capabilities" => {
            let dp = pick_data_plane(state)?;
            dp.transcript_capabilities()
                .await
                .map_err(RpcError::internal)
        }

        "session_timeline" => {
            let session_id: String = required(&args, "session_id")?;
            let direction: Option<String> = optional(&args, "direction")?;
            let cursor: Option<String> = optional(&args, "cursor")?;
            let limit: Option<u32> = optional(&args, "limit")?;
            let dp = pick_data_plane(state)?;
            dp.session_timeline(session_id, direction, cursor, limit)
                .await
                .map_err(RpcError::internal)
        }

        "session_turn_messages" => {
            let session_id: String = required(&args, "session_id")?;
            let turn_key: String = required(&args, "turn_key")?;
            let revision: u64 = required(&args, "revision")?;
            let detail_revision: u64 = required(&args, "detail_revision")?;
            let cursor: Option<String> = optional(&args, "cursor")?;
            let limit: Option<u32> = optional(&args, "limit")?;
            let dp = pick_data_plane(state)?;
            dp.session_turn_messages(
                session_id,
                turn_key,
                revision,
                detail_revision,
                cursor,
                limit,
            )
            .await
            .map_err(RpcError::internal)
        }

        "message_send" => {
            let session_id: String = required(&args, "session_id")?;
            let content: String = required(&args, "content")?;
            let role: Option<String> = optional(&args, "role")?;
            let dp = pick_data_plane(state)?;
            let result = dp
                .send_message(session_id.clone(), content, role)
                .await
                .map_err(RpcError::internal)?;
            publish_direct_transcript_revision(state, &dp, &session_id).await;
            Ok(result)
        }

        // ── Rust-owned background jobs and durable monitors ─────────────────
        // These calls never depend on a renderer bridge, so they keep working
        // on a headless host and when the desktop WebView is suspended.
        "background_job_list" => crate::jobs::dispatch_host_rpc("jobs.list", &args)
            .await
            .map_err(RpcError::internal),
        "background_job_read" => crate::jobs::dispatch_host_rpc("jobs.read", &args)
            .await
            .map_err(RpcError::internal),
        "background_job_kill" => crate::jobs::dispatch_host_rpc("jobs.kill", &args)
            .await
            .map_err(RpcError::internal),
        "background_job_spawn_scheduled" => {
            let task_id: String = required(&args, "taskId")?;
            let command: String = required(&args, "command")?;
            let cwd: std::path::PathBuf = required(&args, "cwd")?;
            let label: Option<String> = optional(&args, "label")?;
            crate::jobs::background_job_spawn_scheduled(task_id, command, cwd, label)
                .await
                .map_err(RpcError::internal)
        }
        "background_monitor_list" => crate::jobs::dispatch_host_rpc("monitors.list", &args)
            .await
            .map_err(RpcError::internal),
        "background_monitor_cancel" => crate::jobs::dispatch_host_rpc("monitors.cancel", &args)
            .await
            .map_err(RpcError::internal),
        "background_monitor_register_scheduled" => {
            let task_id: String = required(&args, "taskId")?;
            let condition: cognia_jobs::MonitorCondition = required(&args, "condition")?;
            let expires_at_ms: Option<i64> = optional(&args, "expiresAtMs")?;
            let label: Option<String> = optional(&args, "label")?;
            crate::jobs::background_monitor_register_scheduled(
                task_id,
                condition,
                expires_at_ms,
                label,
            )
            .await
                .map_err(RpcError::internal)
        }

        // ── Durable workflow waitpoints ─────────────────────────────────────
        // Which store is authoritative depends on the host, so these two
        // commands take one of two paths.
        //
        // Headless: the brain's Dexie is the only copy. The sole writer of the
        // Rust `workflow_waitpoint` table is the `workflow_waitpoint_create`
        // Tauri command, and a Node brain cannot reach it —
        // `lib/workflow/runtime/tauri-bridge.ts` short-circuits every native
        // call to `null` off-Tauri. So route to the brain's TS arms in
        // `lib/companion/desktop-write-source.ts`. Answering from the
        // always-empty local mirror instead left the phone's pending-approvals
        // card permanently blank on a cloud host and let every approval gate
        // run out its timeout onto the `rejected` branch.
        "workflow_approval_list" | "workflow_approval_respond"
            if waitpoint_command_needs_ts_authority(
                name,
                matches!(
                    host,
                    super::super::dispatch_host::DispatchHost::Headless(_)
                ),
            ) =>
        {
            let args = inject_caller_device_id(name, args, device_id);
            let bridge = std::sync::Arc::clone(&state.desktop_writes_bridge);
            let transport = super::super::ws_bridge::resolve_bridge_transport(state)
                .map_err(RpcError::service_unavailable)?;
            bridge
                .dispatch(
                    transport.as_ref(),
                    name,
                    args,
                    crate::companion_api::desktop_writes_bridge::DEFAULT_TIMEOUT,
                )
                .await
                .map_err(|error| map_desktop_write_bridge_error(name, error))
        }

        // Tauri: host-owned SQLite is the authority — the renderer mirrors every
        // waitpoint into it, so a paired device can decide while the WebView is
        // asleep and the renderer observes the terminal row when it resumes
        // polling (`getWorkflowWaitpoint` reads native-first).
        "workflow_approval_list" => {
            let rows = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => app
                    .state::<crate::workflow::WorkflowState>()
                    .mirror
                    .list_pending_waitpoints(),
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    services.workflow.mirror.list_pending_waitpoints()
                }
            }
            .map_err(|error| RpcError::internal(error.to_string()))?;
            let approvals: Vec<Value> = rows
                .into_iter()
                .filter(|row| row.kind == "approval" || row.kind == "risk_gate")
                .map(|row| {
                    json!({
                        "approvalId": row.id,
                        "runId": row.run_id,
                        "workflowId": row.workflow_id,
                        "stepId": row.step_id,
                        "title": row.title.unwrap_or_else(|| "Approval required".to_string()),
                        "message": row.message,
                        "requestedAt": row.created_at,
                        "timeoutAt": row.expires_at,
                        "kind": row.kind,
                    })
                })
                .collect();
            Ok(json!({ "approvals": approvals }))
        }
        "workflow_approval_respond" => {
            let approval_id: String = required_aliased(&args, "approval_id", "approvalId")?;
            let decision: String = required(&args, "decision")?;
            if decision != "approved" && decision != "rejected" {
                return Err(RpcError::malformed(
                    "workflow_approval_respond.decision must be 'approved' or 'rejected'"
                        .to_string(),
                ));
            }
            let resolved_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);
            let input = crate::workflow::types::WorkflowWaitpointDecisionInput {
                id: approval_id.clone(),
                status: if decision == "approved" {
                    "resolved".to_string()
                } else {
                    "rejected".to_string()
                },
                resolution: json!({
                    "outcome": decision,
                    "respondedBy": format!("device:{device_id}"),
                    "resolvedAt": resolved_at,
                }),
                updated_at: resolved_at,
            };
            let (changed, exists) = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    let changed = workflow.mirror.decide_waitpoint(&input);
                    let exists = workflow.mirror.get_waitpoint(&approval_id);
                    (changed, exists)
                }
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    let changed = services.workflow.mirror.decide_waitpoint(&input);
                    let exists = services.workflow.mirror.get_waitpoint(&approval_id);
                    (changed, exists)
                }
            };
            let changed = changed.map_err(|error| RpcError::internal(error.to_string()))?;
            let exists = exists
                .map_err(|error| RpcError::internal(error.to_string()))?
                .is_some();
            Ok(if changed {
                json!({ "ok": true })
            } else if exists {
                json!({ "ok": false, "reason": "already-decided" })
            } else {
                json!({ "ok": false, "reason": "not-found" })
            })
        }

        // ── Desktop-write bridge (Wave 2 mutating RPCs) ──────────────────────
        // All commands route through one generic bridge that emits
        // `companion://desktop-write-request` with `{ command, payload }`.
        // The desktop WebView dispatches by command name and resolves via
        // the `companion_desktop_write_response` Tauri command.
        "character_upsert"
        | "character_delete"
        | "character_bind_twin"
        | "skill_set_enabled"
        | "plugin_set_enabled"
        // MCP server enable/disable + per-tool deny rules. Definition CRUD is
        // deliberately absent: it carries credentials and a trust decision.
        | "mcp_set_enabled"
        | "mcp_set_tool_rules"
        | "adapter_update_policy"
        | "twin_profile_get"
        | "host_capabilities"
        | "host_feature_manifest"
        | "host_state_snapshot"
        | "host_state_submit"
        | "host_state_status"
        | "provider_diagnostics_status"
        | "provider_diagnostics_history"
        | "provider_diagnostics_start"
        | "provider_diagnostics_cancel"
        | "perf_close_lease"
        | "perf_hotspots"
        | "perf_lease_snapshot"
        | "perf_list_traces"
        | "perf_open_lease"
        | "perf_read_observations"
        | "perf_renew_lease"
        | "perf_trace_close"
        | "perf_trace_open"
        | "perf_trace_read_chunk"
        | "perf_system_details"
        // Mobile outbound-queue RPCs — same generic bridge, different
        // TS-side dispatch arms in `lib/companion/desktop-write-source.ts`.
        | "connector_send"
        // ADR-0131 cross-shell inbox relay — a phone / web companion /
        // desktop driving this host enqueues the real outbound job here;
        // the TS arm replays idempotently on `request.metadata.idempotencyKey`.
        | "connector_enqueue_outbound"
        | "connector_approve_draft"
        | "connector_reject_draft"
        | "workflow_trigger_manual"
        | "twin_ingest_source"
        // ADR-0060 — device capability report; TS arm persists onto the
        // caller's `pairedDevices` row (caller id injected below).
        | "device_capabilities_report"
        // Remote Session Control — attach/detach a remote watcher + steer
        // host goal loops. Same generic bridge; TS-side dispatch arms live in
        // `lib/companion/desktop-write-source.ts`. Gated by CONTROL_COMMANDS.
        | "session_attach"
        | "session_detach"
        // Remote Session Control — chunked attachment upload. The chunk arm is
        // the only bridged command whose body is dominated by payload rather
        // than parameters; it is sized against the RPC body ceiling, not the
        // file (see `limits.attachmentUploadChunkBytes`).
        | "session_attachment_upload_init"
        | "session_attachment_upload_chunk"
        | "session_attachment_upload_commit"
        | "session_attachment_upload_abort"
        | "goal_pause"
        | "goal_resume"
        | "goal_stop"
        // Agent-Team board control (team-board CQRS) — same generic bridge;
        // TS arms in `lib/companion/agent-team-write-handlers.ts` validate
        // through the shared `canMoveTask` guard. Gated by CONTROL_COMMANDS.
        | "team_task_move"
        | "team_task_create"
        | "team_task_comment"
        | "team_run_pause"
        | "team_run_resume"
        | "team_run_stop"
        // Single-Agent task board control — TS arms validate Agent ownership,
        // state-machine moves, and Scheduler lifecycle actions.
        | "agent_task_start"
        | "agent_task_pause"
        | "agent_task_resume"
        | "agent_task_cancel"
        | "agent_task_comment"
        | "agent_task_move"
        // Wave 4.1 — Workflow CRUD, Twin source/job control, conversation
        // overrides, and app-data backup. Same generic bridge; TS-side dispatch
        // arms live in `lib/companion/desktop-write-source.ts`. Destructive
        // members are gated by CONTROL_COMMANDS; reads are in READ_ONLY_COMMANDS.
        | "workflow_create"
        | "workflow_update"
        | "workflow_delete"
        | "workflow_run_list"
        | "workflow_cancel_run"
        | "workflow_schedule_pause"
        | "workflow_schedule_resume"
        // App scheduler CRUD/data plane. The bridge resolves to the connected
        // brain first, so a remote desktop operates the host's durable Dexie
        // scheduler rather than its own local database.
        | "scheduled_task_list"
        | "scheduled_task_get"
        | "scheduled_task_runs"
        | "scheduled_task_statistics"
        | "scheduled_task_upcoming"
        | "scheduled_task_export"
        | "scheduled_task_create"
        | "scheduled_task_update"
        | "scheduled_task_delete"
        | "scheduled_task_pause"
        | "scheduled_task_resume"
        | "scheduled_task_run_now"
        | "scheduled_task_backfill"
        | "scheduled_task_import"
        | "scheduled_task_cleanup"
        | "scheduled_task_emit_event"
        // ADR-0061 P2 — HITL approval gate; respond gets callerDeviceId
        // injected below so the responder identity is spoof-proof.
        // ADR-0061 P3 — chunked result for a desktop-issued remote step.
        | "workflow_step_result"
        | "twin_delete"
        | "twin_source_list"
        | "twin_source_update"
        | "twin_source_delete"
        | "twin_job_status"
        | "twin_job_cancel"
        | "twin_job_pause"
        | "twin_job_resume"
        | "twin_job_retry"
        | "twin_create"
        | "twin_source_create"
        | "twin_draft_review"
        | "twin_profile_update"
        | "goal_create"
        | "goal_update"
        | "goal_status"
        // Long-term memory (ADR-0069) — same generic bridge; TS-side dispatch
        // arms in `lib/companion/desktop-write-source.ts` delegate to the
        // shared `lib/memory/api/*` helpers (PII gate, `external` provenance,
        // never procedural). Writes are gated by CONTROL_COMMANDS.
        | "memory_search"
        | "memory_list"
        | "memory_store"
        | "memory_update"
        | "memory_forget"
        | "retrieval_profile_dek_export"
        | "conversation_overrides_update"
        | "backup_export"
        | "backup_import"
        // ADR-0056 Wave 4 — external-agent list (read) + update (enable/disable
        // + permission mode). TS-side dispatch arms in
        // `lib/companion/desktop-write-source.ts`.
        | "external_agent_list"
        | "external_agent_update" => {
            // ADR-0060: some TS dispatch arms must know the authenticated
            // caller device. Injected server-side (overwriting any
            // client-sent value) so a device can never spoof another's id.
            let args = inject_caller_device_id(name, args, device_id);
            let args = inject_caller_event_streams(name, args, device_id);
            let args = inject_caller_device_grants(name, args, state, device_id, account_id);
            let args = if super::host_state::COMMANDS.contains(&name) {
                super::host_state::bind_authority(args, state, account_id, device_id)?
            } else {
                args
            };
            let bridge = std::sync::Arc::clone(&state.desktop_writes_bridge);
            // Connected brain first, desktop WebView second (ADR-0059 R4/R5).
            let transport = super::super::ws_bridge::resolve_bridge_transport(state)
                .map_err(RpcError::service_unavailable)?;
            bridge
                .dispatch(
                    transport.as_ref(),
                    name,
                    args,
                    crate::companion_api::desktop_writes_bridge::DEFAULT_TIMEOUT,
                )
                .await
                .map_err(|error| map_desktop_write_bridge_error(name, error))
        }
        unknown => Err(RpcError::unknown_command(unknown)),
    };
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headless_hosts_route_approval_commands_to_the_ts_authority() {
        for name in ["workflow_approval_list", "workflow_approval_respond"] {
            assert!(
                waitpoint_command_needs_ts_authority(name, true),
                "{name} must reach the brain's Dexie on a headless host; the Rust waitpoint mirror is never written there"
            );
            assert!(
                !waitpoint_command_needs_ts_authority(name, false),
                "{name} must stay native on Tauri so a device can decide while the WebView is asleep"
            );
        }
    }

    #[test]
    fn no_other_command_is_diverted_to_the_ts_authority() {
        for name in COMMANDS {
            if matches!(
                *name,
                "workflow_approval_list" | "workflow_approval_respond"
            ) {
                continue;
            }
            assert!(
                !waitpoint_command_needs_ts_authority(name, true),
                "{name} was diverted off its own dispatch arm"
            );
        }
    }

    #[test]
    fn approval_respond_carries_the_verified_caller_device_id() {
        // The native arm stamps `device:{device_id}` itself; the headless arm
        // hands the decision to TS, which reads `callerDeviceId`. That field is
        // only injected for commands on the allowlist, so dropping it there
        // would silently strip the responder identity from every cloud-host
        // approval.
        assert_eq!(
            inject_caller_device_id(
                "workflow_approval_respond",
                serde_json::json!({ "approvalId": "apr_1", "callerDeviceId": "spoofed" }),
                "dev-real",
            )["callerDeviceId"],
            serde_json::json!("dev-real")
        );
    }

    #[test]
    fn command_family_is_non_empty_and_unique() {
        assert!(!COMMANDS.is_empty());
        let unique: std::collections::HashSet<_> = COMMANDS.iter().copied().collect();
        assert_eq!(unique.len(), COMMANDS.len());
    }

    #[test]
    fn memory_sync_requires_retrieval_content_protocol_v1() {
        let (status, Json(error)) = validate_content_protocol("memories", None).unwrap_err();
        assert_eq!(status, StatusCode::UPGRADE_REQUIRED);
        assert_eq!(error.code, "upgrade_required");
        assert!(error.message.contains("protocol v1"));
        assert!(validate_content_protocol("memories", Some(1)).is_ok());
        assert!(validate_content_protocol("sessions", None).is_ok());
    }
}
