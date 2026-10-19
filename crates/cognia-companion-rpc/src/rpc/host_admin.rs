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
    "companion_push_configure_hms",
    "companion_push_clear_fcm",
    "companion_push_clear_apns",
    "companion_push_clear_hms",
    "companion_push_notification",
    "companion_create_owner_invitation",
    "companion_server_status",
    "host_update_status",
    "host_update_refresh",
    "host_update_configure",
    "host_update_install",
    "host_runtime_status",
    "host_runtime_restart",
];

/// This host's updater (ADR-0224 A10); the desktop app has none.
fn host_updater(
    name: &str,
) -> Result<Arc<cognia_companion::host_update::HostUpdater>, (StatusCode, Json<RpcError>)> {
    cognia_companion::host_update::installed().ok_or_else(|| RpcError::headless_host_required(name))
}

/// The brain's headless runtimes (ADR-0059 W2): what it holds, or the error a
/// caller can act on. A desktop has no brain to ask.
async fn brain_runtimes(
    name: &str,
    action: cognia_companion::runtime_control::RuntimeControlAction,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    if cognia_companion::runtime::headless().is_none() {
        return Err(RpcError::headless_host_required(name));
    }
    cognia_companion::runtime_control::call_brain(action)
        .await
        .map_err(runtime_control_error)
}

fn runtime_control_error(
    error: cognia_companion::runtime_control::RuntimeControlError,
) -> (StatusCode, Json<RpcError>) {
    let status = match error.code.as_str() {
        "invalid_argument" => StatusCode::BAD_REQUEST,
        "runtime_not_found" => StatusCode::NOT_FOUND,
        "runtime_not_restartable" | "runtimes_stopped" => StatusCode::CONFLICT,
        "brain_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        "brain_timeout" => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_GATEWAY,
    };
    (status, Json(RpcError::new(&error.code, error.message)))
}

/// An update the host would not start, with the reason it gave.
fn update_refused(message: String) -> (StatusCode, Json<RpcError>) {
    (
        StatusCode::CONFLICT,
        Json(RpcError::new("host_update_refused", message)),
    )
}

