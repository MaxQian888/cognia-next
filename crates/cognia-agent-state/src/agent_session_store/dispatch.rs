//! `host_rpc` surface for the session store.
//!
//! The sidecar builds the live `sessionStore` object the SDK wants and forwards
//! every call here as `sessionStore.<method>`. Routing is by prefix in
//! `claude/sidecar.rs::answer_host_rpc`, deliberately BEFORE the background-job
//! dispatcher: that one starts with `require_supervisor()?`, so a host without
//! background jobs would fail every session-store call with a message about
//! jobs.
//!
//! The store is a process-global opened on first use. It has no per-session
//! state — the scope travels in each call — so one instance serves every
//! session, and opening it lazily keeps a host that never uses the feature from
//! creating the file at all.

use std::path::PathBuf;
use std::sync::Arc;

use once_cell::sync::OnceCell;
use serde_json::{json, Value};

use super::{summary_json, SessionKey, SessionStore, StoreScope, DEFAULT_RETENTION_DAYS};

static STORE: OnceCell<Arc<SessionStore>> = OnceCell::new();
static STORE_PATH: OnceCell<PathBuf> = OnceCell::new();

/// Point the lazy opener at a path. Call once during setup, before any
/// session-store RPC; ignored afterwards.
pub fn configure_path(path: PathBuf) {
    let _ = STORE_PATH.set(path);
}

fn store() -> Result<Arc<SessionStore>, String> {
    if let Some(existing) = STORE.get() {
        return Ok(Arc::clone(existing));
    }
    let path = STORE_PATH
        .get()
        .cloned()
        .ok_or_else(|| "sessionStore: no database path configured on this host".to_string())?;
    let opened = SessionStore::open(&path)?;
    // Retention runs once per process on first use rather than on a timer: the
    // store is only ever touched by an active agent session, so a scheduled
    // sweep would either fire on an idle app or never fire at all.
    if let Err(e) = opened.prune(DEFAULT_RETENTION_DAYS) {
        log::warn!("sessionStore: retention sweep failed: {e}");
    }
    let _ = STORE.set(Arc::clone(&opened));
    Ok(opened)
}

/// `pub` across the crate boundary (ADR-0067): its only caller is the
/// app-side `companion_api` host-RPC path, which stayed in `app_lib`.
pub fn configured_store() -> Result<Arc<SessionStore>, String> {
    store()
}

/// Whether `method` belongs to this module. Used by the sidecar router.
pub fn is_session_store_method(method: &str) -> bool {
    method.starts_with("sessionStore.")
}

fn scope_from(params: &Value) -> StoreScope {
    serde_json::from_value(params.get("scope").cloned().unwrap_or(Value::Null)).unwrap_or_default()
}

fn key_from(params: &Value) -> Result<SessionKey, String> {
    let raw = params
        .get("key")
        .cloned()
        .ok_or_else(|| "sessionStore: missing `key`".to_string())?;
    let mut key: SessionKey =
        serde_json::from_value(raw).map_err(|e| format!("sessionStore: invalid key: {e}"))?;
    // A `scope` sent alongside the key wins, so the sidecar can keep sending
    // the SDK's own key object untouched and attach the scope separately.
    if params.get("scope").is_some() {
        key.scope = scope_from(params);
    }
    Ok(key)
}

fn str_field(params: &Value, name: &str) -> Result<String, String> {
    params
        .get(name)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("sessionStore: missing `{name}`"))
}

/// Dispatch one `sessionStore.*` call. `method` still carries its prefix.
///
/// Every arm answers in Rust — nothing reaches the renderer, which is what lets
/// the same call succeed headless and under remote driving.
pub async fn dispatch_host_rpc(method: &str, params: &Value) -> Result<Value, String> {
    // Owned copies: the blocking closure outlives this frame's borrows.
    let bare = method
        .strip_prefix("sessionStore.")
        .unwrap_or(method)
        .to_string();
    let params = params.clone();

    // Opening/migrating/pruning the lazy store is SQLite work too, so it must
    // live inside the blocking worker along with the requested operation.
    tokio::task::spawn_blocking(move || {
        let store = store()?;
        run(&store, &bare, &params)
    })
    .await
    .map_err(|e| format!("sessionStore: worker panicked: {e}"))?
}

