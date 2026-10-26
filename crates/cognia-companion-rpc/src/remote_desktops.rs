//! Authenticated routing for the Host's remote desktop commands (ADR-0234
//! Phase 3). Caller identity comes from the authenticated envelope, never the
//! arguments.
//!
//! The execution core has already checked the manifest capability and, for
//! the `interactive` commands, the host admin lease. This layer adds what the
//! manifest cannot say:
//!
//! * agents never drive external machines: the `service` scope and devices
//!   enrolled as workers are refused;
//! * a session open is a control request unless it literally asks for `view`,
//!   and a control request needs a host admin lease like the other admin
//!   operations;
//! * the device becomes a [`Principal`](cognia_remote_desktop::session::Principal)
//!   whose admission (pairing, worker status, the mode's capability) every
//!   session re-reads once a second.

use cognia_companion::{admin_lease, ws_remote_desktop::device_principal};
use cognia_remote_desktop::{
    commands::{self, installed, requires_admin},
    error::RemoteDesktopError,
    session::SessionMode,
};
use serde_json::Value;

pub use cognia_remote_desktop::commands::COMMANDS;

#[derive(Clone, Copy)]
pub struct Caller<'a> {
    pub device_id: &'a str,
    pub tenant_id: Option<&'a str>,
    pub scope: Option<&'a str>,
}

/// Lease checks, injectable so tests need no live admin lease table.
pub type LeaseCheck<'a> = &'a (dyn Fn(&str, &str, Option<&str>) -> bool + Send + Sync);
/// Device admission, injectable so tests need no pairing store.
pub type Admission<'a> = &'a (dyn Fn(&str, SessionMode) -> bool + Send + Sync);

/// Run one remote desktop command for a paired device.
pub async fn dispatch(name: &str, args: Value, caller: Caller<'_>) -> Result<Value, RemoteDesktopError> {
    let state = installed()?;
    let principal = device_principal(caller.tenant_id.map(str::to_owned), caller.device_id);
    dispatch_with(
        &state,
        name,
        args,
        caller,
        &|device, operation, token| admin_lease::validate(device, operation, token).is_ok(),
        &|_, mode| principal.admitted(mode),
        principal.clone(),
    )
    .await
}

