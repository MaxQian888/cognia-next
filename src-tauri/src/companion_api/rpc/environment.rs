//! Runtime environment RPC arms — the catalog, the approvals and the driver
//! (ADR-0182, ADR-0183).
//!
//! The reads and writes themselves live in
//! [`crate::companion_api::environment_pool`], beside the wire types they
//! answer with. This file is the dispatch face: argument names, the
//! authority question, the audit record, and the refusal shapes.
//!
//! # Who may approve
//!
//! An approval is the act that lets a repository's own image run agents with
//! this tenant's workspaces mounted, so the authority question is not "can
//! this device reach the plane" but "is this person a maintainer of this
//! workspace". [`crate::companion_api::workspace_access`] asks the
//! collaboration server; [`host_owner`] covers the case it cannot see — a
//! single-tenant deployment whose one person is the owner principal.
//!
//! The Host stamps the approver and the timestamp itself. An approval record
//! that took the caller's word for who approved would be an audit trail of
//! claims rather than of decisions.

use cognia_environment::approval::{ApprovalAuthority, ApprovalRequest, EgressGrantRequest};
use cognia_environment::catalog::CatalogEntry;

use super::*;
use crate::companion_api::deployment::{deployment_mode, DeploymentMode};
use crate::companion_api::environment_pool::{self as pool, EnvironmentServiceError, PoolServices};
use crate::companion_api::workspace_access::{may_approve_environment, workspace_access};

pub(super) const COMMANDS: &[&str] = &[
    "environment_catalog_list",
    "environment_catalog_get",
    "environment_catalog_create",
    "environment_catalog_update",
    "environment_catalog_delete",
    "environment_declaration_read",
    "environment_build_start",
    "environment_build_get",
    "environment_build_cancel",
    "environment_ports_list",
    "environment_spec_resolve_preview",
    "environment_approval_list",
    "environment_approval_get",
    "environment_approval_approve",
    "environment_approval_revoke",
    "environment_egress_grant_create",
    "environment_egress_grant_delete",
    "environment_probe_get",
    "environment_driver_status",
    "environment_image_inspect",
];

/// The installed pool, or the refusal that names the switch.
///
/// Every arm goes through this, reads included: an empty catalog and a
/// deployment that never turned the pool on are different facts, and a UI has
/// to be able to say which.
fn services(name: &str) -> Result<PoolServices, (StatusCode, Json<RpcError>)> {
    pool::installed().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(RpcError::new(
                "sandbox_pool_disabled",
                format!(
                    "{name}: runtime environment sandboxes are off on this deployment \
                     (COGNIA_SANDBOX_POOL_ENABLED)"
                ),
            )),
        )
    })
}

fn served(name: &str, error: EnvironmentServiceError) -> (StatusCode, Json<RpcError>) {
    let status = match &error {
        EnvironmentServiceError::Store(_) => StatusCode::SERVICE_UNAVAILABLE,
        EnvironmentServiceError::NotFound { .. } => StatusCode::NOT_FOUND,
        EnvironmentServiceError::Refused { .. } => StatusCode::BAD_REQUEST,
        EnvironmentServiceError::Unreadable(_) => StatusCode::INTERNAL_SERVER_ERROR,
        EnvironmentServiceError::Upstream { .. } => StatusCode::BAD_GATEWAY,
    };
    let body = RpcError::new(error.code().to_string(), format!("{name}: {error}"));
    let body = if error.retryable() {
        body.retryable()
    } else {
        body
    };
    (status, Json(body))
}

/// The Host's own owner principal.
///
/// A single-tenant deployment has exactly one person behind it: pairing is
/// owner-driven and the write arms here additionally require the
/// remote-control capability, so an authenticated caller on such a Host *is*
/// the owner. A multi-tenant Host has no owner principal — several tenants
/// share it, and only the collaboration plane can tell them apart.
fn host_owner() -> bool {
    deployment_mode() != DeploymentMode::MultiTenant
}

