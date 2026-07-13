use subtle::ConstantTimeEq;

use super::SigError;

/// Verify the `X-Telegram-Bot-Api-Secret-Token` header in constant time.
///
/// Returns `Ok(())` when `provided` matches `expected`; otherwise returns the
/// appropriate `SigError` variant.
pub fn verify_secret_token(provided: Option<&str>, expected: &str) -> Result<(), SigError> {
    let provided = provided.ok_or(SigError::Missing)?;
    if provided.as_bytes().ct_eq(expected.as_bytes()).into() {
        Ok(())
    } else {
        Err(SigError::Mismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn present_and_match_returns_ok() {
        assert!(verify_secret_token(Some("correct-token"), "correct-token").is_ok());
    }

    #[test]
    fn absent_returns_missing() {
        let err = verify_secret_token(None, "correct-token").unwrap_err();
        assert!(matches!(err, SigError::Missing));
    }

    #[test]
    fn present_but_mismatch_returns_mismatch() {
        let err = verify_secret_token(Some("wrong-token"), "correct-token").unwrap_err();
        assert!(matches!(err, SigError::Mismatch));
    }
}
