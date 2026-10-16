//! Host-owned workspace environment resolution without an upward domain dependency.
//!
//! Every execution placement resolves the original host identity in the
//! `host-loopback` ledger. Containers and remote runtimes receive those same
//! numbers inside their own network namespace, without a separate allocation.
//! Resolve before translating the host cwd into a container working directory.
//! Allocation does not publish or forward any port.

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, OnceLock},
};

pub const WORKSPACE_ENV_KEYS: [&str; 3] = ["COGNIA_PORT", "COGNIA_PORT_COUNT", "PORT"];
pub const HOST_LOOPBACK_NAMESPACE: &str = "host-loopback";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceEnvQuery {
    pub cwd: PathBuf,
    pub workspace_id: Option<String>,
    /// Execution metadata; current callers use `HOST_LOOPBACK_NAMESPACE`.
    /// The host authority always uses that ledger, including for legacy runtime tags.
    pub namespace: String,
}

pub type WorkspaceEnv = BTreeMap<String, String>;
pub type WorkspaceEnvProvider =
    Arc<dyn Fn(WorkspaceEnvQuery) -> Result<Option<WorkspaceEnv>, String> + Send + Sync>;

static PROVIDER: OnceLock<WorkspaceEnvProvider> = OnceLock::new();

fn install(
    slot: &OnceLock<WorkspaceEnvProvider>,
    provider: WorkspaceEnvProvider,
) -> Result<(), String> {
    match slot.set(provider) {
        Ok(()) => Ok(()),
        Err(provider)
            if slot
                .get()
                .is_some_and(|current| Arc::ptr_eq(current, &provider)) =>
        {
            Ok(())
        }
        Err(_) => Err(
            "workspace environment provider is already installed; replacing it is not allowed"
                .into(),
        ),
    }
}

/// Installing the same provider handle again is idempotent. A different
/// provider cannot replace the authority once execution has started.
pub fn set_workspace_env_provider(provider: WorkspaceEnvProvider) -> Result<(), String> {
    install(&PROVIDER, provider)
}

/// `None` means no provider or no matching subject, never an allocation failure.
/// Spawn boundaries must propagate `Err` and merge successful values last.
pub fn resolve_workspace_env(query: WorkspaceEnvQuery) -> Result<Option<WorkspaceEnv>, String> {
    resolve(current_provider().as_ref(), query)
}

fn current_provider() -> Option<WorkspaceEnvProvider> {
    #[cfg(test)]
    if let Some(provider) = TEST_PROVIDER.with(|slot| slot.borrow().clone()) {
        return provider;
    }
    PROVIDER.get().cloned()
}

/// Resolve outside the Tokio worker pool: providers may canonicalize paths,
/// acquire a store lock, and wait for SQLite's busy timeout. Capture the provider
/// before offloading so scoped test overrides obey the same contract.
#[cfg(feature = "workspace-env-async")]
pub async fn resolve_workspace_env_async(
    query: WorkspaceEnvQuery,
) -> Result<Option<WorkspaceEnv>, String> {
    let provider = current_provider();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle
            .spawn_blocking(move || resolve(provider.as_ref(), query))
            .await
            .map_err(|error| format!("workspace environment resolver task failed: {error}"))?
    } else {
        resolve(provider.as_ref(), query)
    }
}

fn resolve(
    provider: Option<&WorkspaceEnvProvider>,
    query: WorkspaceEnvQuery,
) -> Result<Option<WorkspaceEnv>, String> {
    match provider {
        Some(provider) => provider(query),
        None => Ok(None),
    }
}

#[cfg(test)]
thread_local! {
    static TEST_PROVIDER: std::cell::RefCell<Option<Option<WorkspaceEnvProvider>>> = const { std::cell::RefCell::new(None) };
}

