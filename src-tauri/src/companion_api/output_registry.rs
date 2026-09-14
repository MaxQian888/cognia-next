//! What every dispatchable arm answers with (ADR-0175 B4).
//!
//! `protocol/companion-response-schemas.json` is the published output contract
//! and, on the headless and mobile planes, an enforced one: a response that
//! does not match its schema is refused with `contract_output_violation`
//! instead of delivered. Every one of its 674 entries was typed by hand, and
//! nothing held one against the Rust arm that fills it. That is how
//! `integration_ingress_poll` shipped a schema saying "object" for an arm
//! answering a list, which turned every `cognia-agent serve` boot into a 500
//! on Marketplace ingress.
//!
//! This is the registry ADR-0175 asks for: one row per dispatchable arm,
//! naming where its output schema comes from.
//!
//! | Shape | Means | Count |
//! | --- | --- | --- |
//! | [`OutputShape::Derived`] | The schema comes from the Rust type through `schemars`. The arm cannot disagree with it. | 5 |
//! | [`OutputShape::Scalar`] | The whole answer is a JSON scalar. The root type is the entire contract. | 213 |
//! | [`OutputShape::Declared`] | Still typed by hand. The row declares the root type, which is checked against the published file. | 253 |
//! | [`OutputShape::Opaque`] | Deliberately shapeless, with the reason and the owning domain carried by the shared `$def`. | 203 |
//!
//! `Derived` is the goal state and the other three are the ledger of what is
//! left. `Declared` and `Opaque` may only fall.
//!
//! ## Why the root type is repeated here
//!
//! A `Declared` row does not restate the schema, only its root type, and that
//! is on purpose. The root type is the part a client cannot recover from: a
//! caller that receives an object where it was promised an array does not read
//! a missing field, it fails to parse. Declaring it beside the arm and holding
//! it against the published file is what makes a hand-edit to either side fail
//! `cargo test` rather than a customer's boot.
//!
//! ## Why this is a `#[cfg(test)]` module
//!
//! It is a gate, like [`super::spec_parity`]: it reads the committed contract
//! through `include_str!` so the check is hermetic, and it has no runtime
//! caller yet. The emitter that ADR-0175 B4 also asks for
//! (`companion-contract-emit`, writing the response-schema file from these
//! rows instead of reading it) is what turns this into production code. The
//! `JsonSchema` derives the `Derived` rows depend on are real production
//! attributes on the wire types themselves.

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use serde_json::Value;

    use crate::companion_api::command_manifest::{known_commands::WIRE_COMMANDS, CommandTarget};

    /// The published output contract, embedded so the check is hermetic.
    const PUBLISHED: &str = include_str!("../../../protocol/companion-response-schemas.json");

    /// The JSON root a client parses before it looks at anything else.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum RootType {
        Null,
        Bool,
        Integer,
        Text,
        /// A string or `null`.
        NullableText,
        Array,
        Object,
        /// An object or `null`. The six task-workspace getters answer this, and
        /// a client is written around it.
        NullableObject,
        /// Any JSON value at all.
        Any,
        /// Two or more unrelated roots, spelled `oneOf` in the contract.
        Union,
    }

    /// A whole answer that is one JSON scalar.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ScalarShape {
        Null,
        Bool,
        Integer,
        Text,
        NullableText,
        /// An array of bare strings.
        TextList,
    }

    impl ScalarShape {
        fn root(self) -> RootType {
            match self {
                ScalarShape::Null => RootType::Null,
                ScalarShape::Bool => RootType::Bool,
                ScalarShape::Integer => RootType::Integer,
                ScalarShape::Text => RootType::Text,
                ScalarShape::NullableText => RootType::NullableText,
                ScalarShape::TextList => RootType::Array,
            }
        }
    }

    /// An output schema that comes from the Rust type the arm returns.
    struct DerivedOutput {
        /// The type, spelled as a reader would find it.
        rust_type: &'static str,
        schema: fn() -> schemars::Schema,
    }

    enum OutputShape {
        Scalar(ScalarShape),
        Derived(DerivedOutput),
        Declared(RootType),
        Opaque(RootType),
    }

    impl OutputShape {
        /// The root type this row states, or `None` for a `Derived` row, whose
        /// root comes from the type and is checked against the contract whole.
        fn declared_root(&self) -> Option<RootType> {
            match self {
                OutputShape::Scalar(scalar) => Some(scalar.root()),
                OutputShape::Derived(_) => None,
                OutputShape::Declared(root) | OutputShape::Opaque(root) => Some(*root),
            }
        }
    }

    fn schema_of<T: schemars::JsonSchema>() -> schemars::Schema {
        schemars::schema_for!(T)
    }

    /// One row per dispatchable arm, grouped by the sub-dispatcher that serves
    /// it and in that dispatcher's own order.
    #[rustfmt::skip]
    static OUTPUT_SHAPES: &[(&str, OutputShape)] = &[
        // ── chat (rpc/chat.rs) ───────────────────────────────────────────────
        ("agent_send", OutputShape::Scalar(ScalarShape::Null)),
        ("agent_interrupt", OutputShape::Scalar(ScalarShape::Null)),
        ("agent_compact", OutputShape::Scalar(ScalarShape::Null)),
        ("agent_close_session", OutputShape::Scalar(ScalarShape::Null)),
        ("agent_resolve_permission", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_send", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_interrupt", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_compact", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_restore", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_set_mode", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_approve", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_close_session", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_session_control", OutputShape::Scalar(ScalarShape::Null)),
        ("agent_session_api", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_plugin_tool_response", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_tool_result_decision", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_protocol_adapter_message", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_sidecar_status", OutputShape::Declared(RootType::Object)),
        ("claude_set_oauth_bearer", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_set_api_key", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_set_provider_env", OutputShape::Scalar(ScalarShape::Null)),
        ("claude_has_api_key", OutputShape::Scalar(ScalarShape::Bool)),
        ("claude_has_oauth_bearer", OutputShape::Scalar(ScalarShape::Bool)),
        ("claude_restart_sidecar", OutputShape::Scalar(ScalarShape::Null)),
        ("read_agent_config", OutputShape::Declared(RootType::Object)),
        ("agent_vendor_roots", OutputShape::Declared(RootType::Object)),
        ("read_project_mcp_config", OutputShape::Declared(RootType::Object)),
        ("write_agent_config", OutputShape::Declared(RootType::Object)),
        ("secret_store_get", OutputShape::Declared(RootType::NullableText)),
        ("keyring_secret_get", OutputShape::Declared(RootType::NullableText)),
        ("secret_store_set", OutputShape::Scalar(ScalarShape::Null)),
        ("keyring_secret_set", OutputShape::Scalar(ScalarShape::Null)),
        ("secret_store_delete", OutputShape::Scalar(ScalarShape::Null)),
        ("keyring_secret_clear", OutputShape::Scalar(ScalarShape::Null)),

        // ── codex_app (rpc/codex_app.rs) ─────────────────────────────────────
        ("codex_app_runtime_status", OutputShape::Declared(RootType::Object)),
        ("codex_app_task_list", OutputShape::Declared(RootType::Object)),
        ("codex_app_task_read", OutputShape::Declared(RootType::Object)),
        ("codex_app_task_create", OutputShape::Declared(RootType::Object)),
        ("codex_app_task_send", OutputShape::Declared(RootType::Object)),
        ("codex_app_task_interrupt", OutputShape::Declared(RootType::Object)),
        ("codex_app_task_open", OutputShape::Declared(RootType::Object)),
        ("codex_app_inventory", OutputShape::Declared(RootType::Object)),

        // ── media (rpc/media.rs) ─────────────────────────────────────────────
        ("video_get_info", OutputShape::Declared(RootType::Object)),
        ("plugin_media_get_video_frame", OutputShape::Declared(RootType::Object)),
        ("plugin_media_read_analysis_frame", OutputShape::Declared(RootType::Object)),
        ("plugin_media_concatenate_videos", OutputShape::Declared(RootType::Object)),
        ("plugin_media_apply_video_effect", OutputShape::Declared(RootType::Null)),
        ("plugin_media_add_transition", OutputShape::Declared(RootType::Null)),
        ("plugin_media_export_video", OutputShape::Declared(RootType::Object)),
        ("video_analyze", OutputShape::Declared(RootType::Object)),
        ("video_trim", OutputShape::Declared(RootType::Object)),
        ("video_cleanup_analysis", OutputShape::Declared(RootType::Null)),
        ("plugin_media_read_chunk", OutputShape::Declared(RootType::Array)),
        ("plugin_media_close_transfer", OutputShape::Declared(RootType::Null)),

        // ── native_tools (rpc/native_tools.rs) ───────────────────────────────
        ("ocr_list_native_backends", OutputShape::Scalar(ScalarShape::TextList)),
        ("ocr_list_available_backends", OutputShape::Scalar(ScalarShape::TextList)),
        ("ocr_extract_native", OutputShape::Opaque(RootType::Any)),
        ("ocr_model_status", OutputShape::Declared(RootType::Object)),
        ("ocr_download_model", OutputShape::Opaque(RootType::Any)),
        ("ocr_cancel_model_download", OutputShape::Scalar(ScalarShape::Bool)),
        ("external_agent_detect_runtimes", OutputShape::Declared(RootType::Object)),
        ("resolve_pi_extension", OutputShape::Declared(RootType::Object)),
        ("skills_scan_native", OutputShape::Opaque(RootType::Array)),
        ("skills_load_registry", OutputShape::Opaque(RootType::Array)),
        ("skills_install_native", OutputShape::Opaque(RootType::Any)),
        ("skills_uninstall_native", OutputShape::Declared(RootType::Object)),
        ("skills_catalog_get", OutputShape::Opaque(RootType::Object)),
        ("skills_bundle_upload_open", OutputShape::Opaque(RootType::Object)),
        ("skills_bundle_upload_write", OutputShape::Scalar(ScalarShape::Integer)),
        ("skills_bundle_upload_commit", OutputShape::Scalar(ScalarShape::Null)),
        ("skills_bundle_upload_abort", OutputShape::Scalar(ScalarShape::Null)),
        ("skills_install_atomic", OutputShape::Opaque(RootType::Any)),
        ("skills_uninstall", OutputShape::Declared(RootType::Object)),
        ("external_bridge_config_get", OutputShape::Declared(RootType::Object)),
        ("external_bridge_config_update", OutputShape::Declared(RootType::Object)),
        ("external_bridge_client_create", OutputShape::Declared(RootType::Object)),
        ("external_bridge_client_list", OutputShape::Declared(RootType::Array)),
        ("external_bridge_client_rotate", OutputShape::Declared(RootType::Object)),
        ("external_bridge_client_revoke", OutputShape::Opaque(RootType::Any)),
        ("external_bridge_start", OutputShape::Scalar(ScalarShape::Integer)),
        ("external_bridge_restart", OutputShape::Scalar(ScalarShape::Integer)),
        ("external_bridge_stop", OutputShape::Scalar(ScalarShape::Null)),
        ("external_bridge_status", OutputShape::Declared(RootType::Object)),
        ("external_bridge_relay_enable", OutputShape::Opaque(RootType::Any)),
        ("external_bridge_relay_disable", OutputShape::Opaque(RootType::Any)),
        ("host_admin_lease_issue", OutputShape::Declared(RootType::Object)),
        ("host_admin_lease_revoke", OutputShape::Scalar(ScalarShape::Null)),
        ("host_consent_pending", OutputShape::Declared(RootType::Array)),
        ("host_consent_respond", OutputShape::Declared(RootType::Object)),
        ("mcp_server_start", OutputShape::Scalar(ScalarShape::Integer)),
        ("mcp_server_restart", OutputShape::Scalar(ScalarShape::Integer)),
        ("mcp_server_stop", OutputShape::Scalar(ScalarShape::Null)),
        ("mcp_server_status", OutputShape::Declared(RootType::Object)),
        ("mcp_oauth_status", OutputShape::Declared(RootType::Object)),
        ("mcp_oauth_load_entry", OutputShape::Declared(RootType::NullableObject)),
        ("mcp_oauth_authenticate", OutputShape::Declared(RootType::Object)),
        ("mcp_oauth_refresh", OutputShape::Declared(RootType::NullableObject)),
        ("mcp_oauth_clear", OutputShape::Scalar(ScalarShape::Null)),

        // ── data_sync (rpc/data_sync.rs) ─────────────────────────────────────
        ("register_push_token", OutputShape::Scalar(ScalarShape::Null)),
        ("revoke_push_token", OutputShape::Scalar(ScalarShape::Null)),
        ("remote_notification_publish", OutputShape::Opaque(RootType::Any)),
        ("sync_list_tables", OutputShape::Declared(RootType::Object)),
        ("sync_pull", OutputShape::Declared(RootType::Object)),
        ("message_update", OutputShape::Opaque(RootType::Object)),
        ("message_delete", OutputShape::Opaque(RootType::Any)),
        ("session_list", OutputShape::Declared(RootType::Object)),
        ("message_get_by_session", OutputShape::Declared(RootType::Object)),
        ("transcript_capabilities", OutputShape::Declared(RootType::Object)),
        ("session_timeline", OutputShape::Declared(RootType::Object)),
        ("session_turn_messages", OutputShape::Declared(RootType::Object)),
        ("message_send", OutputShape::Opaque(RootType::Object)),
        ("background_job_list", OutputShape::Declared(RootType::Object)),
        ("background_job_read", OutputShape::Opaque(RootType::Object)),
        ("background_job_kill", OutputShape::Declared(RootType::Object)),
        ("background_job_spawn_scheduled", OutputShape::Declared(RootType::Object)),
        ("background_monitor_list", OutputShape::Declared(RootType::Object)),
        ("background_monitor_cancel", OutputShape::Declared(RootType::Object)),
        ("background_monitor_register_scheduled", OutputShape::Declared(RootType::Object)),
        ("workflow_approval_list", OutputShape::Declared(RootType::Object)),
        ("workflow_approval_respond", OutputShape::Opaque(RootType::Any)),
        ("workflow_human_input_list", OutputShape::Declared(RootType::Object)),
        ("workflow_human_input_submit", OutputShape::Declared(RootType::Object)),
        ("character_upsert", OutputShape::Opaque(RootType::Any)),
        ("character_delete", OutputShape::Opaque(RootType::Any)),
        ("character_bind_twin", OutputShape::Opaque(RootType::Any)),
        ("skill_set_enabled", OutputShape::Opaque(RootType::Any)),
        ("plugin_set_enabled", OutputShape::Opaque(RootType::Any)),
        ("issue_apply_action", OutputShape::Declared(RootType::Object)),
        ("issue_create", OutputShape::Declared(RootType::Object)),
        ("mcp_set_enabled", OutputShape::Scalar(ScalarShape::Null)),
        ("mcp_set_tool_rules", OutputShape::Scalar(ScalarShape::Null)),
        ("adapter_update_policy", OutputShape::Opaque(RootType::Any)),
        ("twin_profile_get", OutputShape::Opaque(RootType::Object)),
        ("host_capabilities", OutputShape::Declared(RootType::Object)),
        ("host_feature_manifest", OutputShape::Declared(RootType::Object)),
        ("host_state_snapshot", OutputShape::Declared(RootType::Object)),
        ("host_state_submit", OutputShape::Declared(RootType::Object)),
        ("host_state_status", OutputShape::Declared(RootType::Object)),
        ("provider_diagnostics_status", OutputShape::Opaque(RootType::Object)),
        ("provider_diagnostics_history", OutputShape::Declared(RootType::Object)),
        ("provider_diagnostics_start", OutputShape::Opaque(RootType::Object)),
        ("provider_diagnostics_cancel", OutputShape::Opaque(RootType::Any)),
        ("session_reference_search", OutputShape::Declared(RootType::Object)),
        ("session_reference_snapshot", OutputShape::Declared(RootType::Object)),
        ("connector_send", OutputShape::Opaque(RootType::Object)),
        ("connector_enqueue_outbound", OutputShape::Declared(RootType::Object)),
        ("connector_approve_draft", OutputShape::Opaque(RootType::Any)),
        ("connector_reject_draft", OutputShape::Opaque(RootType::Any)),
        ("workflow_trigger_manual", OutputShape::Opaque(RootType::Any)),
        ("workflow_placement_probe", OutputShape::Declared(RootType::Object)),
        ("workflow_handoff_create", OutputShape::Declared(RootType::Object)),
        ("twin_ingest_source", OutputShape::Opaque(RootType::Any)),
        ("bot_installation_mutate", OutputShape::Opaque(RootType::Object)),
        ("integration_github_account_connect_from_secret", OutputShape::Opaque(RootType::Object)),
        ("bot_console_read", OutputShape::Opaque(RootType::Object)),
        ("bot_trigger_set_armed", OutputShape::Declared(RootType::Object)),
        ("bot_run_manual", OutputShape::Declared(RootType::Object)),
        ("bot_delivery_replay", OutputShape::Declared(RootType::Object)),
        ("device_capabilities_report", OutputShape::Opaque(RootType::Any)),
        ("session_attach", OutputShape::Opaque(RootType::Any)),
        ("session_detach", OutputShape::Opaque(RootType::Any)),
        ("session_attachment_upload_init", OutputShape::Declared(RootType::Object)),
        ("session_attachment_upload_chunk", OutputShape::Declared(RootType::Object)),
        ("session_attachment_upload_commit", OutputShape::Declared(RootType::Object)),
        ("session_attachment_upload_abort", OutputShape::Scalar(ScalarShape::Null)),
        ("goal_pause", OutputShape::Opaque(RootType::Any)),
        ("goal_resume", OutputShape::Opaque(RootType::Any)),
        ("goal_stop", OutputShape::Opaque(RootType::Any)),
        ("team_task_move", OutputShape::Opaque(RootType::Any)),
        ("team_task_create", OutputShape::Opaque(RootType::Object)),
        ("team_task_comment", OutputShape::Opaque(RootType::Any)),
        ("team_run_pause", OutputShape::Opaque(RootType::Any)),
        ("team_run_resume", OutputShape::Opaque(RootType::Any)),
        ("team_run_stop", OutputShape::Opaque(RootType::Any)),
        ("execution_run_control", OutputShape::Opaque(RootType::Any)),
        ("execution_run_detail", OutputShape::Opaque(RootType::Object)),
        ("agent_task_start", OutputShape::Opaque(RootType::Object)),
        ("agent_task_pause", OutputShape::Opaque(RootType::Any)),
        ("agent_task_resume", OutputShape::Opaque(RootType::Any)),
        ("agent_task_cancel", OutputShape::Opaque(RootType::Any)),
        ("agent_task_comment", OutputShape::Opaque(RootType::Any)),
        ("agent_task_move", OutputShape::Opaque(RootType::Any)),
        ("workflow_create", OutputShape::Opaque(RootType::Object)),
        ("workflow_update", OutputShape::Opaque(RootType::Object)),
        ("workflow_delete", OutputShape::Opaque(RootType::Any)),
        ("workflow_run_list", OutputShape::Declared(RootType::Object)),
        ("workflow_cancel_run", OutputShape::Opaque(RootType::Any)),
        ("workflow_schedule_pause", OutputShape::Opaque(RootType::Any)),
        ("workflow_schedule_resume", OutputShape::Opaque(RootType::Any)),
        ("scheduled_task_list", OutputShape::Declared(RootType::Array)),
        ("scheduled_task_get", OutputShape::Declared(RootType::NullableObject)),
        ("scheduled_task_runs", OutputShape::Declared(RootType::Array)),
        ("scheduled_task_statistics", OutputShape::Declared(RootType::Object)),
        ("scheduled_task_upcoming", OutputShape::Declared(RootType::Array)),
        ("scheduled_task_export", OutputShape::Declared(RootType::Object)),
        ("scheduled_task_create", OutputShape::Declared(RootType::Object)),
        ("scheduled_task_update", OutputShape::Declared(RootType::NullableObject)),
        ("scheduled_task_delete", OutputShape::Scalar(ScalarShape::Bool)),
        ("scheduled_task_pause", OutputShape::Scalar(ScalarShape::Bool)),
        ("scheduled_task_resume", OutputShape::Scalar(ScalarShape::Bool)),
        ("scheduled_task_run_now", OutputShape::Declared(RootType::NullableObject)),
        ("scheduled_task_cancel_run", OutputShape::Declared(RootType::Object)),
        ("scheduled_task_backfill", OutputShape::Declared(RootType::Array)),
        ("scheduled_task_import", OutputShape::Declared(RootType::Object)),
        ("scheduled_task_cleanup", OutputShape::Scalar(ScalarShape::Integer)),
        ("scheduled_task_emit_event", OutputShape::Scalar(ScalarShape::Null)),
        ("workflow_step_result", OutputShape::Opaque(RootType::Any)),
        ("twin_delete", OutputShape::Opaque(RootType::Any)),
        ("twin_source_list", OutputShape::Declared(RootType::Object)),
        ("twin_source_update", OutputShape::Opaque(RootType::Object)),
        ("twin_source_delete", OutputShape::Opaque(RootType::Any)),
        ("twin_job_status", OutputShape::Opaque(RootType::Object)),
        ("twin_job_cancel", OutputShape::Opaque(RootType::Any)),
        ("twin_job_pause", OutputShape::Opaque(RootType::Any)),
        ("twin_job_resume", OutputShape::Opaque(RootType::Any)),
        ("twin_job_retry", OutputShape::Opaque(RootType::Any)),
        ("twin_create", OutputShape::Opaque(RootType::Object)),
        ("twin_source_create", OutputShape::Opaque(RootType::Object)),
        ("twin_draft_review", OutputShape::Declared(RootType::Object)),
        ("twin_profile_update", OutputShape::Opaque(RootType::Object)),
        ("goal_create", OutputShape::Opaque(RootType::Object)),
        ("goal_update", OutputShape::Opaque(RootType::Object)),
        ("goal_status", OutputShape::Opaque(RootType::Object)),
        ("memory_search", OutputShape::Declared(RootType::Object)),
        ("memory_list", OutputShape::Declared(RootType::Object)),
        ("memory_store", OutputShape::Opaque(RootType::Any)),
        ("memory_update", OutputShape::Opaque(RootType::Object)),
        ("memory_forget", OutputShape::Opaque(RootType::Any)),
        ("retrieval_profile_dek_export", OutputShape::Declared(RootType::Object)),
        ("conversation_overrides_update", OutputShape::Opaque(RootType::Object)),
        ("backup_export", OutputShape::Opaque(RootType::Object)),
        ("backup_import", OutputShape::Opaque(RootType::Any)),
        ("external_agent_list", OutputShape::Declared(RootType::Object)),
        ("external_agent_update", OutputShape::Opaque(RootType::Object)),
        ("external_agent_admit_run", OutputShape::Declared(RootType::Object)),
        ("external_agent_cancel_run", OutputShape::Declared(RootType::Object)),
        ("external_agent_config_create", OutputShape::Declared(RootType::Object)),
        ("external_agent_config_delete", OutputShape::Declared(RootType::Object)),
        ("external_agent_config_get", OutputShape::Declared(RootType::Object)),
        ("external_agent_config_list", OutputShape::Declared(RootType::Object)),
        ("external_agent_config_reconcile", OutputShape::Declared(RootType::Object)),
        ("external_agent_config_update", OutputShape::Declared(RootType::Object)),
        ("external_agent_release_run", OutputShape::Declared(RootType::Object)),
        ("external_agent_resolve_decision", OutputShape::Declared(RootType::Object)),
        ("external_agent_run_turn", OutputShape::Declared(RootType::Object)),
        ("browser_companion_capability", OutputShape::Declared(RootType::Object)),
        ("browser_context_submit", OutputShape::Declared(RootType::Object)),
        ("browser_context_list", OutputShape::Declared(RootType::Object)),
        ("browser_context_get", OutputShape::Declared(RootType::Object)),
        ("browser_context_result", OutputShape::Declared(RootType::Object)),
        ("browser_context_cancel", OutputShape::Declared(RootType::Object)),
        ("perf_close_lease", OutputShape::Scalar(ScalarShape::Null)),
        ("perf_hotspots", OutputShape::Opaque(RootType::Array)),
        ("perf_lease_snapshot", OutputShape::Declared(RootType::Object)),
        ("perf_list_traces", OutputShape::Opaque(RootType::Array)),
        ("perf_open_lease", OutputShape::Declared(RootType::Object)),
        ("perf_read_observations", OutputShape::Declared(RootType::Array)),
        ("perf_renew_lease", OutputShape::Scalar(ScalarShape::Null)),
        ("perf_trace_close", OutputShape::Scalar(ScalarShape::Null)),
        ("perf_trace_open", OutputShape::Declared(RootType::Object)),
        ("perf_trace_read_chunk", OutputShape::Declared(RootType::Object)),
        ("perf_system_details", OutputShape::Declared(RootType::Object)),
        ("thread_handoff_offer", OutputShape::Declared(RootType::Object)),
        ("thread_handoff_preflight", OutputShape::Declared(RootType::Object)),
        ("thread_handoff_accept", OutputShape::Declared(RootType::Object)),
        ("thread_handoff_commit", OutputShape::Declared(RootType::Object)),
        ("thread_handoff_abort", OutputShape::Declared(RootType::Object)),
        ("thread_handoff_status", OutputShape::Declared(RootType::NullableObject)),

        // ── service_plane (rpc/service_plane.rs) ─────────────────────────────
        ("spawn_external_agent", OutputShape::Scalar(ScalarShape::Text)),
        ("send_to_external_agent", OutputShape::Scalar(ScalarShape::Null)),
        ("kill_external_agent", OutputShape::Scalar(ScalarShape::Null)),
        ("external_agent_delete_gateway_task", OutputShape::Scalar(ScalarShape::Null)),
        ("get_external_agent_status", OutputShape::Scalar(ScalarShape::Text)),
        ("connectors_register", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_unregister", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_list_adapters", OutputShape::Declared(RootType::Object)),
        ("connectors_runtime_lease_acquire", OutputShape::Declared(RootType::Union)),
        ("connectors_runtime_lease_renew", OutputShape::Scalar(ScalarShape::Bool)),
        ("connectors_runtime_lease_release", OutputShape::Scalar(ScalarShape::Bool)),
        ("integration_ingress_register", OutputShape::Scalar(ScalarShape::NullableText)),
        ("integration_ingress_unregister", OutputShape::Scalar(ScalarShape::Null)),
        ("integration_ingress_get_url", OutputShape::Scalar(ScalarShape::NullableText)),
        ("integration_ingress_poll", OutputShape::Declared(RootType::Array)),
        ("integration_ingress_deadletters", OutputShape::Declared(RootType::Object)),
        ("integration_ingress_deadletter", OutputShape::Opaque(RootType::Any)),
        ("integration_ingress_requeue", OutputShape::Scalar(ScalarShape::Bool)),
        ("workflow_register_trigger", OutputShape::Scalar(ScalarShape::Null)),
        ("workflow_unregister_trigger", OutputShape::Scalar(ScalarShape::Null)),
        ("workflow_file_watch_ack", OutputShape::Scalar(ScalarShape::Null)),
        ("workflow_get_webhook_url", OutputShape::Scalar(ScalarShape::NullableText)),
        ("workflow_webhook_respond", OutputShape::Scalar(ScalarShape::Bool)),
        ("workflow_persist_run_state", OutputShape::Scalar(ScalarShape::Null)),
        ("workflow_reload_in_flight_runs", OutputShape::Declared(RootType::Array)),
        ("workflow_ack_completed", OutputShape::Scalar(ScalarShape::Null)),
        ("workflow_waitpoint_create", OutputShape::Declared(RootType::Object)),
        ("workflow_waitpoint_get", OutputShape::Declared(RootType::NullableObject)),
        ("workflow_waitpoint_list_pending", OutputShape::Declared(RootType::Array)),
        ("workflow_waitpoint_decide", OutputShape::Scalar(ScalarShape::Bool)),
        ("workflow_wait_event_persist", OutputShape::Scalar(ScalarShape::Null)),
        ("workflow_wait_event_prune", OutputShape::Scalar(ScalarShape::Integer)),
        ("github_workspace_clone", OutputShape::Opaque(RootType::Object)),
        ("github_workspace_commit_and_push", OutputShape::Scalar(ScalarShape::Text)),
        ("task_workspace_remote_source_ensure", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::RemoteSourceCheckout", schema: schema_of::<cognia_task_workspace::RemoteSourceCheckout> })),
        ("github_workspace_remove", OutputShape::Scalar(ScalarShape::Bool)),
        ("github_workspace_stat", OutputShape::Opaque(RootType::Any)),
        ("integration_ingress_ack", OutputShape::Scalar(ScalarShape::Null)),
        ("integration_ingress_nack", OutputShape::Scalar(ScalarShape::Null)),
        ("provider_profiles_list", OutputShape::Declared(RootType::Object)),
        ("provider_profiles_import", OutputShape::Declared(RootType::Object)),
        ("provider_profiles_version", OutputShape::Declared(RootType::Object)),
        ("provider_catalog_status", OutputShape::Opaque(RootType::Object)),
        ("provider_catalog_search", OutputShape::Declared(RootType::Object)),
        ("provider_catalog_refresh", OutputShape::Opaque(RootType::Any)),
        ("connectors_health", OutputShape::Opaque(RootType::Any)),
        ("connectors_keyring_set", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_keyring_get", OutputShape::Scalar(ScalarShape::NullableText)),
        ("connectors_keyring_delete", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_keyring_list", OutputShape::Scalar(ScalarShape::TextList)),
        ("connectors_http_request", OutputShape::Opaque(RootType::Any)),
        ("connectors_ws_open", OutputShape::Scalar(ScalarShape::Text)),
        ("connectors_ws_send", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_ws_close", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_onebot_send", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_onebot_probe", OutputShape::Declared(RootType::Array)),
        ("connectors_discord_upload", OutputShape::Scalar(ScalarShape::Text)),
        ("connectors_lark_ws_open", OutputShape::Scalar(ScalarShape::Text)),
        ("connectors_lark_ws_close", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_reset_all_ws", OutputShape::Scalar(ScalarShape::Integer)),
        ("connectors_attachment_fetch", OutputShape::Declared(RootType::Object)),
        ("connectors_attachment_read", OutputShape::Scalar(ScalarShape::NullableText)),
        ("connectors_attachment_list", OutputShape::Declared(RootType::Array)),
        ("connectors_attachment_delete", OutputShape::Declared(RootType::Object)),
        ("connectors_attachment_evict_adapter", OutputShape::Declared(RootType::Object)),
        ("connectors_attachment_enforce_budget", OutputShape::Declared(RootType::Object)),
        ("connectors_media_upload", OutputShape::Scalar(ScalarShape::Text)),
        ("connectors_matrix_crypto_init", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_matrix_crypto_close", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_matrix_crypto_outgoing_requests", OutputShape::Declared(RootType::Array)),
        ("connectors_matrix_crypto_mark_request_sent", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_matrix_crypto_receive_sync_changes", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_matrix_crypto_decrypt_event", OutputShape::Opaque(RootType::Object)),
        ("connectors_matrix_crypto_encrypt_event", OutputShape::Opaque(RootType::Object)),
        ("connectors_matrix_crypto_share_room_key", OutputShape::Declared(RootType::Array)),
        ("connectors_matrix_crypto_update_tracked_users", OutputShape::Scalar(ScalarShape::Null)),
        ("connectors_matrix_crypto_get_missing_sessions", OutputShape::Declared(RootType::Array)),
        ("connectors_matrix_encrypted_media_upload", OutputShape::Opaque(RootType::Object)),
        ("connectors_matrix_encrypted_media_fetch", OutputShape::Declared(RootType::Object)),
        ("connectors_lark_upload_file", OutputShape::Scalar(ScalarShape::Text)),
        ("connectors_lark_upload_image", OutputShape::Scalar(ScalarShape::Text)),
        ("automation_consent_respond", OutputShape::Scalar(ScalarShape::Null)),
        ("automation_consent_pending", OutputShape::Opaque(RootType::Any)),
        ("automation_kill_switch_engaged", OutputShape::Scalar(ScalarShape::Bool)),
        ("automation_settings_get", OutputShape::Declared(RootType::Object)),
        ("automation_audit_snapshot", OutputShape::Declared(RootType::Array)),
        ("automation_kill_switch", OutputShape::Scalar(ScalarShape::Null)),
        ("companion_can_control", OutputShape::Opaque(RootType::Any)),
        ("companion_endpoints", OutputShape::Declared(RootType::Object)),
        ("langfuse_credentials_set", OutputShape::Scalar(ScalarShape::Null)),
        ("langfuse_credentials_status", OutputShape::Declared(RootType::Object)),
        ("langfuse_credentials_clear", OutputShape::Scalar(ScalarShape::Null)),
        ("langfuse_connection_test", OutputShape::Declared(RootType::Object)),
        ("langfuse_trace_ingest", OutputShape::Declared(RootType::Object)),
        ("app_settings_update", OutputShape::Opaque(RootType::Object)),

        // ── gateway_plane (rpc/gateway_plane.rs) ─────────────────────────────
        ("gateway_status", OutputShape::Opaque(RootType::Object)),
        ("gateway_list_models", OutputShape::Declared(RootType::Object)),
        ("gateway_provider_capabilities", OutputShape::Declared(RootType::Object)),
        ("gateway_mint_route_ticket", OutputShape::Declared(RootType::Object)),
        ("gateway_list_route_tickets", OutputShape::Declared(RootType::Object)),
        ("gateway_revoke_route_ticket", OutputShape::Declared(RootType::Object)),
        ("gateway_probe_upstream", OutputShape::Declared(RootType::Array)),

        // ── host_admin (rpc/host_admin.rs) ───────────────────────────────────
        ("companion_signaling_status", OutputShape::Declared(RootType::Object)),
        ("companion_signaling_configure", OutputShape::Scalar(ScalarShape::Null)),
        ("companion_signaling_devices_status", OutputShape::Declared(RootType::Array)),
        ("companion_signaling_reconnect_device", OutputShape::Scalar(ScalarShape::Null)),
        ("companion_browser_access_get", OutputShape::Declared(RootType::Object)),
        ("companion_browser_access_set", OutputShape::Declared(RootType::Object)),
        ("companion_push_status", OutputShape::Declared(RootType::Object)),
        ("companion_push_configure_fcm", OutputShape::Scalar(ScalarShape::Null)),
        ("companion_push_configure_apns", OutputShape::Scalar(ScalarShape::Null)),
        ("companion_push_clear_fcm", OutputShape::Scalar(ScalarShape::Null)),
        ("companion_push_clear_apns", OutputShape::Scalar(ScalarShape::Null)),
        ("companion_push_notification", OutputShape::Declared(RootType::Object)),
        ("companion_create_owner_invitation", OutputShape::Declared(RootType::Object)),
        ("companion_server_status", OutputShape::Declared(RootType::Object)),

        // ── source_control (rpc/source_control.rs) ───────────────────────────
        ("git_is_repo", OutputShape::Scalar(ScalarShape::Bool)),
        ("git_repo_state", OutputShape::Declared(RootType::Object)),
        ("git_status", OutputShape::Declared(RootType::Object)),
        ("git_diff_stat", OutputShape::Declared(RootType::Array)),
        ("git_diff_file", OutputShape::Declared(RootType::Object)),
        ("git_diff_commit", OutputShape::Declared(RootType::Object)),
        ("git_commit_files", OutputShape::Declared(RootType::Array)),
        ("git_log", OutputShape::Declared(RootType::Array)),
        ("git_file_history", OutputShape::Declared(RootType::Array)),
        ("git_branches", OutputShape::Declared(RootType::Array)),
        ("git_remotes", OutputShape::Declared(RootType::Array)),
        ("git_stash_list", OutputShape::Declared(RootType::Array)),
        ("git_conflicts", OutputShape::Declared(RootType::Array)),
        ("git_stage", OutputShape::Scalar(ScalarShape::Null)),
        ("git_unstage", OutputShape::Scalar(ScalarShape::Null)),
        ("git_discard", OutputShape::Scalar(ScalarShape::Null)),
        ("git_discard_all", OutputShape::Scalar(ScalarShape::Null)),
        ("git_commit", OutputShape::Scalar(ScalarShape::Text)),
        ("git_checkout_branch", OutputShape::Scalar(ScalarShape::Null)),
        ("git_create_branch", OutputShape::Scalar(ScalarShape::Null)),
        ("git_delete_branch", OutputShape::Scalar(ScalarShape::Null)),
        ("git_rename_branch", OutputShape::Scalar(ScalarShape::Null)),
        ("git_fetch", OutputShape::Scalar(ScalarShape::Null)),
        ("git_pull", OutputShape::Scalar(ScalarShape::Null)),
        ("git_push", OutputShape::Scalar(ScalarShape::Null)),
        ("git_sync", OutputShape::Declared(RootType::Object)),
        ("git_stash_push", OutputShape::Scalar(ScalarShape::Null)),
        ("git_stash_pop", OutputShape::Scalar(ScalarShape::Null)),
        ("git_stash_apply", OutputShape::Scalar(ScalarShape::Null)),
        ("git_stash_drop", OutputShape::Scalar(ScalarShape::Null)),
        ("git_resolve_conflict", OutputShape::Scalar(ScalarShape::Null)),
        ("git_merge_abort", OutputShape::Scalar(ScalarShape::Null)),
        ("git_diff_refs_files", OutputShape::Declared(RootType::Array)),
        ("git_diff_refs_file", OutputShape::Declared(RootType::Object)),
        ("git_diff_staged_all", OutputShape::Scalar(ScalarShape::Text)),
        ("git_refs", OutputShape::Declared(RootType::Array)),
        ("git_blame", OutputShape::Declared(RootType::Array)),
        ("git_tags", OutputShape::Declared(RootType::Array)),
        ("git_worktree_list", OutputShape::Declared(RootType::Array)),
        ("git_rebase_commits", OutputShape::Declared(RootType::Array)),
        ("git_worktree_add", OutputShape::Scalar(ScalarShape::Null)),
        ("git_worktree_remove", OutputShape::Scalar(ScalarShape::Null)),
        ("git_worktree_commit", OutputShape::Scalar(ScalarShape::NullableText)),
        ("git_worktree_prune", OutputShape::Scalar(ScalarShape::Null)),
        ("git_remote_add", OutputShape::Scalar(ScalarShape::Null)),
        ("git_remote_remove", OutputShape::Scalar(ScalarShape::Null)),
        ("git_create_tag", OutputShape::Scalar(ScalarShape::Null)),
        ("git_delete_tag", OutputShape::Scalar(ScalarShape::Null)),
        ("git_push_tag", OutputShape::Scalar(ScalarShape::Null)),
        ("git_reset", OutputShape::Scalar(ScalarShape::Null)),
        ("git_restore", OutputShape::Scalar(ScalarShape::Null)),
        ("git_rebase", OutputShape::Scalar(ScalarShape::Null)),
        ("git_cherry_pick", OutputShape::Scalar(ScalarShape::Null)),
        ("git_revert", OutputShape::Scalar(ScalarShape::Null)),
        ("git_sequencer_continue", OutputShape::Scalar(ScalarShape::Null)),
        ("git_sequencer_abort", OutputShape::Scalar(ScalarShape::Null)),
        ("git_interactive_rebase", OutputShape::Scalar(ScalarShape::Null)),
        ("git_init", OutputShape::Scalar(ScalarShape::Null)),
        ("git_clone", OutputShape::Declared(RootType::Union)),
        ("git_clone_guarded", OutputShape::Declared(RootType::Union)),
        ("git_identity", OutputShape::Declared(RootType::Object)),
        ("git_set_identity", OutputShape::Scalar(ScalarShape::Null)),
        ("git_ignore_add", OutputShape::Scalar(ScalarShape::Null)),
        ("git_merge", OutputShape::Scalar(ScalarShape::Null)),
        ("git_default_branch", OutputShape::Declared(RootType::Object)),
        ("git_read_blob_at_ref", OutputShape::Declared(RootType::NullableText)),
        ("git_stack_capabilities", OutputShape::Declared(RootType::Object)),
        ("git_stack_parents", OutputShape::Declared(RootType::Array)),
        ("git_stack_set_parent", OutputShape::Scalar(ScalarShape::Null)),
        ("git_stack_validate", OutputShape::Declared(RootType::Array)),
        ("git_stack_restack", OutputShape::Declared(RootType::Object)),
        ("git_stack_history", OutputShape::Declared(RootType::Array)),
        ("git_stack_revert", OutputShape::Scalar(ScalarShape::Text)),
        ("git_stack_push", OutputShape::Declared(RootType::Object)),
        ("git_workspace_list", OutputShape::Opaque(RootType::Array)),

        // ── filesystem (rpc/filesystem.rs) ───────────────────────────────────
        ("read_text_file", OutputShape::Scalar(ScalarShape::Text)),
        ("write_text_file", OutputShape::Scalar(ScalarShape::Null)),
        ("write_text_file_confined", OutputShape::Scalar(ScalarShape::Null)),
        ("ensure_dir", OutputShape::Scalar(ScalarShape::Null)),
        ("ensure_dir_confined", OutputShape::Scalar(ScalarShape::Null)),
        ("default_export_dir", OutputShape::Scalar(ScalarShape::Text)),
        ("fs_search_workspace", OutputShape::Declared(RootType::Array)),
        ("fs_search_content_workspace", OutputShape::Opaque(RootType::Any)),
        ("fs_read_workspace_file", OutputShape::Scalar(ScalarShape::Text)),
        ("fs_write_workspace_file", OutputShape::Scalar(ScalarShape::Null)),
        ("project_environment_execute", OutputShape::Opaque(RootType::Object)),
        ("task_workspace_status", OutputShape::Derived(DerivedOutput { rust_type: "crate::task_workspace::TaskWorkspaceStatus", schema: schema_of::<crate::task_workspace::TaskWorkspaceStatus> })),
        ("task_workspace_begin", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::TaskRun", schema: schema_of::<cognia_task_workspace::TaskRun> })),
        ("task_workspace_bundle_begin", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::TaskRun", schema: schema_of::<cognia_task_workspace::TaskRun> })),
        ("task_workspace_bundle_turn_begin", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceBundleTurnLease", schema: schema_of::<cognia_task_workspace::WorkspaceBundleTurnLease> })),
        ("task_workspace_bundle_turn_settle", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceBundleTurnOutcome", schema: schema_of::<cognia_task_workspace::WorkspaceBundleTurnOutcome> })),
        ("task_workspace_bundle_turn_abort", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceBundleTurnOutcome", schema: schema_of::<cognia_task_workspace::WorkspaceBundleTurnOutcome> })),
        ("task_workspace_bundle_turn_get", OutputShape::Derived(DerivedOutput { rust_type: "Option<cognia_task_workspace::WorkspaceBundleTurnLease>", schema: schema_of::<Option<cognia_task_workspace::WorkspaceBundleTurnLease>> })),
        ("task_workspace_managed_get", OutputShape::Derived(DerivedOutput { rust_type: "Option<cognia_task_workspace::WorkspaceRecord>", schema: schema_of::<Option<cognia_task_workspace::WorkspaceRecord>> })),
        ("task_workspace_managed_list", OutputShape::Derived(DerivedOutput { rust_type: "Vec<cognia_task_workspace::WorkspaceRecord>", schema: schema_of::<Vec<cognia_task_workspace::WorkspaceRecord>> })),
        ("task_workspace_environment_list", OutputShape::Derived(DerivedOutput { rust_type: "Vec<cognia_task_workspace::WorkspaceEnvironmentSummary>", schema: schema_of::<Vec<cognia_task_workspace::WorkspaceEnvironmentSummary>> })),
        ("task_workspace_bundle_get", OutputShape::Derived(DerivedOutput { rust_type: "Option<cognia_task_workspace::WorkspaceBundle>", schema: schema_of::<Option<cognia_task_workspace::WorkspaceBundle>> })),
        ("task_workspace_bundle_list", OutputShape::Derived(DerivedOutput { rust_type: "Vec<cognia_task_workspace::WorkspaceBundle>", schema: schema_of::<Vec<cognia_task_workspace::WorkspaceBundle>> })),
        ("task_workspace_bundle_acquire", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceBundle", schema: schema_of::<cognia_task_workspace::WorkspaceBundle> })),
        ("task_workspace_bundle_apply", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::BundleHandoffOutcome", schema: schema_of::<cognia_task_workspace::BundleHandoffOutcome> })),
        ("task_workspace_bundle_handoff_retry", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::BundleHandoffOutcome", schema: schema_of::<cognia_task_workspace::BundleHandoffOutcome> })),
        ("task_workspace_bundle_handoff_get", OutputShape::Derived(DerivedOutput { rust_type: "Option<cognia_task_workspace::BundleHandoffOutcome>", schema: schema_of::<Option<cognia_task_workspace::BundleHandoffOutcome>> })),
        ("task_workspace_bundle_handoff_undo", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::BundleHandoffUndoOutcome", schema: schema_of::<cognia_task_workspace::BundleHandoffUndoOutcome> })),
        ("task_workspace_bundle_handoff_undo_get", OutputShape::Derived(DerivedOutput { rust_type: "Option<cognia_task_workspace::BundleHandoffUndoOutcome>", schema: schema_of::<Option<cognia_task_workspace::BundleHandoffUndoOutcome>> })),
        ("task_workspace_reconcile", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::ReconcileOutcome", schema: schema_of::<cognia_task_workspace::ReconcileOutcome> })),
        ("task_workspace_policy_get", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceLifecyclePolicy", schema: schema_of::<cognia_task_workspace::WorkspaceLifecyclePolicy> })),
        ("task_workspace_policy_set", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceLifecyclePolicy", schema: schema_of::<cognia_task_workspace::WorkspaceLifecyclePolicy> })),
        ("task_workspace_maintenance_run", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceMaintenanceResult", schema: schema_of::<cognia_task_workspace::WorkspaceMaintenanceResult> })),
        ("task_workspace_maintenance_events", OutputShape::Derived(DerivedOutput { rust_type: "cognia_problem::paging::Page<cognia_task_workspace::WorkspaceMaintenanceEvent>", schema: schema_of::<cognia_problem::paging::Page<cognia_task_workspace::WorkspaceMaintenanceEvent>> })),
        ("task_workspace_managed_pin", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceRecord", schema: schema_of::<cognia_task_workspace::WorkspaceRecord> })),
        ("task_workspace_managed_permanent", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceRecord", schema: schema_of::<cognia_task_workspace::WorkspaceRecord> })),
        ("task_workspace_managed_archive", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceRecord", schema: schema_of::<cognia_task_workspace::WorkspaceRecord> })),
        ("task_workspace_managed_adopt", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceRecord", schema: schema_of::<cognia_task_workspace::WorkspaceRecord> })),
        ("task_workspace_environment_adopt", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceRecord", schema: schema_of::<cognia_task_workspace::WorkspaceRecord> })),
        ("task_workspace_environment_create_branch", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceRecord", schema: schema_of::<cognia_task_workspace::WorkspaceRecord> })),
        ("task_workspace_managed_restore", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::WorkspaceRecord", schema: schema_of::<cognia_task_workspace::WorkspaceRecord> })),
        ("task_workspace_managed_delete", OutputShape::Scalar(ScalarShape::Null)),
        ("task_workspace_settle", OutputShape::Derived(DerivedOutput { rust_type: "Vec<cognia_task_workspace::ResourceChange>", schema: schema_of::<Vec<cognia_task_workspace::ResourceChange>> })),
        ("task_workspace_get", OutputShape::Derived(DerivedOutput { rust_type: "Option<cognia_task_workspace::TaskWorkspace>", schema: schema_of::<Option<cognia_task_workspace::TaskWorkspace>> })),
        ("task_workspace_list", OutputShape::Derived(DerivedOutput { rust_type: "Vec<cognia_task_workspace::TaskWorkspace>", schema: schema_of::<Vec<cognia_task_workspace::TaskWorkspace>> })),
        ("task_workspace_list_runs", OutputShape::Derived(DerivedOutput { rust_type: "Vec<cognia_task_workspace::TaskRun>", schema: schema_of::<Vec<cognia_task_workspace::TaskRun>> })),
        ("task_workspace_list_resources", OutputShape::Derived(DerivedOutput { rust_type: "Vec<cognia_task_workspace::ResourceChange>", schema: schema_of::<Vec<cognia_task_workspace::ResourceChange>> })),
        ("task_workspace_list_resource_events", OutputShape::Derived(DerivedOutput { rust_type: "cognia_problem::paging::Page<cognia_task_workspace::ResourceEvent>", schema: schema_of::<cognia_problem::paging::Page<cognia_task_workspace::ResourceEvent>> })),
        ("task_workspace_get_resource_summary", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::TaskResourceSummary", schema: schema_of::<cognia_task_workspace::TaskResourceSummary> })),
        ("task_workspace_record_tool_event", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::ResourceEvent", schema: schema_of::<cognia_task_workspace::ResourceEvent> })),
        ("task_workspace_export_resource_manifest", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::TaskResourceManifest", schema: schema_of::<cognia_task_workspace::TaskResourceManifest> })),
        ("task_workspace_get_resource", OutputShape::Derived(DerivedOutput { rust_type: "Option<cognia_task_workspace::ResourceChange>", schema: schema_of::<Option<cognia_task_workspace::ResourceChange>> })),
        ("task_workspace_get_patch_set", OutputShape::Derived(DerivedOutput { rust_type: "Option<cognia_task_workspace::PatchSet>", schema: schema_of::<Option<cognia_task_workspace::PatchSet>> })),
        ("task_resource_read_diff", OutputShape::Scalar(ScalarShape::Text)),
        ("task_resource_read_text", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::ResourceRead", schema: schema_of::<cognia_task_workspace::ResourceRead> })),
        ("task_resource_download_open", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::DownloadHandle", schema: schema_of::<cognia_task_workspace::DownloadHandle> })),
        ("task_resource_download_read_chunk", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::TransferChunk", schema: schema_of::<cognia_task_workspace::TransferChunk> })),
        ("task_resource_download_close", OutputShape::Scalar(ScalarShape::Null)),
        ("task_resource_upload_open", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::UploadHandle", schema: schema_of::<cognia_task_workspace::UploadHandle> })),
        ("task_resource_upload_write_chunk", OutputShape::Scalar(ScalarShape::Integer)),
        ("task_resource_upload_commit", OutputShape::Scalar(ScalarShape::Text)),
        ("task_resource_upload_abort", OutputShape::Scalar(ScalarShape::Null)),
        ("task_workspace_apply", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::ApplyOutcome", schema: schema_of::<cognia_task_workspace::ApplyOutcome> })),
        ("task_workspace_undo", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::ApplyOutcome", schema: schema_of::<cognia_task_workspace::ApplyOutcome> })),
        ("task_workspace_restore_snapshot", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::TaskRun", schema: schema_of::<cognia_task_workspace::TaskRun> })),
        ("task_workspace_pin", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::TaskWorkspace", schema: schema_of::<cognia_task_workspace::TaskWorkspace> })),
        ("task_workspace_resolve_conflict", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::ApplyOutcome", schema: schema_of::<cognia_task_workspace::ApplyOutcome> })),
        ("task_workspace_prune", OutputShape::Derived(DerivedOutput { rust_type: "cognia_task_workspace::PruneOutcome", schema: schema_of::<cognia_task_workspace::PruneOutcome> })),
        ("fs_workspace_roots", OutputShape::Declared(RootType::Object)),
        ("fs_list_workspace_dir", OutputShape::Declared(RootType::Array)),
        ("fs_stat_workspace_file", OutputShape::Opaque(RootType::Object)),
        ("fs_create_workspace_dir", OutputShape::Scalar(ScalarShape::Null)),
        ("fs_delete_workspace_entry", OutputShape::Scalar(ScalarShape::Null)),
        ("fs_rename_workspace_entry", OutputShape::Scalar(ScalarShape::Null)),
        ("fs_copy_workspace_entry", OutputShape::Scalar(ScalarShape::Null)),

        // ── terminal (rpc/terminal.rs) ───────────────────────────────────────
        ("terminal_list_all", OutputShape::Declared(RootType::Array)),
        ("terminal_list_for_project", OutputShape::Declared(RootType::Array)),
        ("terminal_kill", OutputShape::Scalar(ScalarShape::Null)),
        ("terminal_exec", OutputShape::Derived(DerivedOutput { rust_type: "crate::terminal::exec::TerminalExecResult", schema: schema_of::<crate::terminal::exec::TerminalExecResult> })),
        ("terminal_complete_paths", OutputShape::Derived(DerivedOutput { rust_type: "Vec<cognia_terminal::complete::PathCandidate>", schema: schema_of::<Vec<crate::terminal::complete::PathCandidate>> })),
        ("terminal_list_path_executables", OutputShape::Declared(RootType::Object)),
        ("terminal_kill_port", OutputShape::Derived(DerivedOutput { rust_type: "Vec<u32>", schema: schema_of::<Vec<u32>> })),
        ("terminal_detect_multiplexer", OutputShape::Declared(RootType::Object)),
        ("terminal_list_tmux_sessions", OutputShape::Derived(DerivedOutput { rust_type: "Vec<cognia_terminal::multiplexer::TmuxSession>", schema: schema_of::<Vec<crate::terminal::multiplexer::TmuxSession>> })),
        ("terminal_list_tmux_windows", OutputShape::Derived(DerivedOutput { rust_type: "Vec<cognia_terminal::multiplexer::TmuxWindow>", schema: schema_of::<Vec<crate::terminal::multiplexer::TmuxWindow>> })),
        ("terminal_host_status", OutputShape::Declared(RootType::Object)),
        ("terminal_host_configure", OutputShape::Declared(RootType::Object)),
        ("terminal_host_sync_profiles", OutputShape::Declared(RootType::Object)),

        // ── sftp (sftp_service.rs via rpc/sftp.rs) ───────────────────────────
        ("sftp_list_dir", OutputShape::Declared(RootType::Object)),
        ("sftp_stat", OutputShape::Declared(RootType::Object)),
        ("sftp_realpath", OutputShape::Declared(RootType::Object)),
        ("sftp_create_dir", OutputShape::Declared(RootType::Object)),
        ("sftp_rename_entry", OutputShape::Declared(RootType::Object)),
        ("sftp_delete_entry", OutputShape::Declared(RootType::Object)),
        ("sftp_download_open", OutputShape::Declared(RootType::Object)),
        ("sftp_download_read_chunk", OutputShape::Declared(RootType::Object)),
        ("sftp_download_close", OutputShape::Declared(RootType::Object)),
        ("sftp_upload_open", OutputShape::Declared(RootType::Object)),
        ("sftp_upload_write_chunk", OutputShape::Declared(RootType::Object)),
        ("sftp_upload_commit", OutputShape::Declared(RootType::Object)),
        ("sftp_upload_abort", OutputShape::Declared(RootType::Object)),
        ("sftp_session_close", OutputShape::Declared(RootType::Object)),

        // ── plugins (rpc/plugins.rs) ─────────────────────────────────────────
        ("plugin_list", OutputShape::Opaque(RootType::Array)),
        ("plugin_runtime_snapshot", OutputShape::Declared(RootType::Object)),
        ("plugin_install", OutputShape::Opaque(RootType::Any)),
        ("plugin_install_from_github", OutputShape::Opaque(RootType::Any)),
        ("plugin_uninstall", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_stage_version", OutputShape::Opaque(RootType::Any)),
        ("plugin_commit_staged_update", OutputShape::Opaque(RootType::Object)),
        ("plugin_discard_staged_update", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_finalize_staged_update", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_backup_create", OutputShape::Opaque(RootType::Object)),
        ("plugin_backup_restore", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_backup_delete", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_set_status", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_permission_grant", OutputShape::Opaque(RootType::Any)),
        ("plugin_permission_list", OutputShape::Opaque(RootType::Array)),
        ("plugin_permission_revoke", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_set_shell_allowlist", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_set_network_allowlist", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_python_initialize", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_python_runtime_info", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_load", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_call_hook", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_push_config", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_python_get_tools", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_call_tool", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_call", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_eval", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_import", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_module_call", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_module_getattr", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_is_initialized", OutputShape::Scalar(ScalarShape::Bool)),
        ("plugin_python_get_info", OutputShape::Opaque(RootType::Any)),
        ("plugin_python_install_deps", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_python_unload", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_python_list", OutputShape::Scalar(ScalarShape::TextList)),
        ("plugin_api_invoke", OutputShape::Opaque(RootType::Object)),
        ("plugin_api_batch_invoke", OutputShape::Opaque(RootType::Object)),
        ("plugin_get_capabilities", OutputShape::Declared(RootType::Array)),
        ("plugin_workspace_repo_remove", OutputShape::Declared(RootType::Bool)),
        ("codeserver_supported", OutputShape::Scalar(ScalarShape::Bool)),
        ("codeserver_ensure", OutputShape::Declared(RootType::Object)),
        ("codeserver_status", OutputShape::Declared(RootType::Object)),
        ("codeserver_stop", OutputShape::Scalar(ScalarShape::Bool)),
        ("codeserver_stop_all", OutputShape::Scalar(ScalarShape::Null)),
        ("codeserver_open_file", OutputShape::Scalar(ScalarShape::Null)),
        ("codeserver_agent_open", OutputShape::Declared(RootType::Object)),
        ("codeserver_agent_apply_edit", OutputShape::Declared(RootType::Object)),
        ("codeserver_agent_read_active", OutputShape::Declared(RootType::Object)),
        ("codeserver_agent_save_all", OutputShape::Declared(RootType::Object)),
        ("codeserver_agent_show_diff", OutputShape::Declared(RootType::Object)),
        ("codeserver_agent_reveal", OutputShape::Declared(RootType::Object)),
        ("codeserver_agent_run_in_terminal", OutputShape::Declared(RootType::Object)),
        ("codeserver_agent_notify", OutputShape::Declared(RootType::Object)),
        ("codeserver_agent_workspace_snapshot", OutputShape::Scalar(ScalarShape::Null)),
        ("codeserver_read_user_settings", OutputShape::Scalar(ScalarShape::Text)),
        ("codeserver_write_user_settings", OutputShape::Scalar(ScalarShape::Null)),
        ("codeserver_read_runtime_args", OutputShape::Scalar(ScalarShape::Text)),
        ("codeserver_write_runtime_args", OutputShape::Scalar(ScalarShape::Null)),
        ("codeserver_build_proxy", OutputShape::Opaque(RootType::Any)),
        ("codeserver_activate_proxy", OutputShape::Scalar(ScalarShape::Bool)),
        ("codeserver_list_proxies", OutputShape::Opaque(RootType::Any)),
        ("codeserver_broker_validate_paths", OutputShape::Scalar(ScalarShape::TextList)),
        ("codeserver_broker_respond", OutputShape::Scalar(ScalarShape::Null)),
        ("codeserver_broker_notify", OutputShape::Scalar(ScalarShape::Null)),
        ("lsp_host_ensure", OutputShape::Scalar(ScalarShape::Null)),
        ("lsp_host_request", OutputShape::Scalar(ScalarShape::Text)),
        ("ensure_system_lsp_host", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_load_vscode", OutputShape::Declared(RootType::Object)),
        ("plugin_activate_vscode", OutputShape::Opaque(RootType::Any)),
        ("plugin_deactivate_vscode", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_unload_vscode", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_invoke_vscode_rpc", OutputShape::Scalar(ScalarShape::Text)),
        ("plugin_vscode_send_response", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_launch_js", OutputShape::Opaque(RootType::Any)),
        ("plugin_invoke_js_callback", OutputShape::Opaque(RootType::Any)),
        ("plugin_deactivate_js", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_stop_js", OutputShape::Scalar(ScalarShape::Null)),
        ("plugin_js_status", OutputShape::Scalar(ScalarShape::Bool)),
        ("plugin_wasm_load", OutputShape::Opaque(RootType::Any)),
        ("plugin_wasm_activate", OutputShape::Opaque(RootType::Any)),
        ("plugin_wasm_deactivate", OutputShape::Scalar(ScalarShape::Bool)),
        ("plugin_wasm_call", OutputShape::Scalar(ScalarShape::Text)),
        ("plugin_wasm_unload", OutputShape::Scalar(ScalarShape::Bool)),
        ("plugin_wasm_list", OutputShape::Opaque(RootType::Array)),

        // ── diagnostics (rpc/diagnostics.rs) ─────────────────────────────────
        ("logs_query", OutputShape::Declared(RootType::Object)),
        ("logs_list_files", OutputShape::Declared(RootType::Array)),
        ("fleet_get_snapshot", OutputShape::Declared(RootType::Object)),
        ("fleet_opencode_outbox_status", OutputShape::Declared(RootType::Object)),
        ("fleet_opencode_outbox_repair", OutputShape::Declared(RootType::Object)),
        ("fleet_worker_enrollment_create", OutputShape::Declared(RootType::Object)),
        ("fleet_worker_list", OutputShape::Declared(RootType::Array)),
        ("fleet_worker_set", OutputShape::Scalar(ScalarShape::Null)),
        ("fleet_project_managed_session", OutputShape::Scalar(ScalarShape::Null)),
        ("fleet_project_worker_load", OutputShape::Scalar(ScalarShape::Null)),
        ("fleet_remove_managed_session", OutputShape::Scalar(ScalarShape::Bool)),
        ("fleet_permission_respond", OutputShape::Scalar(ScalarShape::Bool)),
        ("fleet_question_respond", OutputShape::Scalar(ScalarShape::Bool)),
        ("fleet_question_reject", OutputShape::Scalar(ScalarShape::Bool)),
        ("fleet_opencode_send_message", OutputShape::Scalar(ScalarShape::Text)),
        ("fleet_focus_terminal", OutputShape::Scalar(ScalarShape::Null)),
        ("fleet_interrupt_session", OutputShape::Scalar(ScalarShape::Null)),
        ("lark_entry_issue", OutputShape::Declared(RootType::Object)),
        ("lark_result_complete", OutputShape::Declared(RootType::Object)),
        ("lark_metrics_record", OutputShape::Declared(RootType::Object)),

        // ── browser_gateway (browser_gateway.rs) ─────────────────────────────
        ("browser_capability", OutputShape::Opaque(RootType::Any)),
        ("browser_runtime_status", OutputShape::Declared(RootType::Object)),
        ("browser_session_ensure", OutputShape::Opaque(RootType::Object)),
        ("browser_session_get", OutputShape::Opaque(RootType::Object)),
        ("browser_session_close", OutputShape::Opaque(RootType::Any)),
        ("browser_navigate", OutputShape::Opaque(RootType::Any)),
        ("browser_snapshot", OutputShape::Declared(RootType::Object)),
        ("browser_act", OutputShape::Opaque(RootType::Any)),
        ("browser_drag", OutputShape::Opaque(RootType::Any)),
        ("browser_press_key", OutputShape::Opaque(RootType::Any)),
        ("browser_scroll", OutputShape::Opaque(RootType::Any)),
        ("browser_evaluate", OutputShape::Opaque(RootType::Any)),
        ("browser_read_console", OutputShape::Opaque(RootType::Any)),
        ("browser_read_network", OutputShape::Opaque(RootType::Any)),
        ("browser_back", OutputShape::Opaque(RootType::Any)),
        ("browser_forward", OutputShape::Opaque(RootType::Any)),
        ("browser_reload", OutputShape::Opaque(RootType::Any)),
        ("browser_stop", OutputShape::Opaque(RootType::Any)),
        ("browser_get_page", OutputShape::Opaque(RootType::Any)),
        ("browser_handle_dialog", OutputShape::Opaque(RootType::Any)),
        ("browser_pages", OutputShape::Opaque(RootType::Array)),
        ("browser_new_page", OutputShape::Opaque(RootType::Any)),
        ("browser_switch_page", OutputShape::Opaque(RootType::Any)),
        ("browser_close_page", OutputShape::Opaque(RootType::Any)),
        ("browser_wait_for", OutputShape::Opaque(RootType::Any)),
        ("browser_wait_for_load", OutputShape::Opaque(RootType::Any)),
        ("browser_screenshot", OutputShape::Opaque(RootType::Any)),
        ("browser_set_files", OutputShape::Opaque(RootType::Any)),
        ("browser_downloads", OutputShape::Opaque(RootType::Array)),
        ("browser_set_zoom", OutputShape::Opaque(RootType::Any)),
        ("browser_find", OutputShape::Opaque(RootType::Any)),
        ("browser_find_clear", OutputShape::Opaque(RootType::Any)),
    ];

    // ── The ledger ──────────────────────────────────────────────────────────
    //
    // Two numbers, in the two directions that mean progress. The JS side
    // ratchets the same debt from the emitted specs (`opaque-response-schema`
    // in `scripts/gates/rpc-semantic-parity-baseline.json`); these count arms
    // rather than schemas, and they are what a conversion moves.
    //
    // There is deliberately no ceiling on `Declared`. A command that ships
    // with a hand-written schema is the ordinary case today, and a ceiling
    // there would make every new command fight this file for a reason that has
    // nothing to do with the command. `Opaque` is the one worth refusing,
    // because it is where an arm escapes having a shape at all.
    const OPAQUE_CEILING: usize = 158;
    const DERIVED_FLOOR: usize = 57;

    // ── Reading a JSON Schema down to what a client can break on ────────────

    fn published() -> Value {
        serde_json::from_str(PUBLISHED).expect("the published contract is JSON")
    }

    /// Follow `$ref` into a `$defs` map. Bounded, so a cycle is a failure and
    /// not a hang.
    fn resolve<'a>(schema: &'a Value, defs: &'a Value) -> &'a Value {
        let mut current = schema;
        for _ in 0..16 {
            let Some(reference) = current.get("$ref").and_then(Value::as_str) else {
                return current;
            };
            let name = reference.rsplit('/').next().unwrap_or_default();
            current = defs
                .get(name)
                .unwrap_or_else(|| panic!("unresolvable $ref: {reference}"));
        }
        panic!("cyclic $ref chain starting at {schema}")
    }

    /// Every JSON type the root of `schema` may take.
    fn root_types(schema: &Value, defs: &Value) -> BTreeSet<String> {
        let schema = resolve(schema, defs);
        if let Some(branches) = schema
            .get("oneOf")
            .or_else(|| schema.get("anyOf"))
            .and_then(Value::as_array)
        {
            return branches
                .iter()
                .flat_map(|branch| root_types(branch, defs))
                .collect();
        }
        match schema.get("type") {
            Some(Value::String(one)) => BTreeSet::from([one.clone()]),
            Some(Value::Array(many)) => many
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect(),
            _ => BTreeSet::new(),
        }
    }

    fn root_type_of(schema: &Value, defs: &Value) -> RootType {
        let types = root_types(schema, defs);
        let names: Vec<&str> = types.iter().map(String::as_str).collect();
        match names.as_slice() {
            ["null"] => RootType::Null,
            ["boolean"] => RootType::Bool,
            ["integer"] => RootType::Integer,
            ["string"] => RootType::Text,
            ["null", "string"] => RootType::NullableText,
            ["array"] => RootType::Array,
            ["object"] => RootType::Object,
            ["null", "object"] => RootType::NullableObject,
            ["array", "boolean", "null", "number", "object", "string"] => RootType::Any,
            _ => RootType::Union,
        }
    }

    /// The part of a schema a client can break on.
    ///
    /// Deliberately ignores `title`, `description`, `format`, numeric bounds
    /// and the `x-cognia-*` annotations. `schemars` writes `format: "int32"`
    /// where the hand-written file writes nothing, and neither one changes what
    /// a caller must accept. It does keep `enum` and `const`, because a client
    /// switches on those and losing one silently widens the contract.
    #[derive(Debug, PartialEq, Eq)]
    struct Shape {
        types: BTreeSet<String>,
        choices: Option<BTreeSet<String>>,
        required: BTreeSet<String>,
        properties: BTreeMap<String, Shape>,
        items: Option<Box<Shape>>,
        closed: bool,
    }

    fn shape(schema: &Value, defs: &Value) -> Shape {
        let resolved = resolve(schema, defs);
        let choices = resolved
            .get("enum")
            .and_then(Value::as_array)
            .map(|values| values.iter().map(Value::to_string).collect())
            .or_else(|| {
                resolved
                    .get("const")
                    .map(|value| BTreeSet::from([value.to_string()]))
            });
        Shape {
            types: root_types(schema, defs),
            choices,
            required: resolved
                .get("required")
                .and_then(Value::as_array)
                .map(|names| {
                    names
                        .iter()
                        .filter_map(|name| name.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            properties: resolved
                .get("properties")
                .and_then(Value::as_object)
                .map(|properties| {
                    properties
                        .iter()
                        .map(|(name, property)| (name.clone(), shape(property, defs)))
                        .collect()
                })
                .unwrap_or_default(),
            items: resolved
                .get("items")
                .map(|items| Box::new(shape(items, defs))),
            closed: resolved.get("additionalProperties") == Some(&Value::Bool(false)),
        }
    }

    /// Every arm the shared dispatcher serves. `client` commands are relayed to
    /// the renderer, which is what produces their payload, so no Rust type can
    /// describe them and the response contract does not carry one either.
    fn dispatchable_arms() -> Vec<&'static str> {
        WIRE_COMMANDS
            .iter()
            .filter(|command| command.target != CommandTarget::Client)
            .map(|command| command.arm)
            .collect()
    }

    // ── The gates ───────────────────────────────────────────────────────────

    #[test]
    fn registry_covers_every_dispatchable_arm() {
        let declared: BTreeSet<&str> = OUTPUT_SHAPES.iter().map(|(arm, _)| *arm).collect();
        let dispatchable: BTreeSet<&str> = dispatchable_arms().into_iter().collect();

        let undeclared: Vec<&&str> = dispatchable.difference(&declared).collect();
        assert!(
            undeclared.is_empty(),
            "these arms answer on the wire and declare no output shape. Add a row \
             to OUTPUT_SHAPES naming the Rust type it returns, or the root type it \
             still answers by hand: {undeclared:?}"
        );

        let stale: Vec<&&str> = declared.difference(&dispatchable).collect();
        assert!(
            stale.is_empty(),
            "these rows name something the dispatcher no longer serves: {stale:?}"
        );
    }

    #[test]
    fn no_arm_is_declared_twice() {
        // A duplicate row would let `registry_covers_every_dispatchable_arm`
        // pass on the set while the two rows disagreed about the shape, and the
        // second one would be the silent loser.
        let mut seen = BTreeSet::new();
        let repeated: Vec<&str> = OUTPUT_SHAPES
            .iter()
            .filter(|(arm, _)| !seen.insert(*arm))
            .map(|(arm, _)| *arm)
            .collect();
        assert!(repeated.is_empty(), "declared twice: {repeated:?}");
    }

    #[test]
    fn declared_root_types_match_the_published_contract() {
        let published = published();
        let defs = &published["$defs"];
        let commands = &published["commands"];
        let mut wrong = Vec::new();

        for (arm, shape) in OUTPUT_SHAPES {
            let Some(declared) = shape.declared_root() else {
                continue;
            };
            let entry = &commands[*arm];
            assert!(
                !entry.is_null(),
                "{arm} has no entry in protocol/companion-response-schemas.json"
            );
            let actual = root_type_of(entry, defs);
            if actual != declared {
                wrong.push(format!(
                    "{arm}: registry says {declared:?}, contract says {actual:?}"
                ));
            }
        }

        assert!(
            wrong.is_empty(),
            "the arm and the published contract disagree about the JSON root, which \
             is the difference between a client reading a missing field and a client \
             failing to parse:\n  {}",
            wrong.join("\n  ")
        );
    }

    #[test]
    fn derived_schemas_match_the_published_contract() {
        let published = published();
        let published_defs = &published["$defs"];
        let commands = &published["commands"];
        let mut wrong = Vec::new();

        for (arm, output) in OUTPUT_SHAPES {
            let OutputShape::Derived(derived) = output else {
                continue;
            };
            let generated =
                serde_json::to_value((derived.schema)()).expect("a schemars schema serialises");
            let generated_defs = generated
                .get("$defs")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));

            let from_rust = shape(&generated, &generated_defs);
            let from_contract = shape(&commands[*arm], published_defs);
            if from_rust != from_contract {
                wrong.push(format!(
                    "{arm} ({})\n    rust:     {from_rust:?}\n    contract: {from_contract:?}",
                    derived.rust_type
                ));
            }
        }

        assert!(
            wrong.is_empty(),
            "the Rust type and the published contract describe different answers. \
             Once an arm is Derived the type is the contract, so fix the file, not \
             the struct:\n  {}",
            wrong.join("\n  ")
        );
    }

    #[test]
    fn the_opaque_ledger_only_falls_and_the_derived_one_only_rises() {
        let opaque = OUTPUT_SHAPES
            .iter()
            .filter(|(_, shape)| matches!(shape, OutputShape::Opaque(_)))
            .count();
        let derived = OUTPUT_SHAPES
            .iter()
            .filter(|(_, shape)| matches!(shape, OutputShape::Derived(_)))
            .count();

        assert!(
            opaque <= OPAQUE_CEILING,
            "{opaque} arms answer a deliberately shapeless payload, up from \
             {OPAQUE_CEILING}. Opaque is for a payload another domain defines, \
             not for one that has not been typed yet."
        );
        assert!(
            derived >= DERIVED_FLOOR,
            "{derived} arms derive their schema from the Rust type, down from \
             {DERIVED_FLOOR}. A conversion is not undone by hand."
        );
    }

    #[test]
    fn every_opaque_arm_carries_its_reason_and_owner_in_the_contract() {
        // ADR-0175: a shapeless payload stays shapeless only with a stated
        // reason and an owner. Both live on the shared `$def` and are emitted
        // onto the specs by `gen-companion-api.mjs`. This holds the Rust side's
        // idea of which arms are opaque against that.
        let published = published();
        let defs = &published["$defs"];
        let commands = &published["commands"];
        let mut unexplained = Vec::new();

        for (arm, shape) in OUTPUT_SHAPES {
            if !matches!(shape, OutputShape::Opaque(_)) {
                continue;
            }
            let resolved = resolve(&commands[*arm], defs);
            if resolved.get("x-cognia-opaque-reason").is_none() {
                unexplained.push(*arm);
            }
        }

        assert!(
            unexplained.is_empty(),
            "these arms are registered opaque and the contract states no reason: \
             {unexplained:?}"
        );
    }

    #[test]
    fn nothing_outside_the_opaque_rows_is_shapeless() {
        // The other direction, and the one that catches drift: a schema that
        // quietly became `LegacyResult` while its row still claims a shape.
        let published = published();
        let defs = &published["$defs"];
        let commands = &published["commands"];
        let mut leaked = Vec::new();

        for (arm, shape) in OUTPUT_SHAPES {
            if matches!(shape, OutputShape::Opaque(_)) {
                continue;
            }
            let resolved = resolve(&commands[*arm], defs);
            if resolved.get("x-cognia-opaque-reason").is_some() {
                leaked.push(*arm);
            }
        }

        assert!(
            leaked.is_empty(),
            "these arms answer an opaque schema without being registered as \
             opaque, so they are not counted by the ledger: {leaked:?}"
        );
    }

    /// Write the derived half of the published contract to `target/`.
    ///
    /// Ignored by default, because it writes a file rather than checking one:
    /// `cargo test -p cognia-next --lib companion_api::output_registry -- \
    /// --ignored derived_schema_slice`. Merging the slice into
    /// `protocol/companion-response-schemas.json` is still a hand step, and
    /// stays one until `companion-contract-emit` owns the whole file. The
    /// merge is not what keeps the two honest either way, this module's
    /// `derived_schemas_match_the_published_contract` is.
    #[test]
    #[ignore = "writes target/derived-response-schemas.json rather than checking anything"]
    fn derived_schema_slice() {
        let mut commands = serde_json::Map::new();
        let mut defs = serde_json::Map::new();

        for (arm, output) in OUTPUT_SHAPES {
            let OutputShape::Derived(derived) = output else {
                continue;
            };
            let mut generated =
                serde_json::to_value((derived.schema)()).expect("a schemars schema serialises");
            let object = generated
                .as_object_mut()
                .expect("a schema is a JSON object here");
            object.remove("$schema");
            let title = object
                .remove("title")
                .and_then(|title| title.as_str().map(str::to_string));
            if let Some(Value::Object(own)) = object.remove("$defs") {
                for (name, definition) in own {
                    if let Some(existing) = defs.get(&name) {
                        assert_eq!(
                            existing, &definition,
                            "two Rust types both want the $def name {name}"
                        );
                    }
                    defs.insert(name, definition);
                }
            }

            // A struct root is worth a name, because several arms answer the
            // same one. A `Vec` or an `Option` wrapper is not: it is one line
            // that points at the named thing inside it.
            let root = Value::Object(object.clone());
            let entry = match (root.get("type").and_then(Value::as_str), title) {
                (Some("object"), Some(name)) => {
                    // No `x-cognia-wire-source` note: the `$def` is named for
                    // the Rust type, and a nested `$ref` to the same type
                    // produces the same definition, which this compares whole.
                    //
                    // The check is load-bearing rather than defensive. A
                    // generic wire type is titled by its bare name unless it
                    // says otherwise, so `Page<A>` and `Page<B>` both arrived
                    // here as `Page` and the second silently published its
                    // items for both.
                    if let Some(existing) = defs.get(&name) {
                        assert_eq!(
                            existing, &root,
                            "{} and an earlier type both want the $def name {name}. A generic \
                             needs #[schemars(rename = \"Name_of_{{T}}\")].",
                            derived.rust_type
                        );
                    }
                    defs.insert(name.clone(), root);
                    serde_json::json!({ "$ref": format!("#/$defs/{name}") })
                }
                _ => root,
            };
            commands.insert((*arm).to_string(), entry);
        }

        let slice = serde_json::json!({ "$defs": defs, "commands": commands });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../target/derived-response-schemas.json");
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&slice).expect("serialisable"),
        )
        .expect("target/ is writable");
        eprintln!(
            "wrote {} command(s) to {}",
            slice["commands"].as_object().unwrap().len(),
            path.display()
        );
    }

    #[test]
    fn the_shape_reader_ignores_annotation_and_keeps_structure() {
        // A guard on the comparator itself: without it, a test that always
        // returns an empty shape would pass every agreement check above.
        let defs = serde_json::json!({
            "Row": {
                "type": "object",
                "required": ["id"],
                "properties": { "id": { "type": "string", "enum": ["a", "b"] } },
                "additionalProperties": false
            }
        });
        let annotated = serde_json::json!({
            "type": "array",
            "title": "Array_of_Row",
            "description": "ignored",
            "items": { "$ref": "#/$defs/Row" }
        });
        let bare = serde_json::json!({
            "type": "array",
            "items": {
                "type": "object",
                "format": "ignored",
                "required": ["id"],
                "properties": { "id": { "type": "string", "enum": ["b", "a"] } },
                "additionalProperties": false
            }
        });
        assert_eq!(shape(&annotated, &defs), shape(&bare, &defs));

        let narrower = serde_json::json!({
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id"],
                "properties": { "id": { "type": "string" } },
                "additionalProperties": false
            }
        });
        assert_ne!(
            shape(&annotated, &defs),
            shape(&narrower, &defs),
            "dropping an enum has to register as a different answer"
        );
    }
}
