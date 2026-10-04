-- Initial SQLite schema proposal. Executable DDL, not a complete persistence service.
-- Every connection MUST enable foreign_keys. Use transactions and CAS in services.
PRAGMA foreign_keys = ON;
CREATE TABLE projects (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  head_snapshot_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  event_seq INTEGER NOT NULL DEFAULT 0 CHECK(event_seq >= 0),
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id),
  FOREIGN KEY(workspace_id,project_id,head_snapshot_id)
    REFERENCES snapshots(workspace_id,project_id,snapshot_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE snapshots (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  parent_snapshot_id TEXT, tree_hash TEXT NOT NULL CHECK(length(tree_hash)=64),
  manifest_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,snapshot_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,project_id),
  FOREIGN KEY(workspace_id,project_id,parent_snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id)
);
CREATE TABLE snapshot_files (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  path TEXT NOT NULL, blob_hash TEXT NOT NULL CHECK(length(blob_hash)=64),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0), role TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,snapshot_id,path),
  FOREIGN KEY(workspace_id,project_id,snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id)
);
CREATE TABLE targets (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, target_id TEXT NOT NULL,
  config_json TEXT NOT NULL, config_hash TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,target_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,project_id)
);
CREATE TABLE patches (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, patch_id TEXT NOT NULL,
  base_snapshot_id TEXT NOT NULL, result_snapshot_id TEXT, patch_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('proposed','waiting-approval','applied','rejected','conflict')),
  operations_json TEXT NOT NULL, protected_changes_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,patch_id),
  FOREIGN KEY(workspace_id,project_id,base_snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id),
  FOREIGN KEY(workspace_id,project_id,result_snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id)
);
CREATE TABLE jobs (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, snapshot_id TEXT, target_id TEXT,
  state TEXT NOT NULL CHECK(state IN('queued','running','cancel-requested','succeeded','failed','cancelled','timed-out','lost')),
  action TEXT NOT NULL, input_digest TEXT NOT NULL, input_json TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt>=1), parent_job_id TEXT,
  lease_owner TEXT, lease_expires_at TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
  cancel_requested_at TEXT, result_json TEXT, error_code TEXT,
  created_at TEXT NOT NULL, finished_at TEXT,
  PRIMARY KEY(workspace_id,project_id,job_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,project_id),
  FOREIGN KEY(workspace_id,project_id,snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id),
  FOREIGN KEY(workspace_id,project_id,target_id) REFERENCES targets(workspace_id,project_id,target_id),
  FOREIGN KEY(workspace_id,project_id,parent_job_id) REFERENCES jobs(workspace_id,project_id,job_id)
);
CREATE INDEX job_queue ON jobs(state,created_at);
CREATE TABLE job_events (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq>0), event_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,job_id,seq),
  FOREIGN KEY(workspace_id,project_id,job_id) REFERENCES jobs(workspace_id,project_id,job_id)
);
CREATE TABLE artifacts (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, target_id TEXT, job_id TEXT NOT NULL,
  kind TEXT NOT NULL, blob_hash TEXT NOT NULL CHECK(length(blob_hash)=64),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0), media_type TEXT NOT NULL,
  manifest_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,artifact_id),
  UNIQUE(workspace_id,project_id,artifact_id,snapshot_id),
  FOREIGN KEY(workspace_id,project_id,snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id),
  FOREIGN KEY(workspace_id,project_id,job_id) REFERENCES jobs(workspace_id,project_id,job_id),
  FOREIGN KEY(workspace_id,project_id,target_id) REFERENCES targets(workspace_id,project_id,target_id)
);
CREATE TABLE checks (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, check_run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, check_id TEXT NOT NULL,
  check_version TEXT NOT NULL, input_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('pass','fail','not-applicable','unsupported','needs-review')),
  result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,check_run_id),
  FOREIGN KEY(workspace_id,project_id,artifact_id,snapshot_id) REFERENCES artifacts(workspace_id,project_id,artifact_id,snapshot_id)
);
CREATE TABLE reviews (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, review_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, input_digest TEXT NOT NULL,
  reviewer_id TEXT NOT NULL, reviewer_kind TEXT NOT NULL CHECK(reviewer_kind IN('human','model')),
  result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,review_id),
  FOREIGN KEY(workspace_id,project_id,artifact_id,snapshot_id) REFERENCES artifacts(workspace_id,project_id,artifact_id,snapshot_id)
);
CREATE TABLE approvals (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, approval_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, action TEXT NOT NULL, scope_digest TEXT NOT NULL,
  base_snapshot_id TEXT NOT NULL, policy_id TEXT NOT NULL, expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('granted','revoked','expired','consumed')),
  record_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,approval_id),
  FOREIGN KEY(workspace_id,project_id,base_snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id)
);
CREATE TABLE workflows (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
  definition_id TEXT NOT NULL, definition_hash TEXT NOT NULL, current_node TEXT NOT NULL,
  state TEXT NOT NULL, context_json TEXT NOT NULL, budget_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,workflow_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,project_id)
);
CREATE TABLE workflow_steps (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL, node_id TEXT NOT NULL, input_digest TEXT NOT NULL,
  state TEXT NOT NULL, result_json TEXT, job_id TEXT,
  PRIMARY KEY(workspace_id,project_id,workflow_id,step_run_id),
  FOREIGN KEY(workspace_id,project_id,workflow_id) REFERENCES workflows(workspace_id,project_id,workflow_id),
  FOREIGN KEY(workspace_id,project_id,job_id) REFERENCES jobs(workspace_id,project_id,job_id)
);
CREATE TABLE evidence (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, kind TEXT NOT NULL, source_locator TEXT NOT NULL,
  content_hash TEXT NOT NULL, access_status TEXT NOT NULL, record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,evidence_id),
  FOREIGN KEY(workspace_id,project_id,snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id)
);
CREATE TABLE releases (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, release_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('draft','review-ready','submission-ready','blocked')),
  manifest_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,release_id),
  FOREIGN KEY(workspace_id,project_id,snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id),
  FOREIGN KEY(workspace_id,project_id,target_id) REFERENCES targets(workspace_id,project_id,target_id)
);
CREATE TABLE idempotency_records (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, action TEXT NOT NULL, input_digest TEXT NOT NULL,
  state TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,principal_id,idempotency_key),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,project_id)
);
CREATE TABLE audit_events (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, event_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, action TEXT NOT NULL, resource_id TEXT,
  outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,event_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,project_id)
);
CREATE TABLE materialization_journals (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, journal_id TEXT NOT NULL,
  from_snapshot_id TEXT NOT NULL, to_snapshot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('prepared','applying','completed','rolling-back','conflict')),
  items_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,journal_id),
  FOREIGN KEY(workspace_id,project_id,from_snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id),
  FOREIGN KEY(workspace_id,project_id,to_snapshot_id) REFERENCES snapshots(workspace_id,project_id,snapshot_id)
);

-- Transactional project-wide event outbox. seq is allocated by updating
-- projects.event_seq in the SAME transaction as the state change.
CREATE TABLE project_events (
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq>0), job_id TEXT,
  event_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,project_id,seq),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,project_id),
  FOREIGN KEY(workspace_id,project_id,job_id) REFERENCES jobs(workspace_id,project_id,job_id)
);
