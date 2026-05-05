pub mod telegram;

#[derive(Debug, thiserror::Error)]
pub enum SigError {
    #[error("missing signature header")]
    Missing,
    #[error("signature mismatch")]
    Mismatch,
}
