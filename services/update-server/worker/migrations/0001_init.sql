-- Update control plane schema.
--
-- Binaries are never stored here. They stay in GitHub Releases, the App Store,
-- Google Play, the extension stores and npm. This database holds only the
-- pointers, the rollout state, and the signed metadata bundles.

-- One published release per asset, platform, arch and channel.
CREATE TABLE IF NOT EXISTS releases (
  id            TEXT PRIMARY KEY,
  asset_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  channel       TEXT NOT NULL,
  version       TEXT NOT NULL,
  target        TEXT NOT NULL DEFAULT '',
  arch          TEXT NOT NULL DEFAULT '',
  -- 'staged' is invisible to clients. Only 'rolling' is ever offered.
  state         TEXT NOT NULL DEFAULT 'staged',
  rollout       INTEGER NOT NULL DEFAULT 0,
  criticality   TEXT NOT NULL DEFAULT 'routine',
  notes         TEXT,
  pub_date      TEXT NOT NULL,
  url           TEXT,
  signature     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS releases_identity
  ON releases (asset_id, kind, channel, version, target, arch);
CREATE INDEX IF NOT EXISTS releases_lookup
  ON releases (kind, channel, target, arch, state);

-- Signed TUF-style metadata bundles, one current row per channel. The Worker
-- never signs anything: CI uploads bundles that were signed offline, and this
-- table only decides which one is current.
CREATE TABLE IF NOT EXISTS catalogs (
  channel         TEXT PRIMARY KEY,
  targets_version INTEGER NOT NULL,
  bundle          TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Append-only operator log. Every promote, pause, abort and revoke lands here.
CREATE TABLE IF NOT EXISTS release_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  actor      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS release_events_by_release ON release_events (release_id, id);
