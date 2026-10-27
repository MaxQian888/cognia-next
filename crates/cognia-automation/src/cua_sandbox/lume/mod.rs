//! Lume local Host integration. Separate from Docker because VM ownership,
//! SSH trust and boot epochs have different recovery semantics.
pub mod cli;
pub mod contracts;
pub mod driver;
pub mod journal;
pub mod service;
mod workspace;

use contracts::*;
use serde::Deserialize;

pub(crate) fn validate_transfer_reference(
    encoded: &str,
    reference: &ResourceRef,
) -> Result<(), String> {
    if encoded
        != format!(
            "lume:{}:{}:{}",
            reference.resource_id, reference.generation, reference.boot_epoch
        )
    {
        return Err("lume_stale_transfer_target".into());
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct NativePrincipal {
    pub account_id: String,
    pub generation: String,
    pub revoked: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub cancellations:
        std::sync::Arc<parking_lot::Mutex<Vec<std::sync::Weak<std::sync::atomic::AtomicBool>>>>,
}

impl NativePrincipal {
    pub(crate) fn register_cancel(&self, flag: &std::sync::Arc<std::sync::atomic::AtomicBool>) {
        use std::sync::atomic::Ordering;
        let mut flags = self.cancellations.lock();
        flags.retain(|pending| pending.strong_count() > 0);
        flags.push(std::sync::Arc::downgrade(flag));
        if self.revoked.load(Ordering::SeqCst) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum LocalRequest {
    Diagnose,
    Begin {
        request_key: String,
        operation: Operation,
    },
    Poll {
        operation_id: String,
    },
    Cancel {
        operation_id: String,
    },
    Bind {
        reference: ResourceRef,
        session_id: String,
        policy: BindingPolicy,
    },
    Unbind {
        binding: BindingRef,
    },
    Renew {
        binding: BindingRef,
    },
}

impl super::CuaSandboxRegistry {
    pub(crate) async fn existing_lume_service(&self) -> Option<std::sync::Arc<service::Service>> {
        let account = self
            .lume_principal
            .read()
            .as_ref()
            .map(|principal| principal.account_id.clone())?;
        self.lume.lock().await.get(&account).cloned()
    }
    /// Called only by the native account security session, never IPC payloads.
    pub fn set_lume_account(&self, account: Option<(String, String)>) {
        let previous = self.lume_principal.write().take();
        if let Some(previous) = previous {
            previous
                .revoked
                .store(true, std::sync::atomic::Ordering::SeqCst);
            for flag in previous
                .cancellations
                .lock()
                .iter()
                .filter_map(std::sync::Weak::upgrade)
            {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            let registry = self.clone();
            let owner = previous.account_id;
            let generation = previous.generation;
            let cleanup = async move {
                let service = registry.lume.lock().await.get(&owner).cloned();
                if let Some(service) = service {
                    service.shutdown_generation(&generation).await;
                }
            };
            #[cfg(feature = "tauri-host")]
            tauri::async_runtime::spawn(cleanup);
            #[cfg(not(feature = "tauri-host"))]
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(cleanup);
            }
        }
        *self.lume_principal.write() = account.map(|(account_id, generation)| NativePrincipal {
            account_id,
            generation,
            revoked: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cancellations: Default::default(),
        });
    }

    pub async fn lume_service(&self) -> Result<std::sync::Arc<service::Service>, String> {
        let principal = self
            .lume_principal
            .read()
            .clone()
            .ok_or("lume_account_locked")?;
        let mut services = self.lume.lock().await;
        if principal.revoked.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("lume_account_changed".into());
        }
        let service = if let Some(service) = services.get(&principal.account_id) {
            service.clone()
        } else {
            let root = dirs::data_local_dir()
                .ok_or("lume_app_data_unavailable")?
                .join("cognia")
                .join("lume")
                .join(cognia_desktop_guest::lume::content_hash(
                    principal.account_id.as_bytes(),
                ));
            let service = service::Service::open_owned(
                root,
                principal.account_id.clone(),
                self.lume_principal.clone(),
            )?;
            services.insert(principal.account_id.clone(), service.clone());
            service
        };
        drop(services);
        service.activate_generation(&principal.generation).await?;
        if principal.revoked.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("lume_account_changed".into());
        }
        Ok(service)
    }
}

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn lume_sandbox_local_call(
    reg: tauri::State<'_, super::CuaSandboxRegistry>,
    automation: tauri::State<'_, crate::automation::commands::AutomationState>,
    app: tauri::AppHandle,
    request: LocalRequest,
) -> Result<serde_json::Value, String> {
    let service = reg.lume_service().await?;
    match request {
        LocalRequest::Diagnose => Ok(service.snapshot().await),
        LocalRequest::Poll { operation_id } => {
            serde_json::to_value(service.poll(&operation_id).await?)
                .map_err(|_| "lume_reply_encode".into())
        }
        LocalRequest::Cancel { operation_id } => {
            service.cancel(&operation_id).await?;
            Ok(serde_json::Value::Null)
        }
        LocalRequest::Bind {
            reference,
            session_id,
            policy,
        } => {
            // Native one-shot consent is the admission authority. A renderer
            // cannot join an execution group by supplying its public ID.
            let prompt = crate::automation::permission::ConsentPrompt {
                command: format!("lume_bind_{}", uuid::Uuid::new_v4()),
                surface: crate::automation::permission::Surface::Sandbox,
                plugin_id: None, process_name: None, window_title: None,
                command_detail: Some(format!("Authorize session {session_id} to use owned VM {} at workspace {} with policy {}. The VM remains exclusive to this session; stop it when the session loses its lease.", reference.resource_id, policy.workspace_root, cognia_desktop_guest::lume::content_hash(&serde_json::to_vec(&policy).map_err(|_| "lume_binding_policy")?))),
                session_key: None,
            };
            let consent = automation.consent.clone();
            serde_json::to_value(
                service
                    .bind(reference, session_id, policy, async move {
                        consent.request(app, prompt, 90_000).await
                    })
                    .await?,
            )
            .map_err(|_| "lume_reply_encode".into())
        }
        LocalRequest::Renew { binding } => {
            service.renew_binding(&binding).await?;
            Ok(serde_json::Value::Null)
        }
        LocalRequest::Unbind { binding } => {
            service.unbind(&binding).await?;
            Ok(serde_json::Value::Null)
        }
        LocalRequest::Begin {
            request_key,
            operation,
        } => {
            let needs_consent = operation.needs_consent();
            let native_setup = matches!(&operation, Operation::Setup { .. });
            let detail = if let Operation::AdoptWorkspace {
                reference,
                review_id,
            } = &operation
            {
                service.workspace_consent(reference, review_id).await?
            } else {
                consent_detail(&operation)
            };
            let consent = automation.consent.clone();
            let actor = reg
                .lume_principal
                .read()
                .clone()
                .ok_or("lume_account_locked")?;
            // Unique prompt command prevents a stored session grant from
            // approving another preparation, trust decision or deletion.
            let mut prompt = crate::automation::permission::ConsentPrompt {
                command: format!("lume_manage_{}", uuid::Uuid::new_v4()),
                surface: crate::automation::permission::Surface::Sandbox,
                plugin_id: None,
                process_name: None,
                window_title: None,
                command_detail: Some(detail),
                session_key: None,
            };
            let qualification = match &operation {
                Operation::Qualify { reference, .. } => Some(reference.clone()),
                _ => None,
            };
            let observer = service.clone();
            let approval = async move {
                let identity = if let Some(reference) = qualification {
                    observer.observe_driver_identity(&reference).await.ok()
                } else {
                    None
                };
                if let Some(identity) = &identity {
                    prompt.command_detail = Some(format!(
                        "{} Approved Driver identity: {}",
                        prompt.command_detail.as_deref().unwrap_or(""),
                        serde_json::to_string(identity).unwrap_or_default()
                    ));
                }
                let mut allowed =
                    !needs_consent || consent.request(app.clone(), prompt, 90_000).await;
                allowed &= !actor.revoked.load(std::sync::atomic::Ordering::SeqCst);
                if allowed && native_setup {
                    use tauri_plugin_clipboard_manager::ClipboardExt;
                    allowed = app.clipboard().clear().is_ok();
                }
                service::OperationApproval {
                    allowed,
                    driver_identity: identity,
                }
            };
            serde_json::to_value(
                service
                    .begin(request_key, operation, approval, Some(reg.inner().clone()))
                    .await?,
            )
            .map_err(|_| "lume_reply_encode".into())
        }
    }
}

#[cfg(feature = "tauri-host")]
fn consent_detail(operation: &Operation) -> String {
    match operation {
        Operation::Configure{..}=>"Configure the pinned local Lume executable and automation feature. No installation or update is performed.".into(),
        Operation::Provision{..}=>"Prepare a Cognia-owned macOS VM. Cognia may start and force-stop this guest for cancellation. Disks are preserved until an explicit deletion.".into(),
        Operation::Delete{..}=>"Permanently delete this Cognia-owned VM and its guest disk after confirming that the VM stopped.".into(),
        Operation::PrepareSsh{..}=>"Generate a new per-resource SSH key and guest instance nonce. Install the returned public key and helper in the dedicated guest; rotate cloned host keys and disable password SSH login.".into(),
        Operation::Setup{..}=>"native-setup-clipboard: Clear the Host clipboard and open Lume's native setup window. Lume 0.6.1 synchronizes clipboard content in both directions in this mode. Do not copy Host secrets while preparing the guest. Agent, shell and file operations are blocked until this window is closed by stopping the VM.".into(),
        Operation::TrustSsh{host_key,..}=>{
            use base64::Engine;use sha2::{Digest,Sha256};
            let fingerprint=host_key.split_whitespace().nth(1).and_then(|key|base64::engine::general_purpose::STANDARD.decode(key).ok()).map(|key|base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(key))).unwrap_or_else(||"invalid".into());
            format!("Trust the guest SSH host key SHA256:{fingerprint}. Compare this fingerprint in the guest's trusted console before approving.")
        }
        Operation::Qualify{..}=>"Verify the installed guest helper and Driver versions. Qualification never grants macOS privacy permissions or logs into the guest.".into(),
        Operation::ImportWorkspace{host_root,..}=>format!("Import the selected workspace {host_root} into the empty guest replica. Credentials, environment files and Git metadata are excluded. No Host mount is shared; source files are not changed."),
        Operation::AdoptWorkspace{review_id,..}=>format!("Stop this VM and adopt the immutable workspace diff shown for review {review_id}. Task Workspace will refuse all writes if the source revision changed. The guest disk remains preserved."),
        _=>"Run an operation on the bound Cognia-owned guest.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_revocation_is_sticky_across_same_account_reunlock() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let registry = super::super::CuaSandboxRegistry::default();
        registry.set_lume_account(Some(("account".into(), "g0".into())));
        let original = registry.lume_principal.read().clone().unwrap();
        let pending = Arc::new(AtomicBool::new(false));
        original.cancellations.lock().push(Arc::downgrade(&pending));
        registry.set_lume_account(None);
        assert!(original.revoked.load(Ordering::SeqCst));
        assert!(pending.load(Ordering::SeqCst));
        let late = Arc::new(AtomicBool::new(false));
        original.register_cancel(&late);
        assert!(late.load(Ordering::SeqCst));
        registry.set_lume_account(Some(("account".into(), "g1".into())));
        assert!(original.revoked.load(Ordering::SeqCst));
        assert_eq!(
            registry.lume_principal.read().as_ref().unwrap().generation,
            "g1"
        );
    }
    #[test]
    fn public_seam_rejects_unknown_operations_and_authority_flags() {
        assert!(serde_json::from_value::<LocalRequest>(
            serde_json::json!({"kind":"bind","confirmed":true})
        )
        .is_err());
        assert!(serde_json::from_value::<LocalRequest>(
            serde_json::json!({"kind":"shell","command":"id"})
        )
        .is_err());
    }
}
