/**
 * @jest-environment node
 */
import {
  parseMultiSnapshot,
  parseSnapshot,
  restoreMultiSnapshot,
  restoreSnapshot,
  serializeDb,
  serializeSnapshot,
  serializeSources,
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

  it("refuses to restore a snapshot from a different schema version", async () => {
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const db = fakeDb([goals], 82)

    await expect(
      restoreSnapshot(db, { version: 81, tables: { goals: [{ id: "old" }] } })
    ).rejects.toThrow("schema version 81 does not match database schema version 82")
    expect(goals.rows).toEqual([{ id: "seed" }])
  })
})

describe("parseSnapshot", () => {
  it("parses a valid snapshot", () => {
    expect(parseSnapshot('{"version":82,"tables":{"goals":[]}}')).toEqual({
      kind: "valid",
      snapshot: {
        version: 82,
        tables: { goals: [] },
      },
    })
  })

  it("distinguishes an absent snapshot from corrupt content", () => {
    expect(parseSnapshot(null)).toEqual({ kind: "absent" })
    expect(parseSnapshot(undefined)).toEqual({ kind: "absent" })
    expect(parseSnapshot("")).toMatchObject({ kind: "corrupt" })
    expect(parseSnapshot("not json")).toMatchObject({ kind: "corrupt" })
    expect(parseSnapshot("[1,2,3]")).toMatchObject({ kind: "corrupt" })
    expect(parseSnapshot('{"version":1}')).toMatchObject({ kind: "corrupt" })
  })
})

describe("serializeSnapshot", () => {
  it("round-trips through parseSnapshot", () => {
    const snap = { version: 82, tables: { goals: [{ id: "g" }] } }
    expect(parseSnapshot(serializeSnapshot(snap))).toEqual({ kind: "valid", snapshot: snap })
  })
})

describe("serializeDb — excludeTables", () => {
  it("omits excluded tables entirely rather than writing them empty", async () => {
    const db = fakeDb([new FakeTable("tasks", [{ id: "t" }]), new FakeTable("executions", [{}])])
    const snap = await serializeDb(db, { excludeTables: ["executions"] })
    expect(snap.tables.tasks).toEqual([{ id: "t" }])
    expect(snap.tables).not.toHaveProperty("executions")
  })
})

describe("serializeSources", () => {
  it("keys each database by name and honours its own exclusions", async () => {
    const goals = new FakeTable("goals", [{ id: "g" }])
    const tasks = new FakeTable("tasks", [{ id: "t" }])
    const executions = new FakeTable("executions", [{ id: "run" }])
    const snap = await serializeSources([
      { name: "CogniaDB", db: fakeDb([goals]) },
      {
        name: "CogniaSchedulerDB",
        db: fakeDb([tasks, executions], 2),
        excludeTables: ["executions"],
      },
    ])
    expect(snap.snapshotFormat).toBe(2)
    expect(snap.dbs.CogniaDB).toEqual({ version: 82, tables: { goals: [{ id: "g" }] } })
    expect(snap.dbs.CogniaSchedulerDB).toEqual({ version: 2, tables: { tasks: [{ id: "t" }] } })
  })
})

describe("restoreMultiSnapshot", () => {
  it("restores each source from its own key", async () => {
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const tasks = new FakeTable("tasks", [])
    await restoreMultiSnapshot(
      [
        { name: "CogniaDB", db: fakeDb([goals]) },
        { name: "CogniaSchedulerDB", db: fakeDb([tasks], 2) },
      ],
      {
        snapshotFormat: 2,
        dbs: {
          CogniaDB: { version: 82, tables: { goals: [{ id: "g" }] } },
          CogniaSchedulerDB: { version: 2, tables: { tasks: [{ id: "t" }] } },
        },
      }
    )
    expect(goals.rows).toEqual([{ id: "g" }])
    expect(tasks.rows).toEqual([{ id: "t" }])
  })

  it("skips a database the envelope omits, leaving its rows untouched", async () => {
    const tasks = new FakeTable("tasks", [{ id: "kept" }])
    await restoreMultiSnapshot([{ name: "CogniaSchedulerDB", db: fakeDb([tasks], 2) }], {
      snapshotFormat: 2,
      dbs: { CogniaDB: { version: 82, tables: {} } },
    })
    expect(tasks.rows).toEqual([{ id: "kept" }])
  })

  it("names the database in a per-db version mismatch", async () => {
    const tasks = new FakeTable("tasks", [])
    await expect(
      restoreMultiSnapshot([{ name: "CogniaSchedulerDB", db: fakeDb([tasks], 2) }], {
        snapshotFormat: 2,
        dbs: { CogniaSchedulerDB: { version: 1, tables: { tasks: [] } } },
      })
    ).rejects.toThrow("database CogniaSchedulerDB")
  })
})

