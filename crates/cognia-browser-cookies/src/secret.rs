//! A string that holds a secret (a password, a key passphrase): redacted in
//! `Debug`, never `Display`ed or serialized, and wiped when dropped.

use std::fmt;

use zeroize::Zeroize;

#[derive(Clone, Default, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The secret itself. Callers hand it straight to its one destination (the
    /// secret store, a page's field, the clipboard) and never log it.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Owned secret bytes (a derived key, a decrypted NSS key) wiped on drop.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn new(value: Vec<u8>) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[REDACTED; {} bytes]", self.0.len())
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_prints_the_value() {
        let secret = SecretString::new("hunter2");
        assert_eq!(format!("{secret:?}"), "[REDACTED]");
        assert_eq!(secret.expose(), "hunter2");
        assert!(!secret.is_empty());
        let bytes = SecretBytes::new(vec![1, 2, 3]);
        assert_eq!(format!("{bytes:?}"), "[REDACTED; 3 bytes]");
        assert_eq!(bytes.expose(), &[1, 2, 3]);
        assert_eq!(bytes.len(), 3);
        assert!(!bytes.is_empty());
    }

    #[test]
    fn conversions_keep_the_value() {
        assert_eq!(SecretString::from("a").expose(), "a");
        assert_eq!(SecretString::from(String::from("b")).expose(), "b");
        assert!(SecretString::default().is_empty());
    }
}
