-- Cognia public status service: incidents and maintenance (owner E).
--
-- Additive to 0001. Every public change is an append-only update row plus a
-- revision bump on the parent; a write that lost its compare-and-swap must
-- not append anything, so every statement of one write is guarded on the
-- parent's `write_token` (a random value the guarded UPDATE sets).
--
-- Times are integer milliseconds since the Unix epoch (UTC).

-- ---------------------------------------------------------------------------
-- Incidents.
-- ---------------------------------------------------------------------------
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  title_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('investigating', 'identified', 'monitoring', 'resolved')),
  impact TEXT NOT NULL CHECK (impact IN ('degraded', 'partial_outage', 'major_outage')),
  component_ids_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'automated')),
  -- Automated incidents: the component ID they track. One open incident per
  -- fingerprint (partial unique index below). Manual incidents: NULL.
  fingerprint TEXT,
  -- Manual ownership: automation never changes a pinned incident.
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  manual_owner TEXT,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  -- The resolved incident this one follows when a failure recurred.
  predecessor_id TEXT REFERENCES incidents (id),
  -- Random per write; dependent statements of the same batch check it.
  write_token TEXT NOT NULL,
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX incidents_open_fingerprint ON incidents (fingerprint)
  WHERE resolved_at IS NULL AND fingerprint IS NOT NULL;
CREATE INDEX incidents_by_started ON incidents (started_at DESC, id DESC);
CREATE INDEX incidents_by_resolved ON incidents (resolved_at);
CREATE INDEX incidents_by_fingerprint_resolved ON incidents (fingerprint, resolved_at);

-- Append-only public updates, oldest first by `seq`.
CREATE TABLE incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('investigating', 'identified', 'monitoring', 'resolved')),
  impact TEXT NOT NULL CHECK (impact IN ('degraded', 'partial_outage', 'major_outage')),
  component_ids_json TEXT NOT NULL,
  message_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'automated')),
  at INTEGER NOT NULL,
  -- Newest evidence the update was based on (automated updates).
  evidence_at INTEGER,
  -- The earlier update whose text this one corrects.
  correction_of TEXT REFERENCES incident_updates (id),
  UNIQUE (incident_id, seq)
);

-- ---------------------------------------------------------------------------
-- Maintenance windows. Minute-aligned half-open [starts_at, ends_at).
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance (
  id TEXT PRIMARY KEY,
  title_json TEXT NOT NULL,
  description_json TEXT NOT NULL,
  component_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('scheduled', 'in_progress', 'awaiting_confirmation', 'completed', 'cancelled')
  ),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  -- Operator-confirmed completion time, distinct from the planned end.
  actual_end_at INTEGER,
  exclude_from_availability INTEGER NOT NULL CHECK (exclude_from_availability IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  write_token TEXT NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK (starts_at % 60000 = 0 AND ends_at % 60000 = 0)
);
CREATE INDEX maintenance_by_state_start ON maintenance (state, starts_at);
CREATE INDEX maintenance_by_window ON maintenance (starts_at, ends_at);
CREATE INDEX maintenance_by_updated ON maintenance (updated_at);

CREATE TABLE maintenance_updates (
  id TEXT PRIMARY KEY,
  maintenance_id TEXT NOT NULL REFERENCES maintenance (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('scheduled', 'started', 'extended', 'rescheduled', 'awaiting_confirmation', 'completed', 'cancelled', 'note')
  ),
  message_json TEXT,
  at INTEGER NOT NULL,
  -- The window's revision after this update.
  revision INTEGER NOT NULL,
  UNIQUE (maintenance_id, seq)
);