/// The signaling hub, or the structured error a caller can act on.
fn hub(
    name: &str,
) -> Result<Arc<cognia_companion::signaling::SignalingHub>, (StatusCode, Json<RpcError>)> {
    cognia_companion::signaling::installed_hub().ok_or_else(|| {
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
fn browser_bound_port(host: &dyn crate::rpc_host::RpcHost) -> Option<u16> {
    if let Some(state) = host.companion_server() {
        return state.browser_port();
    }
    cognia_companion::browser_advertised_port()
}

pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &dyn crate::rpc_host::RpcHost,
    device_id: &str,
    tenant_id: Option<&str>,
    scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let _ = (device_id, tenant_id, scope);
    match name {
        // ── Relay / signaling ──────────────────────────────────────────────
        "companion_signaling_status" => to_json(hub(name)?.status()),

        "companion_signaling_configure" => {
            let patch: cognia_companion::signaling::SignalingConfigPatch =
                required(&args, "patch")?;
            let hub = hub(name)?;
            // A headless Host has no renderer to re-push this at boot, so it
            // is persisted beside the other channel configs and reapplied by
            // `cognia-server serve` (ADR-0170). The desktop keeps its copy in
            // `AppSettings` and needs no file.
            if state.renderer.is_none() {
                let data_dir = host.data_dir().map_err(RpcError::internal)?;
                cognia_companion::signaling_config::save(Some(&data_dir), &patch)
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
            let config = cognia_companion::browser_access::load(Some(&data_dir));
            to_json(crate::command_services::browser_access_summary_from(
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
            // `save_and_apply`, as the desktop command does: a headless Host
            // switched off from the Connectivity settings must stop taking
            // submissions now, not at its next restart.
            let saved = cognia_companion::browser_access::save_and_apply(
                Some(&data_dir),
                cognia_companion::browser_access::BrowserAccessConfig {
                    enabled,
                    allowed_origins,
                    port: port.unwrap_or(cognia_companion::browser_access::DEFAULT_BROWSER_PORT),
                },
            )
            .map_err(RpcError::internal)?;
            to_json(crate::command_services::browser_access_summary_from(
                saved,
                browser_bound_port(host),
            ))
        }

        // ── Push credentials ───────────────────────────────────────────────
        "companion_push_status" => {
            to_json(crate::command_services::companion_push_status().map_err(RpcError::internal)?)
        }

        "companion_push_configure_hms" => {
            let app_id: String = required_aliased(&args, "app_id", "appId")?;
            let client_secret: String = required_aliased(&args, "client_secret", "clientSecret")?;
            crate::command_services::companion_push_configure_hms(app_id, client_secret)
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }
        "companion_push_clear_hms" => {
            crate::command_services::companion_push_clear_hms().map_err(RpcError::internal)?;
            Ok(Value::Null)
        }
        "companion_push_configure_fcm" => {
            let service_account_json: String =
                required_aliased(&args, "service_account_json", "serviceAccountJson")?;
            crate::command_services::companion_push_configure_fcm(service_account_json)
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
            crate::command_services::companion_push_configure_apns(
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
            crate::command_services::companion_push_clear_fcm().map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "companion_push_clear_apns" => {
            crate::command_services::companion_push_clear_apns().map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "companion_push_notification" => {
            let notification_id: String =
                required_aliased(&args, "notification_id", "notificationId")?;
            let source: String = required(&args, "source")?;
            let level: String = required(&args, "level")?;
            let href: Option<String> = optional(&args, "href")?;
            to_json(
                crate::command_services::broadcast_notification_push(
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
            let (base_url, fingerprint, app_version) = match host.headless() {
                None => {
                    let state = host.companion_server().ok_or_else(|| {
                        RpcError::internal("companion server state unavailable".to_string())
                    })?;
                    let port = state
                        .bound_port()
                        .unwrap_or(cognia_companion::server::DEFAULT_PORT);
                    let (base_url, is_tunnel) = if let Some(info) = state.tunnel.current() {
                        (info.public_url, true)
                    } else if let Some(hostname) = state.tunnel.named_public_url() {
                        (hostname, true)
                    } else {
                        let host = match state.bind_mode() {
                            Some(cognia_companion::BindMode::Lan) => {
                                crate::command_services::advertised_lan_host(state.data_dir())
                                    .unwrap_or_else(|| "127.0.0.1".to_string())
                            }
                            _ => "127.0.0.1".to_string(),
                        };
                        (format!("https://{host}:{port}"), false)
                    };
                    let fingerprint = if is_tunnel {
                        String::new()
                    } else {
                        cognia_companion::tls_fingerprint()
                    };
                    (base_url, fingerprint, host.app_version())
                }
                Some(_) => {
                    let port = cognia_companion::advertised_port();
                    let base_url = std::env::var("COGNIA_PUBLIC_URL")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| format!("https://127.0.0.1:{port}"));
                    (
                        base_url,
                        cognia_companion::tls_fingerprint(),
                        host.app_version(),
                    )
                }
            };
            let host_id = {
                let secret = state.secret.read();
                cognia_companion::healthz::derive_server_id(&secret)
            };
            to_json(
                crate::command_services::issue_owner_invitation(
                    base_url,
                    fingerprint,
                    app_version,
                    host_id,
                    "host-admin-rpc",
                )
                .await
                .map_err(RpcError::internal)?,
            )
        }

        // ── Server status ──────────────────────────────────────────────────
        "companion_server_status" => {
            {
                if let Some(state) = host.companion_server() {
                    let bind_mode = match state.bind_mode() {
                        Some(cognia_companion::BindMode::Loopback) => "loopback",
                        Some(cognia_companion::BindMode::Lan) => "lan",
                        None => "none",
                    };
                    return to_json(crate::command_services::CompanionServerStatus {
                        running: state.is_running(),
                        bind_mode,
                        bound_port: state.bound_port(),
                    });
                }
            }
            // Headless: the listener this request arrived on is the server,
            // so "running" is by construction, and the binding is whatever
            // the `serve` flags chose.
            let port = cognia_companion::advertised_port();
            to_json(crate::command_services::CompanionServerStatus {
                running: port > 0,
                bind_mode: if port == 0 {
                    "none"
                } else if cognia_companion::bind_loopback_only() {
                    "loopback"
                } else {
                    "lan"
                },
                bound_port: (port > 0).then_some(port),
            })
        }

        // ── Self-update (ADR-0224 A10) ─────────────────────────────────────
        "host_update_status" => {
            Ok(cognia_companion::host_update::status_value_live(env!("CARGO_PKG_VERSION")).await)
        }

        "host_update_refresh" => host_updater(name)?
            .check(true)
            .await
            .map_err(update_refused)
            .and_then(to_json),

        "host_update_configure" => {
            let channel: Option<String> = optional(&args, "channel")?;
            let auto_update: Option<bool> = optional_aliased(&args, "auto_update", "autoUpdate")?;
            host_updater(name)?
                .configure(channel.as_deref(), auto_update, Some(device_id))
                .map_err(|message| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(RpcError::new("invalid_argument", message)),
                    )
                })
                .and_then(to_json)
        }

        "host_update_install" => host_updater(name)?
            .request_install()
            .await
            .map_err(update_refused)
            .and_then(to_json),

        // ── Headless runtimes (ADR-0059 W2) ────────────────────────────────
        "host_runtime_status" => {
            brain_runtimes(
                name,
                cognia_companion::runtime_control::RuntimeControlAction::List,
            )
            .await
        }

        "host_runtime_restart" => {
            let runtime: String = required(&args, "name")?;
            let action = cognia_companion::runtime_control::RuntimeControlAction::restart(&runtime)
                .map_err(runtime_control_error)?;
            log::info!("host_runtime_restart: {runtime} restarted by device {device_id}");
            brain_runtimes(name, action).await
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
        assert!(COMMANDS.contains(&"companion_push_configure_hms"));
        assert!(COMMANDS.contains(&"companion_push_clear_hms"));
        for name in COMMANDS {
            assert!(
                crate::rpc::known_commands().contains(name),
                "{name} is dispatched here but missing from KNOWN_COMMANDS"
            );
            let descriptor = cognia_companion::command_manifest::commands()
                .iter()
                .find(|command| command.name == *name)
                .unwrap_or_else(|| panic!("{name} is not in the command manifest"));
            assert_eq!(
                descriptor.target,
                cognia_companion::command_manifest::CommandTarget::HostAdmin,
                "{name} target"
            );
            assert_eq!(descriptor.capability, "host.admin", "{name} capability");
        }
    }

    /// A desktop has no brain, so the runtime arms say a headless host is
    /// needed rather than timing out; every refusal keeps its own code.
    #[tokio::test]
    async fn runtime_arms_need_a_headless_host_and_keep_the_brains_codes() {
        // No test in this binary installs a headless runtime.
        let err = brain_runtimes(
            "host_runtime_status",
            cognia_companion::runtime_control::RuntimeControlAction::List,
        )
        .await
        .expect_err("no headless runtime in tests");
        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.1 .0.code, "headless_host_required");

        for (code, status) in [
            ("invalid_argument", StatusCode::BAD_REQUEST),
            ("runtime_not_found", StatusCode::NOT_FOUND),
            ("runtime_not_restartable", StatusCode::CONFLICT),
            ("runtimes_stopped", StatusCode::CONFLICT),
            ("brain_unavailable", StatusCode::SERVICE_UNAVAILABLE),
            ("brain_timeout", StatusCode::GATEWAY_TIMEOUT),
            ("runtime_control_failed", StatusCode::BAD_GATEWAY),
        ] {
            let (got, body) =
                runtime_control_error(cognia_companion::runtime_control::RuntimeControlError {
                    code: code.to_string(),
                    message: "m".to_string(),
                });
            assert_eq!(got, status, "{code}");
            assert_eq!(body.0.code, code);
        }
    }

    /// Without a signaling hub installed (the test binary never installs
    /// one) the arms that need it answer 503 with a code a client can act on,
    /// not a panic and not an opaque 500.
    #[test]
    fn signaling_arms_report_a_missing_hub_as_unavailable() {
        let err = hub("companion_signaling_status")
            .err()
            .expect("no hub in tests");
        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.1 .0.code, "signaling_unavailable");
    }

    /// The headless binary publishes the browser plane's bound port through a
    /// process global, which is what the invitation base URL and the
    /// browser-access summary read when there is no desktop server state.
    #[test]
    fn browser_advertised_port_round_trips_through_the_global() {
        cognia_companion::set_browser_advertised_port(27891);
        assert_eq!(cognia_companion::browser_advertised_port(), Some(27891));
        cognia_companion::set_browser_advertised_port(0);
        assert_eq!(cognia_companion::browser_advertised_port(), None);
    }
}
