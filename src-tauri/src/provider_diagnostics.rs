//! ADR-0067 Tier C facade — the provider balance-script sandbox moved to
//! [`cognia_net::provider_diagnostics`]; only the three `#[tauri::command]`
//! shells stay here, mirroring the `proxy_config` facade next door.
//!
//! Keeping the shells app-side is what stops `cognia-net` — a foundation crate
//! linked by eight others — from gaining a `tauri` dependency. The move also
//! takes `rquickjs` (a C-compiled JS engine, used by nothing else in `app_lib`)
//! out of the app crate's dependency graph.

pub use cognia_net::provider_diagnostics::*;

#[tauri::command]
pub fn provider_diagnostics_migrate_balance_token(
    source_id: String,
    token: String,
) -> Result<String, String> {
    cognia_net::provider_diagnostics::migrate_balance_token(source_id, token)
}

#[tauri::command]
pub fn provider_diagnostics_clear_balance_token(source_id: String) -> Result<(), String> {
    cognia_net::provider_diagnostics::clear_balance_token(source_id)
}

#[tauri::command]
pub async fn provider_diagnostics_run_balance_script(
    request: BalanceScriptRunRequest,
) -> Result<BalanceScriptRunResult, String> {
    cognia_net::provider_diagnostics::run_balance_script_timed(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These shells are pure delegation (ADR-0067 Tier C), so what is worth
    /// pinning is that they still reach the extracted crate's validation
    /// *before* any keyring write — an invalid id must be rejected outright
    /// rather than stored.
    #[test]
    fn migrate_rejects_an_invalid_source_id_before_touching_the_secret_store() {
        let err = provider_diagnostics_migrate_balance_token(
            "not a valid id!".to_string(),
            "token".to_string(),
        )
        .expect_err("an invalid source id must not be persisted");
        assert!(err.contains("invalid balance source id"), "{err}");
    }

    #[test]
    fn migrate_rejects_an_empty_token() {
        let err = provider_diagnostics_migrate_balance_token("src-1".to_string(), String::new())
            .expect_err("an empty token must be rejected");
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn clear_rejects_an_invalid_source_id() {
        let err = provider_diagnostics_clear_balance_token("bad id!".to_string())
            .expect_err("an invalid source id must be rejected");
        assert!(err.contains("invalid balance source id"), "{err}");
    }

    /// The re-export is what keeps `provider_diagnostics::BalanceScriptRunResult`
    /// resolving for the frontend-facing types after the move.
    #[test]
    fn the_crate_types_are_re_exported_under_the_old_path() {
        let _: fn(BalanceScriptRunRequest) -> _ =
            cognia_net::provider_diagnostics::run_balance_script_timed;
    }
}
