//! Holds the command contract to what the desktop actually dispatches and
//! serializes. `command_manifest` lives in `cognia-companion-contract`
//! (ADR-0196 P4), below the router and the domain crates these checks build
//! values from, so the checks live on the app side.

#[cfg(test)]
mod tests {
    use super::super::command_manifest::{headless_contract, remote_command_names};

    /// The dispatcher reads its allowlist from the contract: every remote
    /// descriptor, in contract order, and nothing else. The contract crate
    /// pins that the remote set is exactly the non-client descriptors.
    #[test]
    fn the_router_allowlist_is_the_contract_remote_set() {
        assert_eq!(super::super::rpc::known_commands(), remote_command_names());
    }

    /// Output contracts are hand-written, and the only gate over them
    /// (`check-rpc-semantic-parity`) ratchets how *opaque* they are, not
    /// whether their root type matches what the arm emits. `LegacyRecord`
    /// (object) and `LegacyList` (array) grade identically. So a
    /// collection-returning arm declared as a record passed every gate and
    /// then rejected its own result at runtime with a 500
    /// `contract_output_violation`.
    ///
    /// `integration_ingress_poll` shipped exactly that way. It returns
    /// `Vec<SpoolDelivery>`, which serializes to `[]` on an empty spool, and
    /// `{"type":"object"}` refuses an array. So the headless brain's
    /// Integration ingress runtime failed to install on *every* boot, whether
    /// or not any Integration account existed.
    ///
    /// The values below are serialized from the real types the arms hand to
    /// `to_json`, not hand-copied JSON literals: a literal stops proving
    /// anything the moment a struct gains a field.
    #[test]
    fn output_contracts_accept_what_the_dispatch_arms_actually_serialize() {
        let contract = headless_contract().expect("embedded Headless contract");

        // `integration_ingress_poll` returns `Vec<SpoolDelivery>`.
        contract
            .validate_output("integration_ingress_poll", &serde_json::json!([]))
            .expect("an empty ingress spool is the common case, not an error");
        let delivery = crate::workflow::integration_spool::SpoolDelivery {
            route_id: "route-a".to_string(),
            delivery_id: "delivery-a".to_string(),
            event_type: None,
            headers: std::collections::BTreeMap::from([(
                "x-github-event".to_string(),
                "push".to_string(),
            )]),
            body: "{}".to_string(),
            received_at: "2026-08-20T00:00:00Z".to_string(),
            attempts: 0,
        };
        contract
            .validate_output(
                "integration_ingress_poll",
                &serde_json::to_value(vec![delivery]).expect("serialize spool delivery"),
            )
            .expect("a spooled delivery must satisfy its own output contract");
        assert!(
            contract
                .validate_output("integration_ingress_poll", &serde_json::json!({}))
                .is_err(),
            "the record shape this command used to declare must stay rejected"
        );

        // `plugin_get_capabilities` returns `Vec<PluginApiCapability>`, straight
        // from the production capability table.
        contract
            .validate_output(
                "plugin_get_capabilities",
                &serde_json::to_value(
                    crate::plugin_api::api_bridge::plugin_get_capabilities_for_host(false),
                )
                .expect("serialize capability table"),
            )
            .expect("the advertised capability table must satisfy its output contract");

        // `plugin_runtime_snapshot` returns one snapshot, not a list.
        let snapshot = crate::plugin_api::PluginRuntimeSnapshot {
            plugin_id: "cognia.demo".to_string(),
            version: "1.0.0".to_string(),
            status: "active".to_string(),
            last_error: None,
            loaded_at: None,
            install_path: "/tmp/cognia.demo".to_string(),
        };
        contract
            .validate_output(
                "plugin_runtime_snapshot",
                &serde_json::to_value(snapshot).expect("serialize runtime snapshot"),
            )
            .expect("one plugin snapshot must satisfy its output contract");

        // `task_workspace_settle` returns `Vec<ResourceChange>`.
        contract
            .validate_output("task_workspace_settle", &serde_json::json!([]))
            .expect("settling a run with no changed resources is not an error");
        assert!(
            contract
                .validate_output("task_workspace_settle", &serde_json::json!({}))
                .is_err(),
            "the record shape this command used to declare must stay rejected"
        );
    }
}
