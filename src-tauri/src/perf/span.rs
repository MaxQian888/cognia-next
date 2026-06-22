//! Ergonomic instrumentation API over [`super::registry::REGISTRY`].
//!
//! Three shapes for the three call-site flavors:
//!
//! ```ignore
//! // 1. RAII scope guard — records the whole scope on drop (incl. awaits).
//! async fn handle() {
//!     let _g = crate::perf::guard("connector.send");
//!     do_work().await;
//! }
//!
//! // 2. Fallible future — records ok/err based on the Result.
//! let out = crate::perf::timed("ocr.extract", async { provider.extract(req).await }).await?;
//!
//! // 3. Manual — when you already have the elapsed Duration.
//! crate::perf::record("vector.query", elapsed, result.is_ok());
//! ```
//!
//! The guard is `Send` (it holds only a `&'static str`, an `Instant`, and a
//! `bool`) and locks the registry only in `Drop`, so it is safe to hold across
//! an `.await` point.

use std::future::Future;
use std::time::{Duration, Instant};

use super::registry::REGISTRY;

/// RAII timer. Records elapsed time into the registry on drop. Defaults to a
/// success outcome; call [`Guard::fail`] to mark the span as an error before it
/// drops.
pub struct Guard {
    name: &'static str,
    start: Instant,
    ok: bool,
}

impl Guard {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            start: Instant::now(),
            ok: true,
        }
    }

    /// Mark this span as a failure (counts toward `errorCount`).
    pub fn fail(&mut self) {
        self.ok = false;
    }

    /// Set the outcome explicitly (e.g. `g.set_ok(result.is_ok())`).
    pub fn set_ok(&mut self, ok: bool) {
        self.ok = ok;
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        REGISTRY.record(self.name, self.start.elapsed(), self.ok);
    }
}

/// Start a scope guard for `name`.
pub fn guard(name: &'static str) -> Guard {
    Guard::new(name)
}

/// Record a pre-measured duration directly.
pub fn record(name: &'static str, elapsed: Duration, ok: bool) {
    REGISTRY.record(name, elapsed, ok);
}

/// Time a fallible future, recording success/failure from its `Result`.
pub async fn timed<F, T, E>(name: &'static str, fut: F) -> Result<T, E>
where
    F: Future<Output = Result<T, E>>,
{
    let start = Instant::now();
    let out = fut.await;
    REGISTRY.record(name, start.elapsed(), out.is_ok());
    out
}

/// Time an infallible future (always recorded as success).
pub async fn timed_ok<F, T>(name: &'static str, fut: F) -> T
where
    F: Future<Output = T>,
{
    let start = Instant::now();
    let out = fut.await;
    REGISTRY.record(name, start.elapsed(), true);
    out
}

/// Convenience macro: `perf_span!("name");` drops a [`Guard`] at scope end.
#[macro_export]
macro_rules! perf_span {
    ($name:expr) => {
        let _perf_guard = $crate::perf::guard($name);
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_records_on_drop() {
        REGISTRY.reset();
        {
            let _g = guard("test.guard.drop");
        }
        let snap = REGISTRY.snapshot();
        let row = snap.iter().find(|r| r.name == "test.guard.drop").unwrap();
        assert_eq!(row.count, 1);
        assert_eq!(row.error_count, 0);
    }

    #[test]
    fn guard_fail_marks_error() {
        REGISTRY.reset();
        {
            let mut g = guard("test.guard.fail");
            g.fail();
        }
        let snap = REGISTRY.snapshot();
        let row = snap.iter().find(|r| r.name == "test.guard.fail").unwrap();
        assert_eq!(row.error_count, 1);
    }

    #[test]
    fn record_writes_directly() {
        REGISTRY.reset();
        record("test.record", Duration::from_millis(5), false);
        let snap = REGISTRY.snapshot();
        let row = snap.iter().find(|r| r.name == "test.record").unwrap();
        assert_eq!(row.count, 1);
        assert_eq!(row.error_count, 1);
    }

    #[tokio::test]
    async fn timed_records_ok_and_err() {
        REGISTRY.reset();
        let ok: Result<u8, u8> = timed("test.timed.ok", async { Ok(1) }).await;
        let err: Result<u8, u8> = timed("test.timed.err", async { Err(2) }).await;
        assert!(ok.is_ok());
        assert!(err.is_err());
        let snap = REGISTRY.snapshot();
        assert_eq!(
            snap.iter()
                .find(|r| r.name == "test.timed.ok")
                .unwrap()
                .error_count,
            0
        );
        assert_eq!(
            snap.iter()
                .find(|r| r.name == "test.timed.err")
                .unwrap()
                .error_count,
            1
        );
    }
}
