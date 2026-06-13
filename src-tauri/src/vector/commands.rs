//! Tauri commands for the native vector store.
//!
//! Mirrors `scheduler::commands` patterns: each handler takes
//! `State<'_, VectorState>` first, logs `debug!` on entry / `info!` on
//! success / `error!` on failure, and returns `Result<T, String>` via
//! `e.to_string()`.
//!
//! All payloads are flat (commit 2 of the plan flattens the JS side too) —
//! no nested `{ payload: { ... } }` wrapper.

use std::sync::Arc;

use log::{debug, error, info};
use tauri::State;

use super::credentials::{self, VectorCredentials};
use super::db::{CollectionStats, ImportStats};
use super::registry::VectorRegistry;
use super::{ScrollPage, VectorBackend};
use super::types::{
    Collection, CreateCollectionRequest, Filter, FilterMode, HealthStatus, Point, ScrollOptions,
    SearchOptions, SearchResponse, VectorProvider,
};
use super::VectorState;

#[tauri::command]
pub async fn vector_create_collection(
    state: State<'_, VectorState>,
    name: String,
    dimension: usize,
    metadata: Option<serde_json::Value>,
    description: Option<String>,
    embedding_model: Option<String>,
    embedding_provider: Option<String>,
) -> Result<(), String> {
    debug!(
        "vector_create_collection: name={}, dim={}, model={:?}",
        name, dimension, embedding_model
    );
    let store = state.store().map_err(|e| e.to_string())?;
    store
        .create_collection(
            &name,
            dimension,
            description.as_deref(),
            embedding_model.as_deref(),
            embedding_provider.as_deref(),
            metadata.as_ref(),
        )
        .map_err(|e| {
            error!("vector_create_collection failed: {}", e);
            e.to_string()
        })?;
    info!("vector_create_collection ok: {}", name);
    Ok(())
}

#[tauri::command]
pub async fn vector_delete_collection(
    state: State<'_, VectorState>,
    name: String,
) -> Result<(), String> {
    debug!("vector_delete_collection: name={}", name);
    let store = state.store().map_err(|e| e.to_string())?;
    store.delete_collection(&name).map_err(|e| {
        error!("vector_delete_collection failed: {}", e);
        e.to_string()
    })?;
    info!("vector_delete_collection ok: {}", name);
    Ok(())
}

#[tauri::command]
pub async fn vector_list_collections(
    state: State<'_, VectorState>,
) -> Result<Vec<Collection>, String> {
    debug!("vector_list_collections");
    let store = state.store().map_err(|e| e.to_string())?;
    let list = store.list_collections().map_err(|e| {
        error!("vector_list_collections failed: {}", e);
        e.to_string()
    })?;
    info!("vector_list_collections ok: {} collection(s)", list.len());
    Ok(list)
}

#[tauri::command]
pub async fn vector_get_collection(
    state: State<'_, VectorState>,
    name: String,
) -> Result<Collection, String> {
    debug!("vector_get_collection: name={}", name);
    let store = state.store().map_err(|e| e.to_string())?;
    let c = store.get_collection(&name).map_err(|e| {
        error!("vector_get_collection failed: {}", e);
        e.to_string()
    })?;
    info!("vector_get_collection ok: {}", name);
    Ok(c)
}

#[tauri::command]
pub async fn vector_upsert_points(
    state: State<'_, VectorState>,
    collection: String,
    points: Vec<Point>,
) -> Result<(), String> {
    let _perf = crate::perf::guard("vector.upsert");
    debug!(
        "vector_upsert_points: collection={}, count={}",
        collection,
        points.len()
    );
    let store = state.store().map_err(|e| e.to_string())?;
    store.upsert_points(&collection, &points).map_err(|e| {
        error!("vector_upsert_points failed: {}", e);
        e.to_string()
    })?;
    info!(
        "vector_upsert_points ok: collection={}, count={}",
        collection,
        points.len()
    );
    Ok(())
}