describe("parseMultiSnapshot", () => {
  it("normalises a legacy single-database snapshot onto the primary name", () => {
    expect(parseMultiSnapshot('{"version":82,"tables":{"goals":[]}}', "CogniaDB")).toEqual({
      kind: "valid",
      snapshot: { snapshotFormat: 2, dbs: { CogniaDB: { version: 82, tables: { goals: [] } } } },
    })
  })

  it("parses a multi-database envelope", () => {
    const text = JSON.stringify({
      snapshotFormat: 2,
      dbs: { CogniaSchedulerDB: { version: 2, tables: { tasks: [{ id: "t" }] } } },
    })
    expect(parseMultiSnapshot(text, "CogniaDB")).toEqual({
      kind: "valid",
      snapshot: {
        snapshotFormat: 2,
        dbs: { CogniaSchedulerDB: { version: 2, tables: { tasks: [{ id: "t" }] } } },
      },
    })
  })

  it("round-trips serializeSources output", async () => {
    const snap = await serializeSources([
      { name: "CogniaDB", db: fakeDb([new FakeTable("goals")]) },
    ])
    expect(parseMultiSnapshot(serializeSnapshot(snap), "CogniaDB")).toEqual({
      kind: "valid",
      snapshot: snap,
    })
  })

  it("distinguishes absent from corrupt and rejects unknown formats", () => {
    expect(parseMultiSnapshot(null, "CogniaDB")).toEqual({ kind: "absent" })
    expect(parseMultiSnapshot(undefined, "CogniaDB")).toEqual({ kind: "absent" })
    expect(parseMultiSnapshot("not json", "CogniaDB")).toMatchObject({ kind: "corrupt" })
    expect(parseMultiSnapshot("[1,2]", "CogniaDB")).toMatchObject({ kind: "corrupt" })
    // Legacy path still validated by parseSnapshot's rules.
    expect(parseMultiSnapshot('{"version":1}', "CogniaDB")).toMatchObject({ kind: "corrupt" })
    expect(parseMultiSnapshot('{"snapshotFormat":3,"dbs":{}}', "CogniaDB")).toMatchObject({
      kind: "corrupt",
      reason: "unsupported snapshot format 3",
    })
    expect(parseMultiSnapshot('{"snapshotFormat":2,"dbs":[]}', "CogniaDB")).toMatchObject({
      kind: "corrupt",
      reason: "snapshot dbs are not an object",
    })
  })

  it("rejects a malformed per-database entry and says which one", () => {
    const cases = [
      '{"snapshotFormat":2,"dbs":{"X":null}}',
      '{"snapshotFormat":2,"dbs":{"X":[]}}',
      '{"snapshotFormat":2,"dbs":{"X":{"tables":{}}}}',
      '{"snapshotFormat":2,"dbs":{"X":{"version":1}}}',
      '{"snapshotFormat":2,"dbs":{"X":{"version":1,"tables":[]}}}',
      '{"snapshotFormat":2,"dbs":{"X":{"version":1,"tables":{"t":"nope"}}}}',
    ]
    for (const text of cases) {
      expect(parseMultiSnapshot(text, "CogniaDB")).toEqual({
        kind: "corrupt",
        reason: "snapshot for database X is malformed",
      })
    }
  })
})
