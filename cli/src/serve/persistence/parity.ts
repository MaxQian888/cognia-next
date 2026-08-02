/**
 * Migration parity gate.
 *
 * A backend switch is only allowed once the candidate proves it holds *exactly*
 * what the incumbent holds. Four independent checks, cheapest first, because
 * each catches a different class of migration bug:
 *
 * | Check | Catches |
 * | --- | --- |
 * | schema version | a migration run against a different Dexie version |
 * | row count | a partial copy that stopped early |
 * | key set | rows copied under a different key encoding |
 * | content hash | values silently mangled by (de)serialisation |
 *
 * The report is data, not a throw: `durability migrate` prints every mismatch
 * before refusing, so an operator sees the whole picture in one pass.
 */
import { hashRows } from "./canonical"
import type { DurabilityState } from "./types"

export type ParityMismatchKind =
  | "database-missing"
  | "database-unexpected"
  | "schema-version"
  | "table-set"
  | "row-count"
  | "key-set"
  | "content-hash"
  | "sequence"

export interface ParityMismatch {
  kind: ParityMismatchKind
  database: string | null
  table: string | null
  expected: string
  actual: string
}

export interface ParityReport {
  ok: boolean
  mismatches: ParityMismatch[]
  /** Rows compared on the source side — printed so an empty run is obvious. */
  comparedRows: number
}

export function verifyParity(source: DurabilityState, candidate: DurabilityState): ParityReport {
  const mismatches: ParityMismatch[] = []
  let comparedRows = 0

  if (source.sequence !== candidate.sequence) {
    mismatches.push({
      kind: "sequence",
      database: null,
      table: null,
      expected: String(source.sequence),
      actual: String(candidate.sequence),
    })
  }

  for (const database of Object.keys(candidate.dbs)) {
    if (!source.dbs[database]) {
      mismatches.push({
        kind: "database-unexpected",
        database,
        table: null,
        expected: "absent",
        actual: "present",
      })
    }
  }

  for (const [database, sourceEntry] of Object.entries(source.dbs)) {
    const candidateEntry = candidate.dbs[database]
    if (!candidateEntry) {
      mismatches.push({
        kind: "database-missing",
        database,
        table: null,
        expected: "present",
        actual: "absent",
      })
      continue
    }
    if (sourceEntry.schema.version !== candidateEntry.schema.version) {
      mismatches.push({
        kind: "schema-version",
        database,
        table: null,
        expected: String(sourceEntry.schema.version),
        actual: String(candidateEntry.schema.version),
      })
    }
    const sourceTables = [...sourceEntry.schema.tables].sort()
    const candidateTables = [...candidateEntry.schema.tables].sort()
    if (sourceTables.join(",") !== candidateTables.join(",")) {
      mismatches.push({
        kind: "table-set",
        database,
        table: null,
        expected: sourceTables.join(","),
        actual: candidateTables.join(","),
      })
    }
    for (const table of sourceTables) {
      const sourceRows = sourceEntry.rows[table] ?? {}
      const candidateRows = candidateEntry.rows[table] ?? {}
      const sourceKeys = Object.keys(sourceRows).sort()
      const candidateKeys = Object.keys(candidateRows).sort()
      comparedRows += sourceKeys.length
      if (sourceKeys.length !== candidateKeys.length) {
        mismatches.push({
          kind: "row-count",
          database,
          table,
          expected: String(sourceKeys.length),
          actual: String(candidateKeys.length),
        })
      }
      const missing = sourceKeys.filter((key) => !(key in candidateRows))
      const extra = candidateKeys.filter((key) => !(key in sourceRows))
      if (missing.length > 0 || extra.length > 0) {
        mismatches.push({
          kind: "key-set",
          database,
          table,
          expected: `missing ${missing.length}`,
          actual: `extra ${extra.length}`,
        })
        // A differing key set makes the content hash uninformative; skip it.
        continue
      }
      const sourceHash = hashRows(sourceRows)
      const candidateHash = hashRows(candidateRows)
      if (sourceHash !== candidateHash) {
        mismatches.push({
          kind: "content-hash",
          database,
          table,
          expected: sourceHash,
          actual: candidateHash,
        })
      }
    }
  }

  return { ok: mismatches.length === 0, mismatches, comparedRows }
}

export function formatParityReport(report: ParityReport): string {
  if (report.ok) return `parity ok (${report.comparedRows} rows compared)`
  const lines = report.mismatches.map((mismatch) => {
    const where = [mismatch.database, mismatch.table].filter(Boolean).join(".")
    return `  ${mismatch.kind}${where ? ` at ${where}` : ""}: expected ${mismatch.expected}, got ${mismatch.actual}`
  })
  return [`parity FAILED (${report.mismatches.length} mismatches)`, ...lines].join("\n")
}
