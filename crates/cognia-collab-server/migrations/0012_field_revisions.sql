-- ADR-0208: per-field revisions for field-level merge.
--
-- `field_revisions` maps a field name to the revision at which it last
-- changed and who changed it: {"status": {"revision": 7, "by": "usr_…"}}.
-- The first tracked write also records "$since": the revision before it.
-- Every later change is stamped, so an unstamped field last changed at or
-- before "$since". A row without the marker predates tracking: a stale base
-- clashes on every field it names, which is the pre-0208 behaviour, until the
-- row's first tracked write. No backfill is needed.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS field_revisions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS field_revisions jsonb NOT NULL DEFAULT '{}'::jsonb;
