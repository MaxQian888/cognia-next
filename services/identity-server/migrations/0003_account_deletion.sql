-- Account deletion requests (ADR-0215 §10, grill Q12): a 7-day cooling-off
-- period, then the identity is purged by the hourly cron (src/deletion/).
--
-- Not a Better Auth table and deliberately without a foreign key to "user":
-- the row outlives the purge as the record that it happened.
CREATE TABLE "account_deletion" (
  "user_id" TEXT NOT NULL PRIMARY KEY,
  "status" TEXT NOT NULL CHECK ("status" IN ('pending', 'cancelled', 'purged')),
  "requested_at" TEXT NOT NULL,
  "purge_after" TEXT NOT NULL,
  "cancelled_at" TEXT,
  "purged_at" TEXT
);

CREATE INDEX "account_deletion_due_idx" ON "account_deletion" ("status", "purge_after");
