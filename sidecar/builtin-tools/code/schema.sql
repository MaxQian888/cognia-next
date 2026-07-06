-- Code-graph SQLite schema (ported from colbymchenry/codegraph).
-- Executed once at store init; PRAGMA user_version gates future migrations.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS files (
  path          TEXT PRIMARY KEY,
  content_hash  TEXT,
  language      TEXT,
  size          INTEGER,
  modified_at   INTEGER,
  indexed_at    INTEGER,
  node_count    INTEGER,
  errors        TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  language       TEXT,
  start_line     INTEGER,
  start_col      INTEGER,
  end_line       INTEGER,
  end_col        INTEGER,
  docstring      TEXT,
  signature      TEXT,
  visibility     TEXT,
  is_exported    INTEGER DEFAULT 0,
  is_async       INTEGER DEFAULT 0,
  is_static      INTEGER DEFAULT 0,
  return_type    TEXT,
  updated_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qname ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);

CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  target      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  metadata    TEXT,
  line        INTEGER,
  col         INTEGER,
  provenance  TEXT
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);

CREATE TABLE IF NOT EXISTS unresolved_refs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_node_id    TEXT NOT NULL,
  reference_name  TEXT NOT NULL,
  reference_kind  TEXT NOT NULL,
  line            INTEGER,
  col             INTEGER,
  candidates      TEXT,
  file_path       TEXT NOT NULL,
  language        TEXT
);

CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_file ON unresolved_refs(file_path);

-- Full-text search over symbol identity + docs, kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name,
  qualified_name,
  docstring,
  signature,
  content = 'nodes',
  content_rowid = 'rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, qualified_name, docstring, signature)
  VALUES (new.rowid, new.name, new.qualified_name, new.docstring, new.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, docstring, signature)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.docstring, old.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, docstring, signature)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.docstring, old.signature);
  INSERT INTO nodes_fts(rowid, name, qualified_name, docstring, signature)
  VALUES (new.rowid, new.name, new.qualified_name, new.docstring, new.signature);
END;