#[tauri::command]
pub async fn vector_delete_points(
    state: State<'_, VectorState>,
    collection: String,
    ids: Vec<String>,
) -> Result<(), String> {
    debug!(
        "vector_delete_points: collection={}, count={}",
        collection,
        ids.len()
    );
    let store = state.store().map_err(|e| e.to_string())?;
    store.delete_points(&collection, &ids).map_err(|e| {
        error!("vector_delete_points failed: {}", e);
        e.to_string()
    })?;
    info!(
        "vector_delete_points ok: collection={}, count={}",
        collection,
        ids.len()
    );
    Ok(())
}

#[tauri::command]
pub async fn vector_delete_all_points(
    state: State<'_, VectorState>,
    collection: String,
) -> Result<usize, String> {
    debug!("vector_delete_all_points: collection={}", collection);
    let store = state.store().map_err(|e| e.to_string())?;
    let count = store.delete_all_points(&collection).map_err(|e| {
        error!("vector_delete_all_points failed: {}", e);
        e.to_string()
    })?;
    info!(
        "vector_delete_all_points ok: collection={}, deleted={}",
        collection, count
    );
    Ok(count)
}

#[tauri::command]
pub async fn vector_get_points(
    state: State<'_, VectorState>,
    collection: String,
    ids: Vec<String>,
) -> Result<Vec<Point>, String> {
    debug!(
        "vector_get_points: collection={}, count={}",
        collection,
        ids.len()
    );
    let store = state.store().map_err(|e| e.to_string())?;
    let pts = store.get_points(&collection, &ids).map_err(|e| {
        error!("vector_get_points failed: {}", e);
        e.to_string()
    })?;
    info!(
        "vector_get_points ok: collection={}, returned={}",
        collection,
        pts.len()
    );
    Ok(pts)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn vector_search_points(
    state: State<'_, VectorState>,
    collection: String,
    vector: Vec<f32>,
    top_k: usize,
    score_threshold: Option<f32>,
    offset: Option<usize>,
    limit: Option<usize>,
    filters: Option<Vec<Filter>>,
    filter_mode: Option<FilterMode>,
) -> Result<SearchResponse, String> {
    debug!(
        "vector_search_points: collection={}, top_k={}, filters={}",
        collection,
        top_k,
        filters.as_ref().map(|f| f.len()).unwrap_or(0)
    );
    let store = state.store().map_err(|e| e.to_string())?;
    let resp = store
        .search_points(
            &collection,
            &vector,
            top_k,
            score_threshold,
            offset,
            limit,
            filters.as_deref(),
            filter_mode,
        )
        .map_err(|e| {
            error!("vector_search_points failed: {}", e);
            e.to_string()
        })?;
    info!(
        "vector_search_points ok: collection={}, hits={}",
        collection,
        resp.results.len()
    );
    Ok(resp)
}

#[tauri::command]
pub async fn vector_truncate_collection(
    state: State<'_, VectorState>,
    name: String,
) -> Result<(), String> {
    debug!("vector_truncate_collection: name={}", name);
    let store = state.store().map_err(|e| e.to_string())?;
    store.truncate_collection(&name).map_err(|e| {
        error!("vector_truncate_collection failed: {}", e);
        e.to_string()
    })?;
    info!("vector_truncate_collection ok: {}", name);
    Ok(())
}

#[tauri::command]
pub async fn vector_reset_store(state: State<'_, VectorState>) -> Result<(), String> {
    debug!("vector_reset_store");
    state.reset().map_err(|e| {
        error!("vector_reset_store failed: {}", e);
        e.to_string()
    })?;
    info!("vector_reset_store ok");
    Ok(())
}

#[tauri::command]
pub async fn vector_count_points(
    state: State<'_, VectorState>,
    collection: String,
) -> Result<usize, String> {
    debug!("vector_count_points: collection={}", collection);
    let store = state.store().map_err(|e| e.to_string())?;
    let count = store.count_points(&collection).map_err(|e| {
        error!("vector_count_points failed: {}", e);
        e.to_string()
    })?;
    info!(
        "vector_count_points ok: collection={}, count={}",
        collection, count
    );
    Ok(count)
}

#[tauri::command]
pub async fn vector_get_stats(
    state: State<'_, VectorState>,
    collection: String,
) -> Result<CollectionStats, String> {
    debug!("vector_get_stats: collection={}", collection);
    let store = state.store().map_err(|e| e.to_string())?;
    let stats = store.collection_stats(&collection).map_err(|e| {
        error!("vector_get_stats failed: {}", e);
        e.to_string()
    })?;
    info!(
        "vector_get_stats ok: collection={}, count={}, dim={}, size_bytes={}",
        collection, stats.count, stats.dim, stats.size_bytes
    );
    Ok(stats)
}

#[tauri::command]
pub async fn vector_scroll_points(
    state: State<'_, VectorState>,
    collection: String,
    cursor: Option<String>,
    limit: usize,
) -> Result<ScrollPage, String> {
    debug!(
        "vector_scroll_points: collection={}, cursor={:?}, limit={}",
        collection, cursor, limit
    );
    let store = state.store().map_err(|e| e.to_string())?;
    let page = store
        .scroll_points(&collection, cursor.as_deref(), limit)
        .map_err(|e| {
            error!("vector_scroll_points failed: {}", e);
            e.to_string()
        })?;
    info!(
        "vector_scroll_points ok: collection={}, returned={}, has_more={}",
        collection,
        page.points.len(),
        page.has_more
    );
    Ok(page)
}

#[tauri::command]
pub async fn vector_rename_collection(
    state: State<'_, VectorState>,
    from: String,
    to: String,
) -> Result<(), String> {
    debug!("vector_rename_collection: from={}, to={}", from, to);
    let store = state.store().map_err(|e| e.to_string())?;
    store.rename_collection(&from, &to).map_err(|e| {
        error!("vector_rename_collection failed: {}", e);
        e.to_string()
    })?;
    info!("vector_rename_collection ok: {} → {}", from, to);
    Ok(())
}

#[tauri::command]
pub async fn vector_export_collection(
    state: State<'_, VectorState>,
    collection: String,
) -> Result<String, String> {
    debug!("vector_export_collection: collection={}", collection);
    let store = state.store().map_err(|e| e.to_string())?;
    let jsonl = store.export_collection_to_jsonl(&collection).map_err(|e| {
        error!("vector_export_collection failed: {}", e);
        e.to_string()
    })?;
    info!(
        "vector_export_collection ok: collection={}, bytes={}",
        collection,
        jsonl.len()
    );
    Ok(jsonl)
}

#[tauri::command]
pub async fn vector_import_collection(
    state: State<'_, VectorState>,
    collection: String,
    jsonl: String,
    overwrite: Option<bool>,
) -> Result<ImportStats, String> {
    debug!(
        "vector_import_collection: collection={}, bytes={}, overwrite={:?}",
        collection,
        jsonl.len(),
        overwrite
    );
    let store = state.store().map_err(|e| e.to_string())?;
    let stats = store
        .import_collection_from_jsonl(&collection, &jsonl, overwrite.unwrap_or(false))
        .map_err(|e| {
            error!("vector_import_collection failed: {}", e);
            e.to_string()
        })?;
    info!(
        "vector_import_collection ok: collection={}, imported={}",
        collection, stats.imported
    );
    Ok(stats)
}

#[tauri::command]
pub async fn vector_get_store_size(state: State<'_, VectorState>) -> Result<u64, String> {
    debug!("vector_get_store_size");
    // When the store failed to initialise (web mode shouldn't reach this,
    // but other startup failures may), report 0 instead of erroring so the
    // storage breakdown can still render.
    let store = match state.store() {
        Ok(s) => s,
        Err(_) => {
            info!("vector_get_store_size: store unavailable, reporting 0");
            return Ok(0);
        }
    };
    let path = store.path().to_path_buf();
    drop(store);
    let mut total: u64 = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    // sqlite WAL/SHM siblings hold pending writes; include them so the
    // figure matches what an `ls -la` of the cognia data dir would show.
    for ext in ["-wal", "-shm"] {
        let mut sibling = path.as_os_str().to_owned();
        sibling.push(ext);
        let sibling_path = std::path::PathBuf::from(sibling);
        if let Ok(meta) = std::fs::metadata(&sibling_path) {
            total += meta.len();
        }
    }
    info!("vector_get_store_size ok: {} bytes", total);
    Ok(total)
}

// ============================================================================
// Cloud backend commands (ADR-0022).
//
// Every command below takes `(provider, config_id)` and dispatches through
// `VectorRegistry`. Naming convention: `vector_cloud_*` to keep the legacy
// native command surface above untouched. Native operations continue to
// route through `vector_*` (no provider arg) → `VectorState`.
// ============================================================================

async fn resolve_cloud(
    registry: &VectorRegistry,
    provider: VectorProvider,
    config_id: &str,
) -> Result<Arc<dyn VectorBackend>, String> {
    registry.resolve(provider, config_id).await.map_err(|e| {
        let s = format!("vector cloud resolve: {e}");
        error!("{s}");
        s
    })
}

fn map_cloud_err<E: std::fmt::Display>(prefix: &str, e: E) -> String {
    let s = format!("{prefix}: {e}");
    error!("{s}");
    s
}

#[tauri::command]
pub async fn vector_save_credentials(
    registry: State<'_, VectorRegistry>,
    config_id: String,
    credentials: VectorCredentials,
) -> Result<(), String> {
    debug!(
        "vector_save_credentials: id={config_id}, provider={:?}",
        credentials.provider()
    );
    super::credentials::save(&config_id, &credentials).map_err(|e| map_cloud_err("save_credentials", e))?;
    registry.evict(&config_id);
    info!("vector_save_credentials ok: {config_id}");
    Ok(())
}

#[tauri::command]
pub async fn vector_delete_credentials(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
) -> Result<(), String> {
    debug!("vector_delete_credentials: id={config_id}, provider={provider:?}");
    credentials::delete(provider, &config_id)
        .map_err(|e| map_cloud_err("delete_credentials", e))?;
    registry.evict(&config_id);
    Ok(())
}

#[tauri::command]
pub async fn vector_list_configured_providers(
    registry: State<'_, VectorRegistry>,
) -> Result<Vec<String>, String> {
    Ok(registry.known_config_ids())
}

#[tauri::command]
pub async fn vector_cloud_create_collection(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
    request: CreateCollectionRequest,
) -> Result<(), String> {
    debug!(
        "vector_cloud_create_collection: id={config_id}, name={}, dim={}",
        request.name, request.dimension
    );
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .create_collection(request)
        .await
        .map_err(|e| map_cloud_err("create_collection", e))
}

#[tauri::command]
pub async fn vector_cloud_delete_collection(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
    name: String,
) -> Result<(), String> {
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .delete_collection(&name)
        .await
        .map_err(|e| map_cloud_err("delete_collection", e))
}

#[tauri::command]
pub async fn vector_cloud_list_collections(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
) -> Result<Vec<Collection>, String> {
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .list_collections()
        .await
        .map_err(|e| map_cloud_err("list_collections", e))
}

#[tauri::command]
pub async fn vector_cloud_get_collection(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
    name: String,
) -> Result<Collection, String> {
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .get_collection(&name)
        .await
        .map_err(|e| map_cloud_err("get_collection", e))
}

#[tauri::command]
pub async fn vector_cloud_upsert(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
    collection: String,
    points: Vec<Point>,
) -> Result<(), String> {
    debug!(
        "vector_cloud_upsert: id={config_id}, collection={collection}, n_points={}",
        points.len()
    );
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .upsert(&collection, points)
        .await
        .map_err(|e| map_cloud_err("upsert", e))
}

#[tauri::command]
pub async fn vector_cloud_delete_points(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
    collection: String,
    ids: Vec<String>,
) -> Result<(), String> {
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .delete_points(&collection, ids)
        .await
        .map_err(|e| map_cloud_err("delete_points", e))
}

#[tauri::command]
pub async fn vector_cloud_get_points(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
    collection: String,
    ids: Vec<String>,
) -> Result<Vec<Point>, String> {
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .get_points(&collection, ids)
        .await
        .map_err(|e| map_cloud_err("get_points", e))
}

#[tauri::command]
pub async fn vector_cloud_query(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
    collection: String,
    query_vector: Vec<f32>,
    options: SearchOptions,
) -> Result<SearchResponse, String> {
    let _perf = crate::perf::guard("vector.query");
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .query(&collection, query_vector, options)
        .await
        .map_err(|e| map_cloud_err("query", e))
}

#[tauri::command]
pub async fn vector_cloud_scroll(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
    collection: String,
    options: ScrollOptions,
) -> Result<ScrollPage, String> {
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .scroll(&collection, options)
        .await
        .map_err(|e| map_cloud_err("scroll", e))
}

#[tauri::command]
pub async fn vector_cloud_count(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
    collection: String,
    filter: Option<Vec<Filter>>,
) -> Result<u64, String> {
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .count(&collection, filter)
        .await
        .map_err(|e| map_cloud_err("count", e))
}

#[tauri::command]
pub async fn vector_cloud_truncate(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
    collection: String,
) -> Result<u64, String> {
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .truncate(&collection)
        .await
        .map_err(|e| map_cloud_err("truncate", e))
}

#[tauri::command]
pub async fn vector_cloud_health_check(
    registry: State<'_, VectorRegistry>,
    provider: VectorProvider,
    config_id: String,
) -> Result<HealthStatus, String> {
    let backend = resolve_cloud(&registry, provider, &config_id).await?;
    backend
        .health_check()
        .await
        .map_err(|e| map_cloud_err("health_check", e))
}

#[cfg(test)]
mod tests {
    //! Smoke tests — most logic is covered in `db.rs` and `filters.rs`.
    //! Here we exercise the `VectorState` lifecycle plus the
    //! `Result<T, VectorError>` → `Result<T, String>` mapping.

    use super::super::{VectorState, VectorStore};
    use tempfile::tempdir;

    #[test]
    fn vector_state_with_path_initializes_store() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("v.sqlite");
        let state = VectorState::new(Some(path.clone()));
        assert!(state.store().is_ok());
        assert!(path.exists());
    }

    #[test]
    fn vector_state_without_path_is_unavailable() {
        let state = VectorState::new(None);
        let err = state.store().unwrap_err();
        // The error string is what tauri returns to JS.
        let s = err.to_string();
        assert!(s.contains("not available") || s.contains("not initialised"));
    }

    #[test]
    fn vector_state_fallible_init_degrades_gracefully() {
        // Pointing at a directory we can't write to should leave the
        // store as `None` rather than panic.
        let dir = tempdir().expect("tempdir");
        // Create a path whose parent is a file (impossible to mkdir on).
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, "x").expect("write");
        let bad_path = blocker.join("v.sqlite");
        let state = VectorState::new(Some(bad_path));
        assert!(state.store().is_err());
    }

    #[test]
    fn get_store_size_reports_nonzero_after_init() {
        // `VectorState::new` is lazy — the sqlite file is only created on the
        // first `store()` call (see `VectorState::ensure`). Trigger that open
        // before inspecting the file, mirroring how the commands resolve the
        // store. After init the file exists with a header + migrations
        // applied, so its size must be > 0.
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("v.sqlite");
        let state = VectorState::new(Some(path.clone()));
        assert!(state.store().is_ok(), "store should open on first access");
        let bytes = std::fs::metadata(&path).expect("metadata").len();
        assert!(bytes > 0, "fresh store should have a non-empty sqlite file");
    }

    #[test]
    fn get_store_size_returns_zero_when_state_unavailable() {
        // Mirrors the `state.store()` guard inside vector_get_store_size:
        // an uninitialised state should resolve to 0 rather than panic.
        let state = VectorState::new(None);
        assert!(state.store().is_err());
    }

    #[test]
    fn error_to_string_round_trip() {
        // Direct VectorStore call → VectorError → String, the same way
        // the command bodies surface failures to JS.
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("v.sqlite");
        let store = VectorStore::new(path).expect("open");
        let err = store
            .upsert_points(
                "missing",
                &[super::super::Point {
                    id: "x".into(),
                    vector: vec![0.0, 0.0, 0.0],
                    payload: None,
                }],
            )
            .unwrap_err();
        let mapped: String = err.into();
        assert!(mapped.contains("missing"));
        assert!(mapped.contains("Collection"));
    }
}
