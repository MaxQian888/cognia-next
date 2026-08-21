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
