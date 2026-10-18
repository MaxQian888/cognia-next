//! The command surface (ADR-0234 Phases 2 and 3).
//!
//! Every caller goes through [`dispatch`]: the desktop renderer through
//! `remote_desktop_local_call` (behind `tauri-host`) as the local owner, and a
//! paired device through the Companion dispatcher with a
//! [`Principal::device`] built from its authenticated envelope. Arguments are
//! typed DTOs that reject unknown fields and never carry identity. Errors
//! cross the wire as the `remote_desktop_*` code, optionally followed by
//! `: detail`.
//!
//! The Host is installed once per process ([`install`]): the desktop app and
//! `cognia-server` both do, so the Companion socket and datachannel adapters
//! reach the same broker the commands use.

use crate::{
    credentials::CredentialKind,
    error::{RemoteDesktopError, Result},
    host::{ProbeRequest, RemoteDesktopHost},
    session::{Principal, SessionMode},
    target::TargetDraft,
};
use parking_lot::RwLock;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::{path::Path, sync::Arc};

pub const COMMANDS: &[&str] = &[
    "remote_desktop_target_list",
    "remote_desktop_target_save",
    "remote_desktop_target_delete",
    "remote_desktop_credential_set",
    "remote_desktop_target_probe",
    "remote_desktop_session_open",
    "remote_desktop_session_renew",
    "remote_desktop_session_close",
];

/// Whether a paired device needs `host.admin` and a host admin lease
/// (ADR-0153) for this call: anything that changes what the Host can reach,
/// connects to an endpoint, or takes control. A session open is a control
/// request unless it literally asks for `view`, the way
/// `payload_capability` reads it.
pub fn requires_admin(name: &str, args: &Value) -> bool {
    match name {
        "remote_desktop_target_save"
        | "remote_desktop_target_delete"
        | "remote_desktop_credential_set"
        | "remote_desktop_target_probe" => true,
        "remote_desktop_session_open" => args.get("mode").and_then(Value::as_str) != Some("view"),
        _ => false,
    }
}

/// The Host, or why there is none. A store that cannot be opened (corrupt
/// file, newer version) leaves the app running and every command refusing
/// with why.
pub struct RemoteDesktopState(std::result::Result<RemoteDesktopHost, RemoteDesktopError>);

impl RemoteDesktopState {
    pub fn open(root: &Path) -> Self {
        let host = RemoteDesktopHost::open(root);
        if let Err(error) = &host {
            log::error!("remote desktop store unavailable: {error}");
        }
        Self(host)
    }

    /// No data directory to keep targets in.
    pub fn unavailable() -> Self {
        Self(Err(RemoteDesktopError::new("remote_desktop_storage_unavailable")))
    }

    pub fn from_host(host: RemoteDesktopHost) -> Self {
        Self(Ok(host))
    }

