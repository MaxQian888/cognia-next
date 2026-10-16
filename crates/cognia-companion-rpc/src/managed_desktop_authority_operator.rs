//! Native-only P4 diagnostic of the real Host identity, administrator lease,
//! consent bridge and input pipeline. Never reachable through an RPC command.
//! The isolated operator installs an in-memory paired-device database, restores
//! the unbound context on every exit, and always destroys its paid desktop.
use super::*;
use cognia_companion::security_store::{install_security_store, SecurityStore};
use cognia_companion::{admin_lease, host_consent};
use std::sync::atomic::{AtomicU64, Ordering};

const OPERATION: &str = "managed_desktop_control_input";
const FAILED: &str = "managed_desktop_authority_smoke_failed";

struct IdentityScope {
    device: String,
}
impl Drop for IdentityScope {
    fn drop(&mut self) {
        admin_lease::revoke_device(&self.device);
        host_consent::forget_device(&self.device);
        host_identity::unbind_local_account();
        install_security_store(None);
    }
}
fn check(value: bool) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(refused(FAILED))
    }
}
fn issued_lease(device: &str, tenant: &str, ttl: u64) -> Result<String> {
    let operations = vec![OPERATION.to_owned()];
    let request = host_consent::request(device, Some(tenant), operations.clone());
    host_consent::resolve(&request.id, true, host_consent::Approver::Host)
        .map_err(|_| refused(FAILED))?;
    check(host_consent::take_approved(device, &operations))?;
    let store = security_store().ok_or_else(|| refused(FAILED))?;
    let owner = store
        .is_owner_device(tenant, device)
        .map_err(|_| refused(FAILED))?;
    admin_lease::issue(device, operations, Some(ttl), owner)
        .map(|lease| lease.token)
        .map_err(|_| refused(FAILED))
}
fn admin_check(device: &str, token: &str) -> AdminAuthorityCheck {
    let device = device.to_owned();
    let token = token.to_owned();
    Arc::new(move || {
        admin_lease::validate(&device, OPERATION, Some(&token))
            .map_err(|_| refused("managed_desktop_control_admin_lease_expired"))
    })
}
fn runtime(events: HostEventSink) -> ManagedControlRuntime {
    let gate = cognia_automation::automation::permission::PermissionGate::new(Default::default());
    gate.update(|settings| {
        settings.enabled = true;
        settings.consent_timeout_ms =
            cognia_automation::automation::permission::MIN_CONSENT_TIMEOUT_MS;
        settings.per_surface.computer_use.tier =
            cognia_automation::automation::permission::Tier::PerCall;
    });
    ManagedControlRuntime {
        enforcement: Enforcement {
            gate,
            audit: Default::default(),
            consent: Default::default(),
            policy: Default::default(),
            consent_event_sink: None,
        },
        events,
        refresh_persisted: false,
    }
}
fn approve_event(_: &str, value: Value) {
    if let Some(id) = value["id"].as_str() {
        let _ = host_consent::resolve(id, true, host_consent::Approver::Host);
    }
}
fn input(
    desktop: &ManagedDesktop,
    lease: &ManagedControlLease,
    frame: &ManagedControlFrame,
    compound: bool,
) -> InputArgs {
    InputArgs {
        desktop_id: desktop.id.clone(),
        generation: desktop.generation,
        token: lease.token.clone(),
        fence: lease.fence,
        frame_id: frame.frame_id.clone(),
        point: compound.then_some(Point { x: 20, y: 20 }),
        action: if compound {
            UiAction::Scroll {
                opts: cognia_automation::automation::types::ScrollOpts { dx: 0, dy: 1 },
            }
        } else {
            UiAction::TypeText {
                text: String::from("p4-authority"),
            }
        },
    }
}
// Each independent case receives its own fresh frame budget. Do not silently
// reacquire expired authority: renewal must still pass the live Host gate.
async fn renewed_frame(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    desktop: &ManagedDesktop,
    lease: &ManagedControlLease,
    authority: &HostAuthority<'_>,
    permit: &ExplicitPaidSmokeAuthorization,
) -> Result<(ManagedControlLease, ManagedControlFrame)> {
    let lease = service
        .control_renew_smoke(
            p,
            &desktop.id,
            desktop.generation,
            &lease.token,
            lease.fence,
            authority,
            permit,
        )
        .await?;
    let frame = service
        .control_frame_smoke(p, &desktop.id, desktop.generation, authority, permit)
        .await?;
    Ok((lease, frame))
}
fn diagnostic_error_code(code: &str) -> &str {
    if code.starts_with("managed_desktop_")
        && code.len() <= 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        code
    } else {
        "unexpected_error_code"
    }
}

