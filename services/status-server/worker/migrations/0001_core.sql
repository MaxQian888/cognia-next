-- Cognia public status service: core schema (owner B).
--
-- Immutable observations plus rebuildable projections. Incidents/maintenance
-- live in 0002, subscriptions/notifications in 0003 (owner E). Additive only:
-- a later change adds a new numbered file and never rewrites this one.
--
-- Storage is deliberately compact for the D1 Free allowance (100k rows
-- written/day): one row per probe run with its checks inline, one row per
-- reference minute with the three component results as columns, hourly and
-- daily rollups as JSON, and one precomputed snapshot row per history range.
-- See the plan's "Deviations" section for the budget arithmetic.
--
-- Times are integer milliseconds since the Unix epoch (UTC). `*_minute`,
-- `hour` and `day` columns are floor(ms / unit).

-- ---------------------------------------------------------------------------
-- Monotonic counters (registry revision, snapshot revision, dirty sequence).
-- ---------------------------------------------------------------------------
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters (name, value) VALUES
  ('registry_revision', 0),
  ('snapshot_revision', 0),
  ('dirty_seq', 0);

-- ---------------------------------------------------------------------------
-- Probe registry. Location/provider come from here, never from payloads.
-- ---------------------------------------------------------------------------
CREATE TABLE probes (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('external', 'cloudflare')),
  label_json TEXT NOT NULL,
  location_json TEXT,
  provider TEXT,
  enrolled_at INTEGER NOT NULL,
  retired_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  disabled_reason TEXT,
  registry_revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Which profiles a probe runs and how often. A null cadence means that
-- check class is not run for the profile (Origin profiles skip HTTP).
CREATE TABLE probe_profiles (
  probe_id TEXT NOT NULL REFERENCES probes (id),
  profile_id TEXT NOT NULL CHECK (profile_id IN ('native', 'web', 'ios', 'android')),
  http_cadence_seconds INTEGER CHECK (http_cadence_seconds IS NULL OR http_cadence_seconds >= 60),
  protocol_cadence_seconds INTEGER CHECK (protocol_cadence_seconds IS NULL OR protocol_cadence_seconds >= 60),
  PRIMARY KEY (probe_id, profile_id)
);

-- Signing key IDs per probe. Secret material lives in the PROBE_SECRETS
-- Worker secret, keyed by key_id; this table decides which probe a key may
-- speak for and when. Two keys may overlap during a bounded rotation.
CREATE TABLE probe_keys (
  key_id TEXT PRIMARY KEY,
  probe_id TEXT NOT NULL REFERENCES probes (id),
  not_before INTEGER NOT NULL,
  not_after INTEGER,
  revoked_at INTEGER
);
CREATE INDEX probe_keys_by_probe ON probe_keys (probe_id);

-- Reference epochs: the reference observer for minute m is the epoch with
-- the greatest effective_minute <= m. A change takes effect at a future
-- minute boundary and never rewrites earlier history.
CREATE TABLE reference_epochs (
  revision INTEGER PRIMARY KEY,
  probe_id TEXT NOT NULL REFERENCES probes (id),
  effective_minute INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Observations (immutable; raw retention 14 days).
-- ---------------------------------------------------------------------------
CREATE TABLE probe_runs (
  probe_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  registry_revision INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  scheduled_minute INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  -- SHA-256 of the canonical validated batch; same identity + different
  -- digest is a conflicting replay (409).
  body_digest TEXT NOT NULL,
  -- Validated CheckObservation[] with unique check IDs.
  checks_json TEXT NOT NULL,
  PRIMARY KEY (probe_id, run_id)
);
CREATE INDEX probe_runs_by_profile_time ON probe_runs (probe_id, profile_id, scheduled_at);
CREATE INDEX probe_runs_by_received ON probe_runs (received_at);

-- One row per reference minute (retention 90 days). First observation for a
-- minute wins; a later run for the same minute never replaces it.
CREATE TABLE reference_slots (
  minute INTEGER PRIMARY KEY,
  reference_revision INTEGER NOT NULL,
  probe_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  http TEXT NOT NULL CHECK (http IN ('pass', 'fail', 'unknown')),
  auth TEXT NOT NULL CHECK (auth IN ('pass', 'fail', 'unknown')),
  data TEXT NOT NULL CHECK (data IN ('pass', 'fail', 'unknown')),
  http_ms INTEGER,
  auth_ms INTEGER,
  data_ms INTEGER,
  http_reason TEXT,
  auth_reason TEXT,
  data_reason TEXT,
  received_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Projections (rebuildable from reference_slots + maintenance windows).
-- ---------------------------------------------------------------------------
-- Hours whose rollup must be rebuilt. `seq` is the dirty sequence at marking;
-- a rebuild deletes the row only if `seq` is unchanged, so work that arrived
-- during the rebuild is never lost.
CREATE TABLE dirty_hours (
  hour INTEGER PRIMARY KEY,
  seq INTEGER NOT NULL
);

CREATE TABLE hourly_rollups (
  hour INTEGER PRIMARY KEY,
  source_seq INTEGER NOT NULL,
  rollup_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE daily_rollups (
  day INTEGER PRIMARY KEY,
  source_seq INTEGER NOT NULL,
  rollup_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE snapshots (
  range TEXT PRIMARY KEY CHECK (range IN ('24h', '7d', '30d', '90d')),
  revision INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  etag TEXT NOT NULL,
  body TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Job leases with monotonic fences. Every committing write of a job checks
-- its fence, so a runner that lost its lease cannot publish.
-- ---------------------------------------------------------------------------
CREATE TABLE leases (
  job TEXT PRIMARY KEY,
  owner TEXT,
  fence INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO leases (job) VALUES ('aggregate'), ('delivery'), ('retention');

-- ---------------------------------------------------------------------------
-- Operator idempotency and audit (shared by every administrative write).
-- ---------------------------------------------------------------------------
CREATE TABLE admin_operations (
  operation_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_operations_by_created ON admin_operations (created_at);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  revision INTEGER,
  detail_json TEXT
);
CREATE INDEX audit_events_by_at ON audit_events (at);