    pub fn host(&self) -> Result<&RemoteDesktopHost> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

static INSTALLED: RwLock<Option<Arc<RemoteDesktopState>>> = RwLock::new(None);

/// Install the process's Host. A later install replaces it (tests only).
pub fn install(state: RemoteDesktopState) {
    *INSTALLED.write() = Some(Arc::new(state));
}

/// The installed Host state; `remote_desktop_host_unavailable` before
/// startup installed one.
pub fn installed() -> Result<Arc<RemoteDesktopState>> {
    INSTALLED
        .read()
        .clone()
        .ok_or_else(|| RemoteDesktopError::new("remote_desktop_host_unavailable"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListArgs {
    #[serde(default)]
    page_size: Option<u32>,
    #[serde(default)]
    page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveArgs {
    draft: TargetDraft,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetArgs {
    target_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialArgs {
    target_id: String,
    binding_id: String,
    kind: CredentialKind,
    #[serde(default)]
    value: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeArgs {
    request: ProbeRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenArgs {
    target_id: String,
    binding_id: String,
    mode: SessionMode,
    #[serde(default)]
    takeover: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionArgs {
    session_id: String,
}

fn parse<T: DeserializeOwned>(args: Value) -> Result<T> {
    serde_json::from_value(args)
        .map_err(|error| RemoteDesktopError::with_detail("remote_desktop_invalid_request", error.to_string()))
}

fn reply<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| RemoteDesktopError::new("remote_desktop_internal"))
}

/// Run one command for `principal` against `state`.
pub async fn dispatch(state: &RemoteDesktopState, principal: &Principal, name: &str, args: Value) -> Result<Value> {
    if !COMMANDS.contains(&name) {
        return Err(RemoteDesktopError::new("remote_desktop_unknown_command"));
    }
    let args = if args.is_null() {
        Value::Object(Default::default())
    } else {
        args
    };
    let host = state.host()?;
    match name {
        "remote_desktop_target_list" => {
            let args: ListArgs = parse(args)?;
            reply(host.list_targets(args.page_size, args.page_token.as_deref()).await?)
        }
        "remote_desktop_target_save" => {
            let args: SaveArgs = parse(args)?;
            reply(host.save_target(principal, args.draft).await?)
        }
        "remote_desktop_target_delete" => {
            let args: TargetArgs = parse(args)?;
            host.delete_target(principal, &args.target_id).await?;
            Ok(Value::Null)
        }
        "remote_desktop_credential_set" => {
            let args: CredentialArgs = parse(args)?;
            reply(
                host.set_credential(principal, &args.target_id, &args.binding_id, args.kind, args.value)
                    .await?,
            )
        }
        "remote_desktop_target_probe" => {
            let args: ProbeArgs = parse(args)?;
            reply(host.probe(args.request).await?)
        }
        "remote_desktop_session_open" => {
            let args: OpenArgs = parse(args)?;
            reply(
                host.open_session(principal, &args.target_id, &args.binding_id, args.mode, args.takeover)
                    .await?,
            )
        }
        "remote_desktop_session_renew" => {
            let args: SessionArgs = parse(args)?;
            reply(host.renew_session(principal, &args.session_id)?)
        }
        "remote_desktop_session_close" => {
            let args: SessionArgs = parse(args)?;
            host.close_session(principal, &args.session_id);
            Ok(Value::Null)
        }
        _ => Err(RemoteDesktopError::new("remote_desktop_unknown_command")),
    }
}

#[cfg(feature = "tauri-host")]
mod shells {
    use super::*;

    /// The desktop renderer's door: the local owner, no admin lease (the
    /// owner is at the machine).
    #[tauri::command]
    pub async fn remote_desktop_local_call(
        name: String,
        args: Option<Value>,
    ) -> std::result::Result<Value, String> {
        let state = installed().map_err(|error| error.to_string())?;
        dispatch(&state, &Principal::local(), &name, args.unwrap_or(Value::Null))
            .await
            .map_err(|error| error.to_string())
    }
}

#[cfg(feature = "tauri-host")]
pub use shells::*;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn call(state: &RemoteDesktopState, name: &str, args: Value) -> std::result::Result<Value, String> {
        dispatch(state, &Principal::local(), name, args)
            .await
            .map_err(|error| error.to_string())
    }

    #[tokio::test]
    async fn an_unreadable_store_refuses_every_command_with_its_code() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(crate::target::STORE_FILE), b"{not json").unwrap();
        let state = RemoteDesktopState::open(dir.path());
        assert_eq!(
            call(&state, "remote_desktop_target_list", json!({})).await.unwrap_err(),
            "remote_desktop_storage_corrupt"
        );
        assert_eq!(
            call(&state, "remote_desktop_session_renew", json!({"sessionId": "s"}))
                .await
                .unwrap_err(),
            "remote_desktop_storage_corrupt"
        );
        assert_eq!(
            call(
                &RemoteDesktopState::unavailable(),
                "remote_desktop_target_delete",
                json!({"targetId": "t"})
            )
            .await
            .unwrap_err(),
            "remote_desktop_storage_unavailable"
        );
    }

    #[tokio::test]
    async fn a_healthy_store_answers_through_the_wire_shape() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteDesktopState::open(dir.path());
        assert_eq!(
            call(&state, "remote_desktop_target_list", json!({"pageSize": 10})).await.unwrap(),
            json!({"items": []})
        );
        // A null body reads as no arguments.
        assert_eq!(
            call(&state, "remote_desktop_target_list", Value::Null).await.unwrap(),
            json!({"items": []})
        );
        assert_eq!(
            call(&state, "remote_desktop_session_renew", json!({"sessionId": "missing"}))
                .await
                .unwrap_err(),
            "remote_desktop_session_not_found"
        );
        assert_eq!(
            call(&state, "remote_desktop_session_close", json!({"sessionId": "missing"}))
                .await
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            call(&state, "remote_desktop_target_delete", json!({"targetId": "missing"}))
                .await
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            call(
                &state,
                "remote_desktop_target_probe",
                json!({"request": {"kind": "draft", "host": "127.0.0.1", "port": 5900, "adapter": "vnc"}})
            )
            .await
            .unwrap_err(),
            "remote_desktop_endpoint_forbidden"
        );
    }

    #[tokio::test]
    async fn arguments_are_typed_and_never_carry_identity() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteDesktopState::open(dir.path());
        let error = call(
            &state,
            "remote_desktop_session_renew",
            json!({"sessionId": "s", "principal": "local-owner"}),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("remote_desktop_invalid_request: "), "{error}");
        assert!(call(&state, "remote_desktop_session_open", json!({"targetId": "t"}))
            .await
            .unwrap_err()
            .starts_with("remote_desktop_invalid_request"));
        assert_eq!(
            call(&state, "remote_desktop_secret_read", json!({})).await.unwrap_err(),
            "remote_desktop_unknown_command"
        );
    }

    #[test]
    fn admin_operations_are_named_and_session_opens_escalate_unless_view() {
        for name in [
            "remote_desktop_target_save",
            "remote_desktop_target_delete",
            "remote_desktop_credential_set",
            "remote_desktop_target_probe",
        ] {
            assert!(requires_admin(name, &json!({})), "{name}");
        }
        for name in [
            "remote_desktop_target_list",
            "remote_desktop_session_renew",
            "remote_desktop_session_close",
        ] {
            assert!(!requires_admin(name, &json!({})), "{name}");
        }
        assert!(!requires_admin("remote_desktop_session_open", &json!({"mode": "view"})));
        for args in [json!({"mode": "control"}), json!({}), json!({"mode": "VIEW"})] {
            assert!(requires_admin("remote_desktop_session_open", &args), "{args}");
        }
        assert_eq!(COMMANDS.len(), 8);
    }

    #[test]
    fn the_installed_host_is_process_wide() {
        // The only test that installs: the global is shared by the binary.
        let dir = tempfile::tempdir().unwrap();
        install(RemoteDesktopState::open(dir.path()));
        assert!(installed().unwrap().host().is_ok());
        install(RemoteDesktopState::unavailable());
        assert_eq!(
            installed().unwrap().host().err().map(|error| error.code),
            Some("remote_desktop_storage_unavailable")
        );
    }
}