/// Who the caller is, as the collaboration plane knows them.
fn acting_person(
    name: &str,
    account_id: Option<&str>,
) -> Result<crate::companion_api::host_identity::HostPerson, (StatusCode, Json<RpcError>)> {
    let unknown = |detail: String| {
        (
            StatusCode::FORBIDDEN,
            Json(RpcError::new(
                "approval_authority_unknown_person",
                format!("{name}: {detail}"),
            )),
        )
    };
    let namespace = match account_id {
        Some(id) if !id.trim().is_empty() => id.trim().to_string(),
        _ => {
            crate::companion_api::host_identity::current()
                .map_err(|error| {
                    unknown(format!(
                        "this host has no account binding to act as: {error}"
                    ))
                })?
                .local_account_namespace
        }
    };
    crate::companion_api::host_identity::person(&namespace)
        .map_err(|error| unknown(format!("no person is recorded for this account: {error}")))
}

/// The user id to stamp on a record. Falls back to the device that asked so
/// an audit row is never anonymous.
fn stamped_actor(name: &str, account_id: Option<&str>, device_id: &str) -> String {
    acting_person(name, account_id)
        .ok()
        .and_then(|person| person.canonical_user_id.or(person.user_id))
        .unwrap_or_else(|| format!("device:{device_id}"))
}

/// Refuse unless the caller may approve for `workspace_id`.
///
/// On a multi-tenant Host this is a round trip to the collaboration plane, and
/// every way it can fail is a refusal — never an assumption of access. The
/// codes come from [`crate::companion_api::workspace_access`] so a UI can tell
/// "you are not a maintainer" from "the plane is down".
pub(crate) async fn require_approval_authority(
    name: &str,
    workspace_id: &str,
    account_id: Option<&str>,
) -> Result<ApprovalAuthority, (StatusCode, Json<RpcError>)> {
    require_environment_authority(name, workspace_id, account_id, true).await
}

async fn require_environment_authority(
    name: &str,
    workspace_id: &str,
    account_id: Option<&str>,
    manage: bool,
) -> Result<ApprovalAuthority, (StatusCode, Json<RpcError>)> {
    if host_owner() {
        return Ok(ApprovalAuthority::HostOwner);
    }
    let person = acting_person(name, account_id)?;
    let (org_id, user_id) = match (
        person.canonical_org_id.or(person.org_id),
        person.canonical_user_id.or(person.user_id),
    ) {
        (Some(org), Some(user)) => (org, user),
        _ => {
            return Err((
                StatusCode::FORBIDDEN,
                Json(RpcError::new(
                    "approval_authority_unknown_person",
                    format!(
                        "{name}: this account is not signed in to a collaboration \
                         organization, so no approval authority can be established"
                    ),
                )),
            ))
        }
    };
    let access = workspace_access(&org_id, workspace_id, &user_id)
        .await
        .map_err(|error| {
            (
                StatusCode::FORBIDDEN,
                Json(RpcError::new(error.code(), format!("{name}: {error}"))),
            )
        })?;
    if !(may_approve_environment(access.as_ref(), false)
        || (!manage
            && access.as_ref().is_some_and(|access| {
                access.allows(cognia_tenant_auth::WorkspaceCapability::Read)
            })))
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(RpcError::new(
                "approval_authority_insufficient",
                format!("{name}: approving a runtime environment needs workspace management"),
            )),
        ));
    }
    Ok(ApprovalAuthority::WorkspaceMaintainer)
}

/// The canonical form of the remote an approval is keyed on.
///
/// The Host states it, like it states the approver and the moment: an
/// approval is looked up by `(project, normalizedRemote, path)`, and a client
/// that sent `git@github.com:acme/app.git` where another sent
/// `https://github.com/acme/app` would record an approval no run could find.
/// Idempotent, so an already-canonical value is left as it is. Empty stays
/// empty: a checkout with no remote has no remote identity, and the approval
/// is then keyed on the project and path alone.
fn canonical_remote(name: &str, raw: &str) -> Result<String, (StatusCode, Json<RpcError>)> {
    if raw.trim().is_empty() {
        return Ok(String::new());
    }
    cognia_git_mirror::normalize_remote_url(raw).map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            Json(RpcError::new(
                "environment_remote_invalid",
                format!("{name}: {error}"),
            )),
        )
    })
}

