//! Host-admin RPC arms for the Host's own connectivity configuration
//! (ADR-0170, "backend equivalence").
//!
//! Every command here used to exist only as a `#[tauri::command]`: the
//! desktop renderer could read and change the relay/signaling settings, the
//! browser-origin allowlist and the push credentials, and a headless Host
//! could only take the same decisions from environment variables at boot.
//! These arms put the same functions on the owner-authenticated RPC plane
//! (`target: host-admin`, `capability: host.admin`), so the Connectivity
//! settings work identically against a desktop and a headless Host, and the
//! desktop commands are now thin wrappers over the functions called here.
//!
//! What stays desktop-only, and is *labelled* so in the settings rather than
//! hidden: the cloudflared tunnel and mDNS. Both need the desktop process
//! (a child process, a LAN multicast socket) and have no headless meaning.

use std::sync::Arc;

use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "companion_signaling_status",
    "companion_signaling_configure",
    "companion_signaling_devices_status",
    "companion_signaling_reconnect_device",
    "companion_browser_access_get",
    "companion_browser_access_set",
    "companion_push_status",
    "companion_push_configure_fcm",
    "companion_push_configure_apns",
    "companion_push_clear_fcm",
    "companion_push_clear_apns",
    "companion_push_notification",
    "companion_create_owner_invitation",
    "companion_server_status",
];

/// The signaling hub, or the structured error a caller can act on.
fn hub(
    name: &str,
) -> Result<Arc<crate::companion_api::signaling::SignalingHub>, (StatusCode, Json<RpcError>)> {
    crate::companion_api::signaling::installed_hub().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(RpcError::new(
                "signaling_unavailable",
                format!("{name}: no signaling hub is installed on this host"),
            )),
        )
    })
}