/// Thread-scoped and panic-safe; never changes the production authority.
#[cfg(test)]
pub fn with_workspace_env_provider<T>(
    provider: Option<WorkspaceEnvProvider>,
    test: impl FnOnce() -> T,
) -> T {
    struct Restore(Option<Option<WorkspaceEnvProvider>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_PROVIDER.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(TEST_PROVIDER.with(|slot| slot.replace(Some(provider))));
    test()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query() -> WorkspaceEnvQuery {
        WorkspaceEnvQuery {
            cwd: PathBuf::from("/workspace"),
            workspace_id: Some("id".into()),
            namespace: HOST_LOOPBACK_NAMESPACE.into(),
        }
    }

    #[test]
    fn uninstalled_provider_and_unmatched_subject_are_none() {
        with_workspace_env_provider(None, || {
            assert_eq!(resolve_workspace_env(query()), Ok(None))
        });
        with_workspace_env_provider(Some(Arc::new(|_| Ok(None))), || {
            assert_eq!(resolve_workspace_env(query()), Ok(None))
        });
    }

    #[test]
    fn provider_receives_identity_and_preserves_values_and_failure() {
        let env = BTreeMap::from([("PORT".into(), "41000".into())]);
        let expected = env.clone();
        with_workspace_env_provider(
            Some(Arc::new(move |actual| {
                assert_eq!(actual, query());
                Ok(Some(env.clone()))
            })),
            || assert_eq!(resolve_workspace_env(query()), Ok(Some(expected))),
        );
        with_workspace_env_provider(
            Some(Arc::new(|_| Err("port range exhausted".into()))),
            || {
                assert_eq!(
                    resolve_workspace_env(query()),
                    Err("port range exhausted".into())
                );
            },
        );
    }

    #[test]
    fn second_different_install_is_rejected() {
        let slot = OnceLock::new();
        let provider: WorkspaceEnvProvider = Arc::new(|_| Ok(None));
        install(&slot, provider.clone()).unwrap();
        install(&slot, provider).unwrap();
        assert!(install(&slot, Arc::new(|_| Err("other".into())))
            .unwrap_err()
            .contains("already installed"));
        assert_eq!(resolve(slot.get(), query()), Ok(None));
    }

    #[cfg(feature = "workspace-env-async")]
    #[test]
    fn async_resolution_keeps_current_thread_runtime_responsive() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Mutex,
        };
        let started = Arc::new(AtomicBool::new(false));
        let provider_started = started.clone();
        let (progress_tx, progress_rx) = mpsc::channel();
        let progress_rx = Mutex::new(progress_rx);
        let provider = Arc::new(move |_| {
            provider_started.store(true, Ordering::Release);
            // A synchronous call on the sole runtime worker cannot receive
            // this signal until it times out, making this a deadlock regression.
            progress_rx
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| "runtime worker was blocked".to_string())?;
            Ok(Some(BTreeMap::from([("PORT".into(), "41000".into())])))
        });
        with_workspace_env_provider(Some(provider), || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(async {
                    let progress = tokio::spawn(async move {
                        while !started.load(Ordering::Acquire) {
                            tokio::task::yield_now().await;
                        }
                        progress_tx.send(()).unwrap();
                    });
                    assert_eq!(
                        resolve_workspace_env_async(query()).await.unwrap().unwrap()["PORT"],
                        "41000"
                    );
                    progress.await.unwrap();
                });
        });
    }

    #[cfg(feature = "workspace-env-async")]
    #[test]
    fn async_resolution_preserves_none_errors_and_panics() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        with_workspace_env_provider(None, || {
            assert_eq!(
                runtime.block_on(resolve_workspace_env_async(query())),
                Ok(None)
            );
        });
        with_workspace_env_provider(Some(Arc::new(|_| Err("store busy".into()))), || {
            assert_eq!(
                runtime.block_on(resolve_workspace_env_async(query())),
                Err("store busy".into())
            );
        });
        with_workspace_env_provider(Some(Arc::new(|_| panic!("provider panic"))), || {
            assert!(runtime
                .block_on(resolve_workspace_env_async(query()))
                .unwrap_err()
                .contains("resolver task failed"));
        });
    }
}
