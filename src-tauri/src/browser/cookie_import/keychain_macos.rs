use super::{ImportError, Keychain};

pub(super) struct MacKeychain;

impl Keychain for MacKeychain {
    fn read(&self, service: &str, account: &str) -> Result<String, ImportError> {
        keyring::Entry::new(service, account)
            .and_then(|entry| entry.get_password())
            .map_err(classify_keyring_error)
    }
}

fn classify_keyring_error(error: keyring::Error) -> ImportError {
    match error {
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
            ImportError::PermissionDenied
        }
        _ => ImportError::Decryption,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_access_failures_separately_from_missing_or_corrupt_entries() {
        let denied = keyring::Error::NoStorageAccess(Box::new(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied",
        )));
        assert!(matches!(
            classify_keyring_error(denied),
            ImportError::PermissionDenied
        ));
        assert!(matches!(
            classify_keyring_error(keyring::Error::NoEntry),
            ImportError::Decryption
        ));
        assert!(matches!(
            classify_keyring_error(keyring::Error::BadEncoding(vec![0xff])),
            ImportError::Decryption
        ));
    }
}
