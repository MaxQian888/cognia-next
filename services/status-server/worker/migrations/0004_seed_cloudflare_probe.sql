-- Register the Cloudflare Cron observer (owner B).
--
-- Seeds configuration only, never health. Without an external host yet, the
-- Cron observer is the designated reference (registry revision 1): every
-- check at 60 s on the native (no Origin) profile, plus 300 s simulated
-- Origin profiles. When an external probe is enrolled, `probe set-reference`
-- moves the reference at a future minute boundary and the Cron protocol
-- cadence drops to the plan's 300 s corroboration.
--
-- Enrollment starts at the next whole minute after the migration runs:
-- minutes between this migration and the first Cron run show as unknown
-- coverage, which is the truth.

UPDATE counters SET value = 1 WHERE name = 'registry_revision';

INSERT INTO probes (id, source, label_json, location_json, provider, enrolled_at, registry_revision, updated_at)
VALUES (
  'cf-cron',
  'cloudflare',
  '{"en":"Cloudflare scheduled check","zh-CN":"Cloudflare 定时检查"}',
  NULL,
  'Cloudflare Workers',
  (CAST(strftime('%s', 'now') AS INTEGER) / 60 + 1) * 60000,
  1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

INSERT INTO probe_profiles (probe_id, profile_id, http_cadence_seconds, protocol_cadence_seconds) VALUES
  ('cf-cron', 'native', 60, 60),
  ('cf-cron', 'web', NULL, 300),
  ('cf-cron', 'ios', NULL, 300),
  ('cf-cron', 'android', NULL, 300);

INSERT INTO reference_epochs (revision, probe_id, effective_minute, created_at, actor, reason)
VALUES (
  1,
  'cf-cron',
  CAST(strftime('%s', 'now') AS INTEGER) / 60 + 1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  'migration',
  'Initial reference: no external probe enrolled yet'
);
