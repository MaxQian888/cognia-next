import { formatParityReport, verifyParity } from "./parity"
import type { DurabilityState } from "./types"

function state(overrides: Partial<DurabilityState> = {}): DurabilityState {
  return {
    sequence: 5,
    dbs: {
      CogniaDB: {
        schema: { version: 141, tables: ["messages", "sessions"] },
        rows: {
          sessions: { "s:a": { id: "a" }, "s:b": { id: "b" } },
          messages: { "s:m": { id: "m" } },
        },
      },
    },
    ...overrides,
  }
}

function clone(value: DurabilityState): DurabilityState {
  return JSON.parse(JSON.stringify(value)) as DurabilityState
}

describe("verifyParity", () => {
  it("passes on identical states", () => {
    const report = verifyParity(state(), clone(state()))
    expect(report.ok).toBe(true)
    expect(report.comparedRows).toBe(3)
  })

  it("passes regardless of key insertion order", () => {
    const candidate = clone(state())
    candidate.dbs.CogniaDB.rows.sessions = { "s:b": { id: "b" }, "s:a": { id: "a" } }
    expect(verifyParity(state(), candidate).ok).toBe(true)
  })

  it("flags a sequence mismatch", () => {
    const candidate = clone(state())
    candidate.sequence = 4
    expect(verifyParity(state(), candidate).mismatches.map((m) => m.kind)).toContain("sequence")
  })

  it("flags a missing database", () => {
    const candidate = clone(state())
    delete candidate.dbs.CogniaDB
    expect(verifyParity(state(), candidate).mismatches.map((m) => m.kind)).toContain(
      "database-missing"
    )
  })

  it("flags an unexpected database", () => {
    const candidate = clone(state())
    candidate.dbs.Extra = { schema: { version: 1, tables: [] }, rows: {} }
    expect(verifyParity(state(), candidate).mismatches.map((m) => m.kind)).toContain(
      "database-unexpected"
    )
  })

  it("flags a schema version mismatch", () => {
    const candidate = clone(state())
    candidate.dbs.CogniaDB.schema.version = 140
    expect(verifyParity(state(), candidate).mismatches.map((m) => m.kind)).toContain(
      "schema-version"
    )
  })

  it("flags a table-set mismatch", () => {
    const candidate = clone(state())
    candidate.dbs.CogniaDB.schema.tables = ["sessions"]
    expect(verifyParity(state(), candidate).mismatches.map((m) => m.kind)).toContain("table-set")
  })

  it("flags a partial copy as both row-count and key-set", () => {
    const candidate = clone(state())
    delete candidate.dbs.CogniaDB.rows.sessions["s:b"]
    const kinds = verifyParity(state(), candidate).mismatches.map((m) => m.kind)
    expect(kinds).toContain("row-count")
    expect(kinds).toContain("key-set")
  })

  it("does not report a content hash when the key set already differs", () => {
    const candidate = clone(state())
    candidate.dbs.CogniaDB.rows.sessions = { "s:a": { id: "a" }, "s:zzz": { id: "b" } }
    const kinds = verifyParity(state(), candidate).mismatches.map((m) => m.kind)
    expect(kinds).toContain("key-set")
    expect(kinds).not.toContain("content-hash")
  })

  it("flags a mangled value with the same key set", () => {
    const candidate = clone(state())
    candidate.dbs.CogniaDB.rows.sessions["s:a"] = { id: "MANGLED" }
    expect(verifyParity(state(), candidate).mismatches.map((m) => m.kind)).toEqual(["content-hash"])
  })

  it("treats a missing table object as empty", () => {
    const source = state()
    source.dbs.CogniaDB.rows.messages = {}
    const candidate = clone(source)
    delete candidate.dbs.CogniaDB.rows.messages
    expect(verifyParity(source, candidate).ok).toBe(true)
  })
})

describe("formatParityReport", () => {
  it("summarises a pass", () => {
    expect(formatParityReport(verifyParity(state(), clone(state())))).toBe(
      "parity ok (3 rows compared)"
    )
  })

  it("lists every mismatch with its location", () => {
    const candidate = clone(state())
    candidate.dbs.CogniaDB.rows.sessions["s:a"] = { id: "x" }
    const text = formatParityReport(verifyParity(state(), candidate))
    expect(text).toContain("parity FAILED (1 mismatches)")
    expect(text).toContain("content-hash at CogniaDB.sessions")
  })

  it("omits the location for whole-state mismatches", () => {
    const candidate = clone(state())
    candidate.sequence = 99
    expect(formatParityReport(verifyParity(state(), candidate))).toContain("  sequence: expected 5")
  })
})
