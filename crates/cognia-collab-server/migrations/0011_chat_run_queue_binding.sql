-- A claim retry must name the same queue item as the durable lease. Historical
-- and direct leases stay NULL: guessing their input would permit replay of a
-- different request. The service rejects queue-claim replay for those rows.
ALTER TABLE chat_run_leases ADD COLUMN IF NOT EXISTS queue_item_id text;

CREATE UNIQUE INDEX IF NOT EXISTS chat_run_queue_scope_id
    ON chat_run_queue (org_id, session_id, id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chat_run_leases_queue_item_fk'
          AND conrelid = 'chat_run_leases'::regclass
    ) THEN
        ALTER TABLE chat_run_leases
            ADD CONSTRAINT chat_run_leases_queue_item_fk
            FOREIGN KEY (org_id, session_id, queue_item_id)
            REFERENCES chat_run_queue (org_id, session_id, id);
    END IF;
END $$;