async fn dispatch_with(
    state: &commands::RemoteDesktopState,
    name: &str,
    mut args: Value,
    caller: Caller<'_>,
    lease_valid: LeaseCheck<'_>,
    admitted: Admission<'_>,
    principal: cognia_remote_desktop::session::Principal,
) -> Result<Value, RemoteDesktopError> {
    if !COMMANDS.contains(&name) {
        return Err(RemoteDesktopError::new("remote_desktop_unknown_command"));
    }
    if cognia_companion::jwt::is_service_scope(caller.scope) {
        return Err(RemoteDesktopError::new("remote_desktop_forbidden"));
    }
    let lease = args.as_object_mut().and_then(|object| {
        let lease = object
            .remove("adminLease")
            .or_else(|| object.remove("admin_lease"));
        lease.and_then(|value| value.as_str().map(str::to_owned))
    });
    let admin = requires_admin(name, &args);
    if !admitted(
        caller.device_id,
        if admin {
            SessionMode::Control
        } else {
            SessionMode::View
        },
    ) {
        return Err(RemoteDesktopError::new("remote_desktop_forbidden"));
    }
    if admin && !lease_valid(caller.device_id, name, lease.as_deref()) {
        return Err(RemoteDesktopError::new("remote_desktop_admin_lease_required"));
    }
    commands::dispatch(state, &principal, name, args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_remote_desktop::{commands::RemoteDesktopState, session::Principal};
    use serde_json::json;
    use std::sync::Arc;

    fn device() -> Caller<'static> {
        Caller {
            device_id: "phone",
            tenant_id: Some("tenant"),
            scope: Some("device"),
        }
    }

    fn principal() -> Principal {
        Principal::device("phone", Arc::new(|_| true))
    }

    async fn run(
        state: &RemoteDesktopState,
        name: &str,
        args: Value,
        caller: Caller<'_>,
        lease_ok: bool,
        admitted: Admission<'_>,
    ) -> Result<Value, &'static str> {
        dispatch_with(state, name, args, caller, &|_, _, _| lease_ok, admitted, principal())
            .await
            .map_err(|error| error.code)
    }

    #[tokio::test]
    async fn agents_never_reach_remote_desktops() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteDesktopState::open(dir.path());
        let service = Caller {
            scope: Some("service"),
            ..device()
        };
        assert_eq!(
            run(&state, "remote_desktop_target_list", json!({}), service, true, &|_, _| true).await,
            Err("remote_desktop_forbidden")
        );
        // A worker device fails admission whatever it asks for.
        assert_eq!(
            run(&state, "remote_desktop_target_list", json!({}), device(), true, &|_, _| false).await,
            Err("remote_desktop_forbidden")
        );
    }

    #[tokio::test]
    async fn viewing_is_the_baseline_and_control_needs_the_admin_grant_and_lease() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteDesktopState::open(dir.path());
        let observer: Admission = &|_, mode| mode == SessionMode::View;
        assert_eq!(
            run(&state, "remote_desktop_target_list", json!({}), device(), false, observer).await,
            Ok(json!({"items": []}))
        );
        // A control open asks for the admin grant before anything else.
        assert_eq!(
            run(
                &state,
                "remote_desktop_session_open",
                json!({"targetId": "t", "bindingId": "b", "mode": "control"}),
                device(),
                true,
                observer
            )
            .await,
            Err("remote_desktop_forbidden")
        );
        // With the grant but without a lease it is refused by name.
        assert_eq!(
            run(
                &state,
                "remote_desktop_session_open",
                json!({"targetId": "t", "bindingId": "b", "mode": "control", "adminLease": "stale"}),
                device(),
                false,
                &|_, _| true
            )
            .await,
            Err("remote_desktop_admin_lease_required")
        );
        // A view open needs neither, and reaches the Host.
        assert_eq!(
            run(
                &state,
                "remote_desktop_session_open",
                json!({"targetId": "t", "bindingId": "b", "mode": "view"}),
                device(),
                false,
                observer
            )
            .await,
            Err("remote_desktop_binding_not_found")
        );
        assert_eq!(
            run(&state, "remote_desktop_target_delete", json!({"targetId": "t"}), device(), false, &|_, _| true)
                .await,
            Err("remote_desktop_admin_lease_required")
        );
    }

    #[tokio::test]
    async fn launching_a_console_or_app_needs_the_admin_grant_and_lease() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteDesktopState::open(dir.path());
        let args = json!({"targetId": "t", "bindingId": "b"});
        let observer: Admission = &|_, mode| mode == SessionMode::View;
        assert_eq!(
            run(&state, "remote_desktop_binding_launch", args.clone(), device(), true, observer).await,
            Err("remote_desktop_forbidden")
        );
        assert_eq!(
            run(&state, "remote_desktop_binding_launch", args.clone(), device(), false, &|_, _| true).await,
            Err("remote_desktop_admin_lease_required")
        );
        assert_eq!(
            run(
                &state,
                "remote_desktop_binding_launch",
                json!({"targetId": "t", "bindingId": "b", "adminLease": "lease"}),
                device(),
                true,
                &|_, _| true
            )
            .await,
            Err("remote_desktop_binding_not_found")
        );
    }

    #[tokio::test]
    async fn the_lease_is_stripped_before_the_typed_arguments_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteDesktopState::open(dir.path());
        let seen = std::sync::Mutex::new(None);
        let result = dispatch_with(
            &state,
            "remote_desktop_target_delete",
            json!({"targetId": "missing", "adminLease": "lease-1"}),
            device(),
            &|device, operation, token| {
                *seen.lock().unwrap() = Some((device.to_owned(), operation.to_owned(), token.map(str::to_owned)));
                true
            },
            &|_, _| true,
            principal(),
        )
        .await;
        // Deleting a missing target is a no-op; the lease never reached the DTO.
        assert_eq!(result.unwrap(), Value::Null);
        assert_eq!(
            seen.lock().unwrap().clone(),
            Some((
                "phone".to_owned(),
                "remote_desktop_target_delete".to_owned(),
                Some("lease-1".to_owned())
            ))
        );
        assert_eq!(
            run(&state, "remote_desktop_secret_read", json!({}), device(), true, &|_, _| true).await,
            Err("remote_desktop_unknown_command")
        );
    }
}