fn observer(count: &Arc<AtomicU64>) -> Arc<dyn Fn(bool) + Send + Sync> {
    let count = count.clone();
    Arc::new(move |admitted| {
        if admitted {
            count.fetch_add(1, Ordering::SeqCst);
        }
    })
}

/// Fresh private operator processes only. The directory is part of the existing
/// SmokeHost; this routine never opens another Host's account or security data.
pub async fn run(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    _directory: &Path,
    config_id: &str,
    permit: ExplicitPaidSmokeAuthorization,
) -> Result<HostAuthoritySmokeEvidence> {
    p.require_admin()?;
    // Installing this fixture in a live Host would replace real authority state.
    check(security_store().is_none() && host_identity::current().is_err())?;
    let store = SecurityStore::in_memory().map_err(|_| refused(FAILED))?;
    let device = format!("native-authority-{}", uuid::Uuid::new_v4());
    let _identity = IdentityScope {
        device: device.clone(),
    };
    install_security_store(Some(store.clone()));
    let binding = host_identity::bind_local_account_from_operator(&p.owner_principal_id)
        .map_err(|_| refused(FAILED))?;
    let tenant = binding.remote_tenant_id;
    let now = chrono::Utc::now().timestamp();
    let challenge = store
        .issue_challenge(&tenant, now, 600)
        .map_err(|_| refused(FAILED))?;
    store
        .register_oidc_device(
            &tenant,
            "native-operator",
            &challenge.id,
            &challenge.nonce,
            &device,
            "Native smoke device",
            "-----BEGIN PUBLIC KEY-----\nnative-smoke\n-----END PUBLIC KEY-----",
            &format!("native-{device}"),
            "owner",
            now,
        )
        .map_err(|_| refused(FAILED))?;
    let caller = Caller {
        device_id: &device,
        tenant_id: Some(&tenant),
        scope: Some("device"),
        local: false,
    };
    let paired = principal(&caller, &p.host_id)?;
    check(paired.owner_principal_id == p.owner_principal_id && paired.require_admin().is_ok())?;
    let mut evidence = HostAuthoritySmokeEvidence {
        evidence_version: 1,
        paired_owner_resolved: true,
        observed_at: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    };

    let operations = vec![OPERATION.to_owned()];
    let request = host_consent::request(&device, Some(&tenant), operations.clone());
    evidence.self_approval_rejected =
        host_consent::resolve(&request.id, true, host_consent::Approver::Device(&device)).is_err();
    host_consent::resolve(&request.id, true, host_consent::Approver::Host)
        .map_err(|_| refused(FAILED))?;
    evidence.consent_wrong_device_rejected =
        !host_consent::take_approved("wrong-device", &operations);
    evidence.consent_wrong_operation_rejected =
        !host_consent::take_approved(&device, &["wrong-operation".into()]);
    check(host_consent::take_approved(&device, &operations))?;
    evidence.consent_one_shot = !host_consent::take_approved(&device, &operations);
    let short = issued_lease(&device, &tenant, 1)?;
    evidence.admin_wrong_device_rejected =
        admin_lease::validate("wrong-device", OPERATION, Some(&short)).is_err();
    evidence.admin_wrong_operation_rejected =
        admin_lease::validate(&device, "wrong-operation", Some(&short)).is_err();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    evidence.admin_expiry_rejected =
        admin_lease::validate(&device, OPERATION, Some(&short)).is_err();
    let revoked = issued_lease(&device, &tenant, 60)?;
    admin_lease::revoke_device(&device);
    evidence.admin_revocation_rejected =
        admin_lease::validate(&device, OPERATION, Some(&revoked)).is_err();

    check(
        evidence.self_approval_rejected
            && evidence.consent_wrong_device_rejected
            && evidence.consent_wrong_operation_rejected
            && evidence.consent_one_shot
            && evidence.admin_wrong_device_rejected
            && evidence.admin_wrong_operation_rejected
            && evidence.admin_expiry_rejected
            && evidence.admin_revocation_rejected,
    )?;

    let service = host.open(host.provider())?;
    let before = service
        .list(p)
        .await?
        .into_iter()
        .map(|row| row.id)
        .collect::<std::collections::BTreeSet<_>>();
    let diagnostic_started = tokio::time::Instant::now();
    let mut stage = "quote_and_authorization";
    let result: Result<()> = async {
        let quote = service.quote(p, config_id, 120).await?;
        host.approve_quote(&quote, AuthorizationPurpose::Smoke)
            .await?;
        let operation = uuid::Uuid::new_v4().to_string();
        let authorization = service
            .authorize(
                p,
                config_id,
                &quote.id,
                AuthorizationPurpose::Smoke,
                Some(format!("authority:{operation}")),
            )
            .await?;
        stage = "create_and_readiness";
        let mut desktop = service
            .create_smoke(
                p,
                CreateManagedDesktop {
                    provider_config_id: config_id.into(),
                    quote_id: quote.id,
                    authorization_id: authorization.id,
                    idempotency_key: operation,
                },
            )
            .await?;
        evidence.smoke_desktop_id = desktop.id.clone();
        evidence.smoke_desktop_generation = desktop.generation;
        while desktop.state == ManagedDesktopState::Creating {
            check(chrono::Utc::now().timestamp_millis() < desktop.deadline_at)?;
            tokio::time::sleep(Duration::from_secs(2)).await;
            desktop = service.connect(p, &desktop.id, desktop.generation).await?;
        }
        check(desktop.state == ManagedDesktopState::Running)?;
        let token = issued_lease(&device, &tenant, 120)?;
        let positive = Arc::new(AtomicU64::new(0));
        let mut authority = HostAuthority {
            caller,
            host_id: &p.host_id,
            admin_check: Some(admin_check(&device, &token)),
            input_policy: None,
            admission_observer: Some(observer(&positive)),
        };
        stage = "acquire_and_positive_input";
        let lease = service
            .control_acquire_smoke(
                &paired,
                &desktop.id,
                desktop.generation,
                true,
                &authority,
                &permit,
            )
            .await?;
        let frame = service
            .control_frame_smoke(
                &paired,
                &desktop.id,
                desktop.generation,
                &authority,
                &permit,
            )
            .await?;
        execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, false),
            runtime(Arc::new(approve_event)),
            Some(&permit),
        )
        .await?;
        evidence.positive_input_acknowledged = true;
        evidence.positive_admitted_commands = positive.load(Ordering::SeqCst);

        let denied = Arc::new(AtomicU64::new(0));
        authority.admission_observer = Some(observer(&denied));
        stage = "host_denial";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let denial_observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let rejected = denial_observed.clone();
        let denied_result = execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, false),
            runtime(Arc::new(move |_, value| {
                if let Some(id) = value["id"].as_str() {
                    rejected.store(
                        host_consent::resolve(id, false, host_consent::Approver::Host).is_ok(),
                        Ordering::SeqCst,
                    );
                }
            })),
            Some(&permit),
        )
        .await;
        evidence.host_denial_not_delivered = denial_observed.load(Ordering::SeqCst)
            && denied_result
                .is_err_and(|error| error.code == "managed_desktop_control_consent_denied")
            && denied.load(Ordering::SeqCst) == 0;

        stage = "real_consent_timeout";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let prompt_seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = prompt_seen.clone();
        let started = tokio::time::Instant::now();
        let timed_out = execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, false),
            runtime(Arc::new(move |_, _| {
                seen.store(true, Ordering::SeqCst);
            })),
            Some(&permit),
        )
        .await;
        evidence.consent_timeout_ms =
            cognia_automation::automation::permission::MIN_CONSENT_TIMEOUT_MS;
        evidence.consent_timeout_not_delivered = prompt_seen.load(Ordering::SeqCst)
            && started.elapsed() >= Duration::from_millis(evidence.consent_timeout_ms)
            && timed_out.is_err_and(|error| error.code == "managed_desktop_control_consent_denied")
            && denied.load(Ordering::SeqCst) == 0;
        host_consent::forget_device(&device);

        stage = "policy_disabled_during_consent";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let mut disabled_runtime = runtime(Arc::new(|_, _| {}));
        let gate = disabled_runtime.enforcement.gate.clone();
        let policy_prompt_seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = policy_prompt_seen.clone();
        disabled_runtime.events = Arc::new(move |event, value| {
            seen.store(true, Ordering::SeqCst);
            gate.update(|settings| settings.enabled = false);
            approve_event(event, value);
        });
        let policy_denied = execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, false),
            disabled_runtime,
            Some(&permit),
        )
        .await;
        evidence.policy_disabled_while_waiting_not_delivered = policy_prompt_seen
            .load(Ordering::SeqCst)
            && policy_denied
                .is_err_and(|error| error.code == "managed_desktop_control_policy_denied")
            && denied.load(Ordering::SeqCst) == 0;

        stage = "cancelled_consent_and_late_approval";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let pending = Arc::new(parking_lot::Mutex::new(None::<Value>));
        let captured = pending.clone();
        let outcome = tokio::time::timeout(
            Duration::from_millis(250),
            execute_input_inner(
                &service,
                &paired,
                &authority,
                input(&desktop, &lease, &frame, false),
                runtime(Arc::new(move |_, value| {
                    *captured.lock() = Some(value);
                })),
                Some(&permit),
            ),
        )
        .await;
        check(outcome.is_err())?;
        let value = pending.lock().clone().ok_or_else(|| refused(FAILED))?;
        evidence.cancelled_consent_not_delivered = denied.load(Ordering::SeqCst) == 0;
        host_consent::resolve(
            value["id"].as_str().ok_or_else(|| refused(FAILED))?,
            true,
            host_consent::Approver::Host,
        )
        .map_err(|_| refused(FAILED))?;
        // The cancelled bridge is dropped. Its unique consent ID cannot approve
        // the next input, even when desktop/generation/fence are identical.
        let next_pending = Arc::new(parking_lot::Mutex::new(None::<Value>));
        let captured = next_pending.clone();
        let next = tokio::time::timeout(
            Duration::from_millis(250),
            execute_input_inner(
                &service,
                &paired,
                &authority,
                input(&desktop, &lease, &frame, false),
                runtime(Arc::new(move |_, value| {
                    *captured.lock() = Some(value);
                })),
                Some(&permit),
            ),
        )
        .await;
        evidence.late_approval_not_replayed = next.is_err()
            && next_pending
                .lock()
                .as_ref()
                .is_some_and(|next| next["id"] != value["id"])
            && denied.load(Ordering::SeqCst) == 0;
        host_consent::forget_device(&device);

        stage = "admin_revoked_during_consent";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let revoke = device.clone();
        let denied_result = execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, false),
            runtime(Arc::new(move |event, value| {
                admin_lease::revoke_device(&revoke);
                approve_event(event, value);
            })),
            Some(&permit),
        )
        .await;
        evidence.admin_revoked_after_consent_not_delivered = denied_result
            .is_err_and(|error| error.code == "managed_desktop_control_admin_lease_expired")
            && denied.load(Ordering::SeqCst) == 0;
        evidence.denied_admitted_commands = denied.load(Ordering::SeqCst);

        let token = issued_lease(&device, &tenant, 120)?;
        authority.admin_check = Some(admin_check(&device, &token));
        let compound = Arc::new(AtomicU64::new(0));
        let counted = compound.clone();
        let compound_denied = Arc::new(AtomicU64::new(0));
        let denied_command = compound_denied.clone();
        let revoke = device.clone();
        authority.admission_observer = Some(Arc::new(move |admitted| {
            if admitted && counted.fetch_add(1, Ordering::SeqCst) == 0 {
                admin_lease::revoke_device(&revoke);
            }
            if !admitted {
                denied_command.fetch_add(1, Ordering::SeqCst);
            }
        }));
        stage = "compound_admission_revocation";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let result = execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, true),
            runtime(Arc::new(approve_event)),
            Some(&permit),
        )
        .await;
        evidence.compound_admitted_commands = compound.load(Ordering::SeqCst);
        evidence.compound_denied_commands = compound_denied.load(Ordering::SeqCst);
        evidence.compound_revocation_second_send_blocked = result
            .is_err_and(|error| error.code == "managed_desktop_control_quarantined")
            && evidence.compound_admitted_commands == 1
            && evidence.compound_denied_commands == 1;

        let token = issued_lease(&device, &tenant, 120)?;
        authority.admin_check = Some(admin_check(&device, &token));
        authority.admission_observer = None;
        stage = "paired_device_revocation";
        store
            .revoke_device(
                &tenant,
                "native-operator",
                &device,
                true,
                chrono::Utc::now().timestamp(),
            )
            .map_err(|_| refused(FAILED))?;
        evidence.paired_device_revocation_rejected = authority
            .revalidate(&paired)
            .await
            .is_err_and(|error| error.code == "managed_desktop_forbidden")
            && !(authority.input_admission(&paired))();
        stage = "complete_authority_evidence";
        if !evidence.has_complete_evidence() {
            eprintln!("Native authority diagnostic assertions: {evidence:?}");
        }
        check(evidence.has_complete_evidence())
    }
    .await;
    if let Err(error) = &result {
        eprintln!(
            "Native authority smoke failed: stage={stage} code={} elapsed_ms={}",
            diagnostic_error_code(&error.code),
            diagnostic_started.elapsed().as_millis()
        );
    }
    // The exclusively opened private journal cannot admit another operator.
    // Include a row persisted before create returned an error, not only its ID.
    let cleanup: Result<()> = async {
        for row in service
            .list(p)
            .await?
            .into_iter()
            .filter(|row| !before.contains(&row.id))
        {
            let deleted = service.delete(p, &row.id, row.generation).await?;
            check(deleted.state == ManagedDesktopState::Destroyed)?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = &cleanup {
        eprintln!(
            "Native authority smoke failed: stage=cleanup code={} elapsed_ms={}",
            diagnostic_error_code(&error.code),
            diagnostic_started.elapsed().as_millis()
        );
    }
    result?;
    cleanup?;
    Ok(evidence)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_codes_exclude_secrets_and_unbounded_messages() {
        assert_eq!(
            diagnostic_error_code("managed_desktop_control_lease_expired"),
            "managed_desktop_control_lease_expired"
        );
        for code in [
            "token-secret",
            "https://provider.invalid/?key=secret",
            "managed_desktop_failure\nsecret",
        ] {
            assert_eq!(diagnostic_error_code(code), "unexpected_error_code");
        }
        assert_eq!(
            diagnostic_error_code(&format!("managed_desktop_{}", "x".repeat(128))),
            "unexpected_error_code"
        );
    }

    #[test]
    fn native_admission_observation_cannot_turn_denial_into_permission() {
        let count = Arc::new(AtomicU64::new(0));
        let observe = observer(&count);
        observe(false);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        observe(true);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn missing_native_checks_and_nonzero_denied_admission_never_qualify() {
        let mut evidence = HostAuthoritySmokeEvidence::default();
        assert!(!evidence.has_complete_evidence());
        evidence.evidence_version = 1;
        evidence.smoke_desktop_id = "desktop".into();
        evidence.denied_admitted_commands = 1;
        assert!(!evidence.has_complete_evidence());
    }
}