/// Where the browser listener is actually bound right now: the desktop's
/// server state when there is one, else the process-global the headless
/// binary sets when it binds the plane.
fn browser_bound_port(host: &super::super::dispatch_host::DispatchHost) -> Option<u16> {
    if let super::super::dispatch_host::DispatchHost::Tauri(app) = host {
        use tauri::Manager as _;
        if let Some(state) = app.try_state::<crate::companion_api::CompanionServerState>() {
            return state.browser_port();
        }
    }
    crate::companion_api::browser_advertised_port()
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
    let _ = (device_id, account_id, scope);
    match name {
        // ── Relay / signaling ──────────────────────────────────────────────
        "companion_signaling_status" => to_json(hub(name)?.status()),

        "companion_signaling_configure" => {
            let patch: crate::companion_api::signaling::SignalingConfigPatch =
                required(&args, "patch")?;
            let hub = hub(name)?;
            // A headless Host has no renderer to re-push this at boot, so it
            // is persisted beside the other channel configs and reapplied by
            // `cognia-server serve` (ADR-0170). The desktop keeps its copy in
            // `AppSettings` and needs no file.
            if state.app_handle.is_none() {
                let data_dir = host.data_dir().map_err(RpcError::internal)?;
                crate::companion_api::signaling_config::save(Some(&data_dir), &patch)
                    .map_err(RpcError::internal)?;
            }
            hub.apply_patch(patch);
            Ok(Value::Null)
        }

        "companion_signaling_devices_status" => to_json(hub(name)?.devices_status()),

        "companion_signaling_reconnect_device" => {
            let rendezvous_id: String = required_aliased(&args, "rendezvous_id", "rendezvousId")?;
            hub(name)?
                .reconnect_device(&rendezvous_id)
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        // ── Browser access (plaintext loopback plane) ──────────────────────
        "companion_browser_access_get" => {
            let data_dir = host.data_dir().map_err(RpcError::internal)?;
            let config = crate::companion_api::browser_access::load(Some(&data_dir));
            to_json(crate::companion_api::commands::browser_access_summary_from(
                config,
                browser_bound_port(host),
            ))
        }

        "companion_browser_access_set" => {
            let enabled: bool = required(&args, "enabled")?;
            let allowed_origins: Vec<String> =
                required_aliased(&args, "allowed_origins", "allowedOrigins")?;
            let port: Option<u16> = optional(&args, "port")?;
            let data_dir = host.data_dir().map_err(RpcError::internal)?;
            let saved = crate::companion_api::browser_access::save(
                Some(&data_dir),
                crate::companion_api::browser_access::BrowserAccessConfig {
                    enabled,
                    allowed_origins,
                    port: port.unwrap_or(crate::companion_api::browser_access::DEFAULT_BROWSER_PORT),
                },
            )
            .map_err(RpcError::internal)?;
            to_json(crate::companion_api::commands::browser_access_summary_from(
                saved,
                browser_bound_port(host),
            ))
        }

        // ── Push credentials ───────────────────────────────────────────────
        "companion_push_status" => {
            to_json(crate::companion_api::commands::companion_push_status().map_err(RpcError::internal)?)
        }

        "companion_push_configure_fcm" => {
            let service_account_json: String =
                required_aliased(&args, "service_account_json", "serviceAccountJson")?;
            crate::companion_api::commands::companion_push_configure_fcm(service_account_json)
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "companion_push_configure_apns" => {
            let key_id: String = required_aliased(&args, "key_id", "keyId")?;
            let team_id: String = required_aliased(&args, "team_id", "teamId")?;
            let bundle_id: String = required_aliased(&args, "bundle_id", "bundleId")?;
            let private_key_pem: String =
                required_aliased(&args, "private_key_pem", "privateKeyPem")?;
            let production: bool = required(&args, "production")?;
            crate::companion_api::commands::companion_push_configure_apns(
                key_id,
                team_id,
                bundle_id,
                private_key_pem,
                production,
            )
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "companion_push_clear_fcm" => {
            crate::companion_api::commands::companion_push_clear_fcm().map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "companion_push_clear_apns" => {
            crate::companion_api::commands::companion_push_clear_apns().map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "companion_push_notification" => {
            let notification_id: String =
                required_aliased(&args, "notification_id", "notificationId")?;
            let source: String = required(&args, "source")?;
            let level: String = required(&args, "level")?;
            let href: Option<String> = optional(&args, "href")?;
            to_json(
                crate::companion_api::commands::broadcast_notification_push(
                    &state.push_tokens,
                    &notification_id,
                    &source,
                    &level,
                    href.as_deref(),
                )
                .await
                .map_err(RpcError::internal)?,
            )
        }

        // ── Pairing ────────────────────────────────────────────────────────
        "companion_create_owner_invitation" => {
            let (base_url, fingerprint, app_version) = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    use tauri::Manager as _;
                    let state = app
                        .try_state::<crate::companion_api::CompanionServerState>()
                        .ok_or_else(|| RpcError::internal("companion server state unavailable".to_string()))?;
                    let port = state
                        .bound_port()
                        .unwrap_or(crate::companion_api::server::DEFAULT_PORT);
                    let (base_url, is_tunnel) = if let Some(info) = state.tunnel.current() {
                        (info.public_url, true)
                    } else if let Some(hostname) = state.tunnel.named_public_url() {
                        (hostname, true)
                    } else {
                        let host = match state.bind_mode() {
                            Some(crate::companion_api::BindMode::Lan) => {
                                crate::companion_api::commands::detect_lan_ip()
                                    .unwrap_or_else(|| "127.0.0.1".to_string())
                            }
                            _ => "127.0.0.1".to_string(),
                        };
                        (format!("https://{host}:{port}"), false)
                    };
                    let fingerprint = if is_tunnel {
                        String::new()
                    } else {
                        crate::companion_api::tls_fingerprint()
                    };
                    (
                        base_url,
                        fingerprint,
                        app.package_info().version.to_string(),
                    )
                }
                super::super::dispatch_host::DispatchHost::Headless(_) => {
                    let port = crate::companion_api::advertised_port();
                    let base_url = std::env::var("COGNIA_PUBLIC_URL")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| format!("https://127.0.0.1:{port}"));
                    (
                        base_url,
                        crate::companion_api::tls_fingerprint(),
                        env!("CARGO_PKG_VERSION").to_string(),
                    )
                }
            };
            let host_id = {
                let secret = state.secret.read();
                crate::companion_api::healthz::derive_server_id(&secret)
            };
            to_json(
                crate::companion_api::commands::issue_owner_invitation(
                    base_url,
                    fingerprint,
                    app_version,
                    host_id,
                    "host-admin-rpc",
                )
                .map_err(RpcError::internal)?,
            )
        }

        // ── Server status ──────────────────────────────────────────────────
        "companion_server_status" => {
            if let super::super::dispatch_host::DispatchHost::Tauri(app) = host {
                use tauri::Manager as _;
                if let Some(state) = app.try_state::<crate::companion_api::CompanionServerState>() {
                    let bind_mode = match state.bind_mode() {
                        Some(crate::companion_api::BindMode::Loopback) => "loopback",
                        Some(crate::companion_api::BindMode::Lan) => "lan",
                        None => "none",
                    };
                    return to_json(crate::companion_api::commands::CompanionServerStatus {
                        running: state.is_running(),
                        bind_mode,
                        bound_port: state.bound_port(),
                    });
                }
            }
            // Headless: the listener this request arrived on is the server,
            // so "running" is by construction, and the binding is whatever
            // the `serve` flags chose.
            let port = crate::companion_api::advertised_port();
            to_json(crate::companion_api::commands::CompanionServerStatus {
                running: port > 0,
                bind_mode: if port == 0 {
                    "none"
                } else if crate::companion_api::bind_loopback_only() {
                    "loopback"
                } else {
                    "lan"
                },
                bound_port: (port > 0).then_some(port),
            })
        }

        _ => Err(RpcError::unknown_command(name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every arm here is allowlisted, and every name is on the owner-only
    /// host-admin plane in the manifest: a name that dispatches but is not
    /// declared would 404 remotely, and one declared without `host.admin`
    /// would let a plain paired device reconfigure the Host.
    #[test]
    fn every_host_admin_command_is_known_and_owner_gated() {
        for name in COMMANDS {
            assert!(
                crate::companion_api::rpc::known_commands().contains(name),
                "{name} is dispatched here but missing from KNOWN_COMMANDS"
            );
            let descriptor = crate::companion_api::command_manifest::commands()
                .iter()
                .find(|command| command.name == *name)
                .unwrap_or_else(|| panic!("{name} is not in the command manifest"));
            assert_eq!(
                descriptor.target,
                crate::companion_api::command_manifest::CommandTarget::HostAdmin,
                "{name} target"
            );
            assert_eq!(descriptor.capability, "host.admin", "{name} capability");
        }
    }

    /// Without a signaling hub installed (the test binary never installs
    /// one) the arms that need it answer 503 with a code a client can act on,
    /// not a panic and not an opaque 500.
    #[test]
    fn signaling_arms_report_a_missing_hub_as_unavailable() {
        let err = hub("companion_signaling_status").err().expect("no hub in tests");
        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.1 .0.code, "signaling_unavailable");
    }

    /// The headless binary publishes the browser plane's bound port through a
    /// process global, which is what the invitation base URL and the
    /// browser-access summary read when there is no desktop server state.
    #[test]
    fn browser_advertised_port_round_trips_through_the_global() {
        crate::companion_api::set_browser_advertised_port(27891);
        assert_eq!(crate::companion_api::browser_advertised_port(), Some(27891));
        crate::companion_api::set_browser_advertised_port(0);
        assert_eq!(crate::companion_api::browser_advertised_port(), None);
    }
}