fn run(store: &SessionStore, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "append" => {
            let key = key_from(params)?;
            let entries = params
                .get("entries")
                .and_then(|v| v.as_array())
                .cloned()
                .ok_or_else(|| "sessionStore: `entries` must be an array".to_string())?;
            let inserted = store.append(&key, &entries)?;
            Ok(json!({ "inserted": inserted, "received": entries.len() }))
        }
        "load" => {
            let key = key_from(params)?;
            // `null` (never written) and `[]` (emptied) mean different things
            // to the SDK's resume path, so the distinction survives the wire.
            Ok(match store.load(&key)? {
                Some(entries) => json!({ "entries": entries }),
                None => json!({ "entries": Value::Null }),
            })
        }
        "listSessions" => {
            let scope = scope_from(params);
            let project_key = str_field(params, "projectKey")?;
            let rows = store.list_sessions(&scope, &project_key)?;
            Ok(json!({
                "sessions": rows
                    .iter()
                    .map(|r| json!({ "sessionId": r.session_id, "mtime": r.mtime }))
                    .collect::<Vec<_>>()
            }))
        }
        "listSubkeys" => {
            let scope = scope_from(params);
            let project_key = str_field(params, "projectKey")?;
            let session_id = str_field(params, "sessionId")?;
            Ok(json!({ "subkeys": store.list_subkeys(&scope, &project_key, &session_id)? }))
        }
        "listSummaries" => {
            let scope = scope_from(params);
            let project_key = str_field(params, "projectKey")?;
            let rows = store.list_summaries(&scope, &project_key)?;
            Ok(json!({ "summaries": rows.iter().map(summary_json).collect::<Vec<_>>() }))
        }
        "readSummary" => {
            let scope = scope_from(params);
            let project_key = str_field(params, "projectKey")?;
            let session_id = str_field(params, "sessionId")?;
            Ok(
                match store.read_summary(&scope, &project_key, &session_id)? {
                    Some(row) => json!({ "summary": summary_json(&row) }),
                    None => json!({ "summary": Value::Null }),
                },
            )
        }
        "writeSummary" => {
            let scope = scope_from(params);
            let project_key = str_field(params, "projectKey")?;
            let session_id = str_field(params, "sessionId")?;
            let data = params
                .get("data")
                .cloned()
                .ok_or_else(|| "sessionStore: missing `data`".to_string())?;
            // Absent = "folded from nothing"; an existing row is then a
            // conflict. `null` and a missing field mean the same thing.
            let expected = params.get("expectedVersion").and_then(|v| v.as_i64());
            Ok(
                match store.write_summary(&scope, &project_key, &session_id, &data, expected)? {
                    // A conflict is an ordinary outcome, not an error: the
                    // caller re-reads, re-folds and retries. Returning `Err`
                    // here would surface a routine race as a mirror failure.
                    None => json!({ "ok": false, "conflict": true }),
                    Some(row) => json!({ "ok": true, "summary": summary_json(&row) }),
                },
            )
        }
        "delete" => {
            let key = key_from(params)?;
            Ok(json!({ "removed": store.delete(&key)? }))
        }
        "prune" => {
            let days = params
                .get("retentionDays")
                .and_then(|v| v.as_u64())
                .unwrap_or(DEFAULT_RETENTION_DAYS as u64) as u32;
            Ok(json!({ "removed": store.prune(days)? }))
        }
        "backup" => {
            let dest = str_field(params, "path")?;
            store.backup_to(&dest)?;
            Ok(json!({ "ok": true, "path": dest }))
        }
        "stats" => Ok(json!({ "stats": store.stats()? })),
        other => Err(format!("sessionStore: unknown method `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Arc<SessionStore> {
        SessionStore::in_memory().expect("store")
    }

    fn key_params(session: &str) -> Value {
        json!({
            "key": { "projectKey": "proj", "sessionId": session },
            "scope": { "tenant": "t", "workspace": "w" },
        })
    }

    #[test]
    fn is_session_store_method_matches_only_the_prefix() {
        assert!(is_session_store_method("sessionStore.append"));
        assert!(!is_session_store_method("jobs.spawn"));
        // The routing check must not fire on a job method that merely mentions
        // sessions, or background jobs would break the day one is added.
        assert!(!is_session_store_method("jobs.sessionStore"));
    }

    #[test]
    fn append_reports_what_it_inserted_versus_what_it_received() {
        // The caller uses this to tell "already mirrored" apart from "dropped",
        // which are otherwise indistinguishable and mean opposite things.
        let store = fresh();
        let mut params = key_params("s1");
        params["entries"] = json!([{ "type": "user", "uuid": "a" }]);

        let first = run(&store, "append", &params).expect("append");
        assert_eq!(first["inserted"], 1);
        assert_eq!(first["received"], 1);

        let replay = run(&store, "append", &params).expect("replay");
        assert_eq!(replay["inserted"], 0);
        assert_eq!(replay["received"], 1);
    }

    #[test]
    fn load_keeps_null_and_empty_apart_on_the_wire() {
        let store = fresh();
        let params = key_params("ghost");
        assert_eq!(
            run(&store, "load", &params).expect("load")["entries"],
            Value::Null
        );

        let mut appended = key_params("s1");
        appended["entries"] = json!([{ "type": "user", "uuid": "a" }]);
        run(&store, "append", &appended).expect("append");
        let loaded = run(&store, "load", &key_params("s1")).expect("load");
        assert_eq!(loaded["entries"].as_array().expect("array").len(), 1);
    }

    #[test]
    fn the_scope_beside_the_key_overrides_whatever_the_key_carried() {
        // The sidecar forwards the SDK's own key object untouched and attaches
        // the scope separately; a key that tried to name its own tenant must
        // not win, or the isolation is caller-controlled.
        let store = fresh();
        let mut spoofed = json!({
            "key": { "projectKey": "proj", "sessionId": "s1", "tenant": "victim" },
            "scope": { "tenant": "attacker", "workspace": "w" },
            "entries": [{ "type": "user", "uuid": "a" }],
        });
        run(&store, "append", &spoofed).expect("append");

        spoofed["scope"] = json!({ "tenant": "victim", "workspace": "w" });
        assert_eq!(
            run(&store, "load", &spoofed).expect("load")["entries"],
            Value::Null
        );
    }

    #[test]
    fn a_summary_conflict_is_reported_as_data_not_as_an_error() {
        let store = fresh();
        let base = json!({
            "scope": { "tenant": "t", "workspace": "w" },
            "projectKey": "proj",
            "sessionId": "s1",
            "data": { "n": 1 },
        });
        let first = run(&store, "writeSummary", &base).expect("write");
        assert_eq!(first["ok"], true);
        assert_eq!(first["summary"]["version"], 1);

        // Same call again: the caller folded from a version that no longer
        // exists. `ok: false` tells it to re-read; an Err would look like a
        // durability failure and raise a mirror_error.
        let conflict = run(&store, "writeSummary", &base).expect("write");
        assert_eq!(conflict["ok"], false);
        assert_eq!(conflict["conflict"], true);

        let mut retry = base.clone();
        retry["expectedVersion"] = json!(1);
        assert_eq!(
            run(&store, "writeSummary", &retry).expect("write")["ok"],
            true
        );
    }

    #[test]
    fn list_and_subkey_calls_project_their_rows() {
        let store = fresh();
        let mut main = key_params("s1");
        main["entries"] = json!([{ "type": "user", "uuid": "a" }]);
        run(&store, "append", &main).expect("append");

        let mut sub = key_params("s1");
        sub["key"]["subpath"] = json!("subagents/agent-1");
        sub["entries"] = json!([{ "type": "user", "uuid": "b" }]);
        run(&store, "append", &sub).expect("append");

        let listed = run(
            &store,
            "listSessions",
            &json!({ "scope": { "tenant": "t", "workspace": "w" }, "projectKey": "proj" }),
        )
        .expect("list");
        assert_eq!(listed["sessions"].as_array().expect("array").len(), 1);

        let subkeys = run(
            &store,
            "listSubkeys",
            &json!({
                "scope": { "tenant": "t", "workspace": "w" },
                "projectKey": "proj",
                "sessionId": "s1",
            }),
        )
        .expect("subkeys");
        assert_eq!(subkeys["subkeys"], json!(["subagents/agent-1"]));
    }

    #[test]
    fn every_method_names_the_field_it_is_missing() {
        // A generic "invalid params" leaves the sidecar author guessing which
        // of six fields they got wrong.
        let store = fresh();
        for (method, needle) in [
            ("append", "`key`"),
            ("load", "`key`"),
            ("listSessions", "`projectKey`"),
            ("listSubkeys", "`projectKey`"),
            ("readSummary", "`projectKey`"),
            ("backup", "`path`"),
        ] {
            let err = run(&store, method, &json!({})).expect_err(method);
            assert!(err.contains(needle), "{method}: {err}");
        }
        let err = run(
            &store,
            "append",
            &json!({ "key": { "projectKey": "p", "sessionId": "s" } }),
        )
        .expect_err("entries");
        assert!(err.contains("`entries`"), "{err}");
    }

    #[test]
    fn an_unknown_method_is_refused_by_name() {
        let store = fresh();
        let err = run(&store, "dropEverything", &json!({})).expect_err("unknown");
        assert!(err.contains("unknown method `dropEverything`"), "{err}");
    }

    #[test]
    fn prune_defaults_to_the_documented_retention() {
        let store = fresh();
        // Nothing is old enough, so this only proves the default parses and the
        // call shape is right — the retention behaviour itself is covered in
        // the store's own tests.
        assert_eq!(
            run(&store, "prune", &json!({})).expect("prune")["removed"],
            0
        );
        assert_eq!(
            run(&store, "prune", &json!({ "retentionDays": 0 })).expect("prune")["removed"],
            0
        );
    }
}
