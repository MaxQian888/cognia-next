ALTER TABLE alert_deliveries
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

DROP INDEX alert_deliveries_due_idx;
CREATE INDEX alert_deliveries_due_idx
    ON alert_deliveries (tenant_id, next_attempt_at, created_at)
    WHERE state IN ('pending', 'failed', 'sending');

