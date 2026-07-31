//! Versioned schema migrations for the native vector store.
//!
//! Each migration is a `(version, sql_batch)` tuple. `db.rs::run_migrations`
//! reads the current `migration_meta.version`, then applies every newer
//! tuple in its own transaction, recording the version on success.
//!
//! Per-collection `vec_<id>` virtual tables are NOT created here — they
//! depend on the runtime-known dimension and are created in
//! `db.rs::create_collection`.

/// Initial schema. Source: spec §"Appendix: SQL schema (initial migration v1)".
const V1_INITIAL: &str = r#"
CREATE TABLE IF NOT EXISTS migration_meta (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL UNIQUE,
    dim                 INTEGER NOT NULL,
    description         TEXT,
    embedding_model     TEXT,
    embedding_provider  TEXT,
    metadata_json       TEXT,
    point_count         INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points (
    rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
    id             TEXT NOT NULL,
    collection_id  INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    content        TEXT NOT NULL,
    payload_json   TEXT,
    UNIQUE(collection_id, id)
);

CREATE INDEX IF NOT EXISTS idx_points_collection ON points(collection_id);
CREATE INDEX IF NOT EXISTS idx_points_id ON points(id);
"#;

/// Ordered list of migrations. Append new tuples as `(N, sql)`; never edit
/// existing entries.
pub const MIGRATIONS: &[(u32, &str)] = &[(1, V1_INITIAL)];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_sorted_and_unique() {
        let mut prev: Option<u32> = None;
        for (v, _) in MIGRATIONS {
            if let Some(p) = prev {
                assert!(*v > p, "migrations must be strictly increasing");
            }
            prev = Some(*v);
        }
    }

    #[test]
    fn v1_contains_required_tables() {
        let (_, sql) = MIGRATIONS[0];
        assert!(sql.contains("migration_meta"));
        assert!(sql.contains("collections"));
        assert!(sql.contains("points"));
        assert!(sql.contains("idx_points_collection"));
    }
}
