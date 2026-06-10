/**
 * @jest-environment node
 */
import {
  parseSnapshot,
  restoreSnapshot,
  serializeDb,
  serializeSnapshot,
  type DbLike,
} from "./snapshot"

class FakeTable {
  rows: unknown[]
  constructor(
    public name: string,
    rows: unknown[] = []
  ) {
    this.rows = [...rows]
  }
  async toArray() {
    return this.rows
  }
  async clear() {
    this.rows = []
  }
  async bulkPut(rows: unknown[]) {
    this.rows.push(...rows)
  }
}

function fakeDb(tables: FakeTable[], verno = 82): DbLike {
  return { verno, tables }
}

describe("serializeDb", () => {
  it("dumps every table keyed by name with the db version", async () => {
    const db = fakeDb([new FakeTable("goals", [{ id: "g1" }]), new FakeTable("sessions", [])])
    const snap = await serializeDb(db)
    expect(snap.version).toBe(82)
    expect(snap.tables.goals).toEqual([{ id: "g1" }])
    expect(snap.tables.sessions).toEqual([])
  })
})

describe("restoreSnapshot", () => {
  it("clears and refills tables present in the snapshot, leaving others (seeds) intact", async () => {
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const characters = new FakeTable("characters", [{ id: "builtin" }])
    const db = fakeDb([goals, characters])
    await restoreSnapshot(db, { version: 82, tables: { goals: [{ id: "g1" }, { id: "g2" }] } })
    expect(goals.rows).toEqual([{ id: "g1" }, { id: "g2" }])
    // characters is absent from the snapshot → seed row preserved.
    expect(characters.rows).toEqual([{ id: "builtin" }])
  })

  it("ignores snapshot tables that no longer exist in the schema", async () => {
    const goals = new FakeTable("goals", [])
    const db = fakeDb([goals])
    await restoreSnapshot(db, {
      version: 82,
      tables: { goals: [{ id: "g" }], gone: [{ id: "x" }] },
    })
    expect(goals.rows).toEqual([{ id: "g" }])
  })
})

describe("parseSnapshot", () => {
  it("parses a valid snapshot", () => {
    expect(parseSnapshot('{"version":82,"tables":{"goals":[]}}')).toEqual({
      version: 82,
      tables: { goals: [] },
    })
  })
  it("returns null for missing input, invalid JSON, or the wrong shape", () => {
    expect(parseSnapshot(null)).toBeNull()
    expect(parseSnapshot("not json")).toBeNull()
    expect(parseSnapshot("[1,2,3]")).toBeNull()
    expect(parseSnapshot('{"version":1}')).toBeNull()
  })
})

describe("serializeSnapshot", () => {
  it("round-trips through parseSnapshot", () => {
    const snap = { version: 82, tables: { goals: [{ id: "g" }] } }
    expect(parseSnapshot(serializeSnapshot(snap))).toEqual(snap)
  })
})
