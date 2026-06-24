//! Storage for the gateway bearer token. Mirrors `remote_control::keyring` —
//! fixed service/account names, every read tolerates a missing entry so
//! callers can use the helper as a get-or-default. Backed by
//! [`crate::secret_store`] (single OS-keyring master key) rather than a
//! dedicated keyring item.

use crate::secret_store;

const SERVICE: &str = "com.cognia.gateway";
const TOKEN_ACCOUNT: &str = "bearer-token";

pub fn read_token() -> Result<Option<String>, String> {
    secret_store::get(SERVICE, TOKEN_ACCOUNT)
}

pub fn write_token(token: &str) -> Result<(), String> {
    secret_store::set(SERVICE, TOKEN_ACCOUNT, token)
}

pub fn clear_token() -> Result<(), String> {
    secret_store::delete(SERVICE, TOKEN_ACCOUNT)
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
        // Routes through the in-memory secret_store global under cfg(test), so
        // this is hermetic — no OS keyring required.
        let token = generate_token();
        write_token(&token).unwrap();
        assert_eq!(read_token().unwrap(), Some(token.clone()));
        clear_token().unwrap();
        assert_eq!(read_token().unwrap(), None);
    }
}
