pub mod discord;
pub mod slack;
pub mod telegram;

#[derive(Debug, thiserror::Error)]
pub enum SigError {
    #[error("missing signature header")]
    Missing,
    #[error("signature mismatch")]
    Mismatch,
    #[error("timestamp out of replay-protection window")]
    Stale,
}
