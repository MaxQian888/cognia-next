-- 0003: move the registered import root out of ProjectConfig into a
-- host-owned column. ProjectConfig is the object a project-supplied config
-- file would populate, so it must never carry host permissions; the import
-- root authorizes host filesystem writes and belongs to the host alone.
ALTER TABLE projects ADD COLUMN host_root TEXT;
-- Backfill rows whose config_json still carries the field (pre-0003), then
-- strip it from config so the contract object stays clean.
UPDATE projects SET host_root = json_extract(config_json, '$.hostRoot')
  WHERE json_extract(config_json, '$.hostRoot') IS NOT NULL;
UPDATE projects SET config_json = json_remove(config_json, '$.hostRoot')
  WHERE json_extract(config_json, '$.hostRoot') IS NOT NULL;
