//! OS-keyring-backed storage for the gateway bearer token. Mirrors
//! `remote_control::keyring` — fixed service/account names, every read
//! tolerates `NoEntry` so callers can use the helper as a get-or-default.

use keyring::Entry;

const SERVICE: &str = "com.cognia.gateway";
const TOKEN_ACCOUNT: &str = "bearer-token";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, TOKEN_ACCOUNT).map_err(|e| format!("keyring init failed: {e}"))
}

pub fn read_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

pub fn write_token(token: &str) -> Result<(), String> {
    entry()?
        .set_password(token)
        .map_err(|e| format!("keyring write failed: {e}"))
}

pub fn clear_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete failed: {e}")),
    }
}

/// Generate a fresh 256-bit bearer token (UUIDv4 ×2, hex-encoded).
pub fn generate_token() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{}{}", a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    #[test]
    fn generated_token_is_64_hex_chars() {
        let token = generate_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn token_round_trip() {
        if !keyring_available() {
            return;
        }
        let token = generate_token();
        write_token(&token).unwrap();
        assert_eq!(read_token().unwrap(), Some(token));
        clear_token().unwrap();
        assert_eq!(read_token().unwrap(), None);
    }
}