fn unix_time_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
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
    let _ = state;
    let services = services(name)?;

    match name {
        // ── Catalog ────────────────────────────────────────────────────────
        "environment_catalog_list" => {
            let request = page_request(&args)?;
            to_json(pool::catalog_page(&services, &request).map_err(|e| served(name, e))?)
        }

        "environment_catalog_get" => {
            let id: String = required(&args, "id")?;
            let catalog = pool::effective_catalog(&services).map_err(|e| served(name, e))?;
            to_json(
                pool::catalog_views(&catalog)
                    .into_iter()
                    .find(|view| view.entry.id == id),
            )
        }

        "environment_catalog_create" | "environment_catalog_update" => {
            let entry: CatalogEntry = required(&args, "entry")?;
            let updating = name.ends_with("update");
            let written = pool::write_catalog_entry(&services, entry, updating, unix_time_secs())
                .map_err(|e| served(name, e))?;
            super::super::audit::record_async(
                "environment_catalog_write",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({
                    "command": name,
                    "entry_id": written.id,
                    "image": written.image.name(),
                    "isolation_floor": written.isolation_floor.as_str(),
                }),
            )
            .await;
            to_json(written)
        }

        "environment_catalog_delete" => {
            let id: String = required(&args, "id")?;
            let revoked = services
                .admission
                .with_store(|store| store.revoke_tenant_entry(&id, unix_time_secs()))
                .map_err(|error| served(name, error.into()))?;
            super::super::audit::record_async(
                "environment_catalog_write",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({ "command": name, "entry_id": id }),
            )
            .await;
            to_json(revoked)
        }

        // ── What a repository declares ─────────────────────────────────────
        "environment_declaration_read" => {
            let requested: String = required(&args, "workspaceRoot")?;
            let root = authorize_workspace_root(host, requested)?;
            to_json(pool::read_declaration(&root).map_err(|e| served(name, e))?)
        }

        "environment_build_start" => {
            let mut request: pool::BuildRequest = required(&args, "request")?;
            require_approval_authority(name, &request.project_id, account_id).await?;
            request.cwd =
                authorize_workspace_root(host, request.cwd.to_string_lossy().into_owned())?.into();
            to_json(pool::start_build(&services, request).map_err(|error| served(name, error))?)
        }
        "environment_build_get" => {
            let project_id: String = required(&args, "projectId")?;
            require_environment_authority(name, &project_id, account_id, false).await?;
            let job_id: Option<String> = optional(&args, "jobId")?;
            let build_key: Option<String> = optional(&args, "buildKey")?;
            to_json(
                pool::get_build(
                    &services,
                    &project_id,
                    job_id.as_deref(),
                    build_key.as_deref(),
                )
                .map_err(|error| served(name, error))?,
            )
        }
        "environment_build_cancel" => {
            let project_id: String = required(&args, "projectId")?;
            require_approval_authority(name, &project_id, account_id).await?;
            let job_id: String = required(&args, "jobId")?;
            to_json(pool::cancel_build(&project_id, &job_id).map_err(|error| served(name, error))?)
        }
        "environment_ports_list" => {
            let project_id: String = required(&args, "projectId")?;
            require_approval_authority(name, &project_id, account_id).await?;
            let runtime = services.runtime.as_ref().ok_or_else(|| {
                served(
                    name,
                    EnvironmentServiceError::Refused {
                        code: "sandbox_runtime_unavailable".into(),
                        message: "sandbox runtime control is unavailable".into(),
                    },
                )
            })?;
            let ports = runtime.list_ports(&project_id).await.map_err(|error| {
                served(
                    name,
                    EnvironmentServiceError::Refused {
                        code: error.code.into(),
                        message: error.message,
                    },
                )
            })?;
            Ok(serde_json::json!({"ports":ports}))
        }

        // ── A dry run of admission ─────────────────────────────────────────
        "environment_spec_resolve_preview" => {
            let spec: Value = required(&args, "spec")?;
            let tiers = services
                .status
                .available_tiers()
                .await
                .unwrap_or_else(|_| Vec::new());
            to_json(pool::preview_spec(&services, &spec, tiers))
        }

        // ── Approvals ──────────────────────────────────────────────────────
        "environment_approval_list" => {
            let request = page_request(&args)?;
            let project_id: Option<String> = optional(&args, "projectId")?;
            let include_revoked: bool = optional(&args, "includeRevoked")?.unwrap_or(false);
            to_json(
                pool::approval_page(&services, project_id.as_deref(), include_revoked, &request)
                    .map_err(|e| served(name, e))?,
            )
        }

        "environment_approval_get" => {
            let id: String = required(&args, "id")?;
            to_json(
                services
                    .admission
                    .with_store(|store| store.get_approval(&id))
                    .map_err(|error| served(name, error.into()))?,
            )
        }

        "environment_approval_approve" => {
            let mut request: ApprovalRequest = required(&args, "approval")?;
            request.normalized_remote = canonical_remote(name, &request.normalized_remote)?;
            let via = require_approval_authority(name, &request.project_id, account_id).await?;
            let record = request.into_record(
                stamped_actor(name, account_id, device_id),
                via,
                unix_time_secs(),
            );
            services
                .admission
                .with_store(|store| store.record_approval(&record))
                .map_err(|error| served(name, error.into()))?;
            super::super::audit::record_async(
                "environment_approval",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({
                    "command": name,
                    "approval_id": record.id,
                    "project_id": record.project_id,
                    "declaration_digest": record.declaration_digest,
                    "runtime_fields_digest": record.runtime_fields_digest,
                    "via": via,
                    "approver": record.approver_user_id,
                }),
            )
            .await;
            to_json(record)
        }

        "environment_approval_revoke" => {
            let id: String = required(&args, "id")?;
            let existing = services
                .admission
                .with_store(|store| store.get_approval(&id))
                .map_err(|error| served(name, error.into()))?
                .ok_or_else(|| {
                    served(
                        name,
                        EnvironmentServiceError::NotFound {
                            what: "approval",
                            id: id.clone(),
                        },
                    )
                })?;
            require_approval_authority(name, &existing.project_id, account_id).await?;
            let revoked_by = stamped_actor(name, account_id, device_id);
            let record = services
                .admission
                .with_store(|store| store.revoke_approval(&id, &revoked_by, unix_time_secs()))
                .map_err(|error| served(name, error.into()))?;
            super::super::audit::record_async(
                "environment_approval",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({
                    "command": name,
                    "approval_id": id,
                    "project_id": record.project_id,
                    "revoked_by": revoked_by,
                }),
            )
            .await;
            to_json(record)
        }

        // ── Egress grants ──────────────────────────────────────────────────
        "environment_egress_grant_create" => {
            let request: EgressGrantRequest = required(&args, "grant")?;
            require_approval_authority(name, &request.project_id, account_id).await?;
            let grant =
                request.into_grant(stamped_actor(name, account_id, device_id), unix_time_secs());
            services
                .admission
                .with_store(|store| store.record_egress_grant(&grant))
                .map_err(|error| served(name, error.into()))?;
            super::super::audit::record_async(
                "environment_egress_grant",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({
                    "command": name,
                    "grant_id": grant.id,
                    "project_id": grant.project_id,
                    "tier": grant.tier,
                    "domains": grant.domains,
                }),
            )
            .await;
            to_json(grant)
        }

        "environment_egress_grant_delete" => {
            let id: String = required(&args, "id")?;
            // Read the grant before revoking it: the authority question is
            // about its project, and a revoke that ran first would have
            // already acted by the time the caller was refused.
            let existing = services
                .admission
                .with_store(|store| store.get_egress_grant(&id))
                .map_err(|error| served(name, error.into()))?
                .ok_or_else(|| {
                    served(
                        name,
                        EnvironmentServiceError::NotFound {
                            what: "egress grant",
                            id: id.clone(),
                        },
                    )
                })?;
            require_approval_authority(name, &existing.project_id, account_id).await?;
            let grant = services
                .admission
                .with_store(|store| store.revoke_egress_grant(&id, unix_time_secs()))
                .map_err(|error| served(name, error.into()))?;
            super::super::audit::record_async(
                "environment_egress_grant",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({
                    "command": name,
                    "grant_id": id,
                    "project_id": grant.project_id,
                }),
            )
            .await;
            to_json(grant)
        }

        // ── The probe cache and the driver ─────────────────────────────────
        "environment_probe_get" => {
            let image: String = required(&args, "userImageDigest")?;
            let bundle: String = required(&args, "bundleDigest")?;
            to_json(pool::probe_cache(&services, &image, &bundle))
        }

        "environment_driver_status" => to_json(pool::driver_status(&services).await),

        // ── What an image reference is ─────────────────────────────────────
        "environment_image_inspect" => {
            let reference: String = required(&args, "reference")?;
            // Read per call: an operator rotating the auth file must not need
            // a restart, and a missing or malformed file is an answer about
            // this request rather than a boot failure.
            let credentials =
                cognia_environment::registry::RegistryCredentials::from_lookup(|name| {
                    std::env::var(name).ok()
                })
                .map_err(|error| {
                    served(
                        name,
                        EnvironmentServiceError::Refused {
                            code: error.code().to_string(),
                            message: error.to_string(),
                        },
                    )
                })?;
            to_json(
                pool::inspect_image(
                    &services,
                    &reference,
                    cognia_environment::registry::http::ReqwestTransport::default(),
                    credentials,
                )
                .await
                .map_err(|e| served(name, e))?,
            )
        }

        other => Err(RpcError::unknown_command(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two spellings of one repository must key one approval, or a run looks
    /// up the approval under a form it was never recorded under.
    #[test]
    fn the_host_states_the_canonical_remote_an_approval_is_keyed_on() {
        let scp = canonical_remote("t", "git@github.com:Acme/app.git").expect("scp form");
        let https = canonical_remote("t", "https://token@GitHub.com/Acme/app").expect("https");
        assert_eq!(scp, https);
        assert_eq!(scp, "github.com/Acme/app");
        // Idempotent: what the Host already stored survives a second pass.
        assert_eq!(canonical_remote("t", &scp).expect("canonical"), scp);
        // No remote is not an error; a local-only checkout has none.
        assert_eq!(canonical_remote("t", "  ").expect("empty"), "");
        let (status, body) = canonical_remote("t", "ftp://example.com/x").expect_err("bad scheme");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body.0.code, "environment_remote_invalid");
    }

    /// `expect_err` needs `Debug` on the success type, and the installed
    /// services hold two trait objects.
    fn refusal(
        result: Result<PoolServices, (StatusCode, Json<RpcError>)>,
        expectation: &str,
    ) -> (StatusCode, Json<RpcError>) {
        match result {
            Ok(_) => panic!("{expectation}"),
            Err(error) => error,
        }
    }

    #[test]
    fn command_family_is_non_empty_and_unique() {
        let unique: std::collections::HashSet<_> = COMMANDS.iter().copied().collect();
        assert_eq!(unique.len(), COMMANDS.len());
        assert!(!COMMANDS.is_empty());
    }

    /// Every command in the family refuses with the switch when the pool is
    /// off — the reads too, so a deployment that never opted in never looks
    /// like one with an empty catalog.
    #[test]
    fn every_command_refuses_with_the_switch_when_the_pool_is_off() {
        crate::companion_api::environment_pool::uninstall();
        for command in COMMANDS {
            let (status, body) = refusal(services(command), "the pool is off");
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{command}");
            assert_eq!(body.code, "sandbox_pool_disabled", "{command}");
            assert!(
                body.message.contains("COGNIA_SANDBOX_POOL_ENABLED"),
                "{command}"
            );
        }
    }

    /// A store fault is the one retryable refusal here: repeating a read
    /// against a database that was busy can work, and repeating a rejected
    /// entry cannot.
    #[test]
    fn only_a_store_fault_is_reported_as_retryable() {
        let (status, body) = served("t", EnvironmentServiceError::Store("locked".into()));
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(body.retryable);
        assert_eq!(body.code, "environment_store_unavailable");

        let (status, body) = served(
            "t",
            EnvironmentServiceError::Refused {
                code: "catalog_registry_not_allowlisted".into(),
                message: "nope".into(),
            },
        );
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!body.retryable);
        assert_eq!(body.code, "catalog_registry_not_allowlisted");

        let (status, _) = served(
            "t",
            EnvironmentServiceError::NotFound {
                what: "approval",
                id: "a1".into(),
            },
        );
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
