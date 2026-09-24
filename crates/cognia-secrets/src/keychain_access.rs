//! Serialize Cognia's legacy macOS Keychain operations so passive discovery
//! cannot display password dialogs or suppress an explicit user's grant.
//!
//! The native keyring backend uses the legacy login Keychain, for which
//! per-query Data Protection authentication flags do not prevent UI. Every
//! app-owned raw keyring access must use this boundary instead.

/// Read a credential in response to an explicit user operation. Missing and
/// denied credentials remain distinct native errors.
pub fn read_password(service: &str, account: &str) -> keyring::Result<String> {
    with_keychain_interaction(true, || {
        keyring::Entry::new(service, account)?.get_password()
    })
}

/// Passive discovery must never interrupt the user with a Keychain dialog.
pub fn read_password_without_prompt(service: &str, account: &str) -> keyring::Result<String> {
    with_keychain_interaction(false, || {
        keyring::Entry::new(service, account)?.get_password()
    })
}

/// Store a daemon credential without allowing background startup to prompt.
pub fn write_password_without_prompt(
    service: &str,
    account: &str,
    value: &str,
) -> keyring::Result<()> {
    with_keychain_interaction(false, || {
        keyring::Entry::new(service, account)?.set_password(value)
    })
}

pub(crate) fn with_keychain_interaction<T>(
    allow: bool,
    operation: impl FnOnce() -> keyring::Result<T>,
) -> keyring::Result<T> {
    #[cfg(target_os = "macos")]
    {
        static ACCESS: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
        let _access = ACCESS.lock();
        with_policy(&MacOsInteractionPolicy, allow, operation)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = allow;
        operation()
    }
}

#[cfg(any(target_os = "macos", test))]
trait InteractionPolicy {
    fn get(&self) -> keyring::Result<bool>;
    fn set(&self, allowed: bool) -> keyring::Result<()>;
}

#[cfg(any(target_os = "macos", test))]
fn with_policy<T>(
    policy: &impl InteractionPolicy,
    allow: bool,
    operation: impl FnOnce() -> keyring::Result<T>,
) -> keyring::Result<T> {
    struct Restore<'a, P: InteractionPolicy> {
        policy: &'a P,
        original: bool,
    }
    impl<P: InteractionPolicy> Drop for Restore<'_, P> {
        fn drop(&mut self) {
            if let Err(error) = self.policy.set(self.original) {
                log::error!("could not restore Keychain interaction policy: {error}");
            }
        }
    }
    let original = policy.get()?;
    policy.set(allow)?;
    let _restore = Restore { policy, original };
    operation()
}

#[cfg(target_os = "macos")]
struct MacOsInteractionPolicy;

#[cfg(target_os = "macos")]
impl InteractionPolicy for MacOsInteractionPolicy {
    fn get(&self) -> keyring::Result<bool> {
        let mut allowed = 0;
        // SAFETY: Security writes one Boolean to the valid local pointer.
        let status = unsafe {
            security_framework_sys::keychain::SecKeychainGetUserInteractionAllowed(&mut allowed)
        };
        policy_status(status)?;
        Ok(allowed != 0)
    }

    fn set(&self, allowed: bool) -> keyring::Result<()> {
        // SAFETY: Security accepts a Boolean; calls are serialized above.
        policy_status(unsafe {
            security_framework_sys::keychain::SecKeychainSetUserInteractionAllowed(u8::from(
                allowed,
            ))
        })
    }
}

#[cfg(target_os = "macos")]
fn policy_status(status: i32) -> keyring::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(keyring::Error::PlatformFailure(Box::new(
            std::io::Error::other(format!(
                "Keychain interaction policy failed (OSStatus {status})"
            )),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Policy(Cell<bool>);
    impl InteractionPolicy for Policy {
        fn get(&self) -> keyring::Result<bool> {
            Ok(self.0.get())
        }
        fn set(&self, allowed: bool) -> keyring::Result<()> {
            self.0.set(allowed);
            Ok(())
        }
    }

    #[test]
    fn passive_read_restores_original_policy_even_when_access_is_denied() {
        let policy = Policy(Cell::new(true));
        let error = with_policy(&policy, false, || {
            assert!(!policy.0.get());
            Err::<(), _>(keyring::Error::NoEntry)
        })
        .unwrap_err();
        assert!(matches!(error, keyring::Error::NoEntry));
        assert!(policy.0.get());
    }

    #[test]
    fn explicit_read_preserves_a_preexisting_disabled_policy() {
        let policy = Policy(Cell::new(false));
        assert_eq!(
            with_policy(&policy, true, || {
                assert!(policy.0.get());
                Ok("credential")
            })
            .unwrap(),
            "credential"
        );
        assert!(!policy.0.get());
    }

    #[test]
    fn unwind_restores_policy() {
        let policy = Policy(Cell::new(true));
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _: keyring::Result<()> = with_policy(&policy, false, || panic!("operation failed"));
        }));
        assert!(outcome.is_err());
        assert!(policy.0.get());
    }

    #[test]
    fn policy_failure_never_runs_the_keychain_operation() {
        struct BrokenPolicy;
        impl InteractionPolicy for BrokenPolicy {
            fn get(&self) -> keyring::Result<bool> {
                Ok(true)
            }
            fn set(&self, _: bool) -> keyring::Result<()> {
                Err(keyring::Error::NoEntry)
            }
        }
        assert!(
            with_policy(&BrokenPolicy, false, || -> keyring::Result<()> {
                panic!("must not run")
            })
            .is_err()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_policy_is_disabled_and_restored_without_reading_credentials() {
        let original = MacOsInteractionPolicy.get().unwrap();
        with_keychain_interaction(false, || {
            assert!(!MacOsInteractionPolicy.get()?);
            Ok(())
        })
        .unwrap();
        assert_eq!(MacOsInteractionPolicy.get().unwrap(), original);
    }
}
