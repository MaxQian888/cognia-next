/**
 * Minimal migration runner. Applies migrations/NNNN_name.sql in order and
 * records them in schema_migrations. Re-running is idempotent; a version
 * that re-appears with different content is reported as schema drift.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256Hex, utcNowIso, WorkbenchError, ERROR_CODES } from "@latexwb/contracts";
import { inTransaction } from "./db.ts";

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export function migrate(db: DatabaseSync, migrationsDir: string): AppliedMigration[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const appliedStmt = db.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  const existing = new Map<number, { name: string; checksum: string }>();
  for (const row of appliedStmt.all() as Array<Record<string, unknown>>) {
    existing.set(row["version"] as number, {
      name: row["name"] as string,
      checksum: row["checksum"] as string,
    });
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const appliedNow: AppliedMigration[] = [];
  const insertStmt = db.prepare(
    "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?,?,?,?)",
  );

  for (const file of files) {
    const version = Number.parseInt(file.split("_")[0] ?? "", 10);
    if (!Number.isInteger(version)) {
      throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `bad migration filename: ${file}`);
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const checksum = sha256Hex(sql);

    const prior = existing.get(version);
    if (prior !== undefined) {
      if (prior.checksum !== checksum) {
        throw new WorkbenchError(
          ERROR_CODES.MIGRATION_CHECKSUM_MISMATCH,
          `migration ${file} content changed after it was applied (stored ${prior.checksum}, current ${checksum})`,
        );
      }
      continue;
    }

    inTransaction(db, () => {
      db.exec(sql);
      insertStmt.run(version, file, checksum, utcNowIso());
    });
    appliedNow.push({ version, name: file, checksum });
  }
  return appliedNow;
}
