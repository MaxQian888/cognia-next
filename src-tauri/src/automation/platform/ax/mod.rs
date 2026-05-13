//! macOS AXAPI back-end — M1 stub. The real implementation lands in M3.
//!
//! Re-exports `StubBackend` so `make_default_backend` can construct one
//! without a direct dependency on `backend::StubBackend`.

pub use crate::automation::backend::StubBackend;
