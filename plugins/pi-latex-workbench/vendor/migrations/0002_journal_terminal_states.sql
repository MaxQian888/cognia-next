-- 0002: extend materialization journal terminal states and add detail_json.
-- 'rolled-back' = interrupted apply fully reverted from backups;
-- 'unrestorable' = rollback was impossible for the paths listed in
-- detail_json (the host directory must not be trusted as baseline).
CREATE TABLE materialization_journals_v2 (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, journal_id TEXT NOT NULL,
  from_snapshot_id TEXT NOT NULL, to_snapshot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('prepared','applying','rolling-back','completed','conflict','rolled-back','unrestorable')),
  items_json TEXT NOT NULL, detail_json TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,journal_id),
  FOREIGN KEY(workspace_id,project_id,from_snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id),
  FOREIGN KEY(workspace_id,project_id,to_snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id)
);
INSERT INTO materialization_journals_v2(workspace_id,project_id,journal_id,
  from_snapshot_id,to_snapshot_id,state,items_json,created_at)
  SELECT workspace_id,project_id,journal_id,from_snapshot_id,to_snapshot_id,
    state,items_json,created_at FROM materialization_journals;
DROP TABLE materialization_journals;
ALTER TABLE materialization_journals_v2 RENAME TO materialization_journals;
