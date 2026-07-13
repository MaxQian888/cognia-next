//! Storage for the remote-control bearer token and outbound HMAC signing
//! secret.
//!
//! Service namespace `"com.cognia.remote-control"`, fixed account names, no
//! key rotation beyond "set / clear / read". Every read tolerates a missing
//! entry so callers can use the helper as a get-or-default. Backed by
//! [`cognia_secrets::secret_store`] (single OS-keyring master key).

use cognia_secrets::secret_store;

const SERVICE: &str = "com.cognia.remote-control";
const TOKEN_ACCOUNT: &str = "inbound-token";
const SIGNING_SECRET_ACCOUNT: &str = "outbound-signing-secret";

fn read(account: &str) -> Result<Option<String>, String> {
    secret_store::get(SERVICE, account)
}

fn write(account: &str, value: &str) -> Result<(), String> {
    secret_store::set(SERVICE, account, value)
}

fn clear(account: &str) -> Result<(), String> {
    secret_store::delete(SERVICE, account)
}

pub fn read_token() -> Result<Option<String>, String> {
    read(TOKEN_ACCOUNT)
}

pub fn write_token(token: &str) -> Result<(), String> {
    write(TOKEN_ACCOUNT, token)
}

#[allow(dead_code)]
pub fn clear_token() -> Result<(), String> {
    clear(TOKEN_ACCOUNT)
}

pub fn read_signing_secret() -> Result<Option<String>, String> {
    read(SIGNING_SECRET_ACCOUNT)
}

pub fn write_signing_secret(secret: &str) -> Result<(), String> {
    write(SIGNING_SECRET_ACCOUNT, secret)
}

pub fn clear_signing_secret() -> Result<(), String> {
    clear(SIGNING_SECRET_ACCOUNT)
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

    #[test]
    fn generated_token_is_64_hex_chars() {
        let token = generate_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn token_round_trip() {
        // Hermetic via the in-memory secret_store global under cfg(test).
        let token = generate_token();
        write_token(&token).unwrap();
        assert_eq!(read_token().unwrap(), Some(token.clone()));
        clear_token().unwrap();
        assert_eq!(read_token().unwrap(), None);
    }

    #[test]
    fn signing_secret_round_trip() {
        write_signing_secret("hunter2").unwrap();
        assert_eq!(read_signing_secret().unwrap(), Some("hunter2".to_string()));
        clear_signing_secret().unwrap();
        assert_eq!(read_signing_secret().unwrap(), None);
    }
}
