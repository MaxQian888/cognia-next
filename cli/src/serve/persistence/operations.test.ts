import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { openBackend } from "./backend"
import { generationDir, listGenerations, readCheckpoint, writeCheckpoint } from "./checkpoint"
import { encodeCommitLine, journalFile } from "./journal"
import { readManifest, writeManifest } from "./manifest"
import {
  finalizeDurability,
  firstGeneration,
  listRollbackBundles,
  migrateDurability,
  parseBackendArgument,
  readJournalState,
  recoverDurability,
  rollbackDurability,
  verifyDurability,
  writeRollbackBundle,
} from "./operations"
import type { DurabilityCommit, DurabilityState } from "./types"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-ops-"))
}

function state(sequence = 0, rows: Record<string, unknown> = {}): DurabilityState {
  return {
    sequence,
    dbs: {
      CogniaDB: { schema: { version: 141, tables: ["sessions"] }, rows: { sessions: rows } },
    },
  }
}

function commit(sequence: number, key: string, value: unknown): DurabilityCommit {
  return {
    sequence,
    committedAt: sequence,
    mutations: [{ database: "CogniaDB", table: "sessions", key, value }],
  }
}

async function seedJournal(root: string, commits: DurabilityCommit[]): Promise<void> {
  writeCheckpoint(root, "gen-0001", state(0))
  const backend = openBackend("journal-v4", root)
  await backend.load()
  for (const c of commits) backend.commitSync(c)
  await backend.close()
}

describe("verifyDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("reports an empty account with no faults", async () => {
    const status = await verifyDurability(root)
    expect(status.faults).toEqual([])
    expect(status.generations).toEqual([])
    expect(status.sqlitePresent).toBe(false)
  })

  it("reports generations, checkpoint and journal sequences", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" }), commit(2, "s:b", { id: "b" })])
    const status = await verifyDurability(root)
    expect(status.generations).toEqual(["gen-0001"])
    expect(status.checkpointSequence).toBe(0)
    expect(status.journalCommits).toBe(2)
    expect(status.journalSequence).toBe(2)
    expect(status.faults).toEqual([])
  })

  it("reports the torn trailing bytes it discarded", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    fs.appendFileSync(journalFile(root, "gen-0001"), '{"sequence":2,"mut')
    const status = await verifyDurability(root)
    expect(status.journalDiscardedBytes).toBeGreaterThan(0)
    expect(status.faults).toEqual([])
  })

  it("surfaces a checksum fault without hiding the rest of the report", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const file = journalFile(root, "gen-0001")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"id":"a"', '"id":"z"'))
    const status = await verifyDurability(root)
    expect(status.faults.map((f) => f.code)).toEqual(["journal-checksum-mismatch"])
    expect(status.generations).toEqual(["gen-0001"])
  })

  it("surfaces a sequence gap", async () => {
    writeCheckpoint(root, "gen-0001", state(0))
    fs.mkdirSync(path.join(root, "journal"), { recursive: true })
    fs.writeFileSync(
      journalFile(root, "gen-0001"),
      encodeCommitLine(commit(1, "s:a", 1)) + encodeCommitLine(commit(3, "s:c", 3))
    )
    const status = await verifyDurability(root)
    expect(status.faults.map((f) => f.code)).toEqual(["journal-sequence-gap"])
  })

  it("reports a parity mismatch between the journal and sqlite", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(1, { "s:a": { id: "DIFFERENT" } }))
    await sqlite.close()
    const status = await verifyDurability(root)
    expect(status.parity?.ok).toBe(false)
    expect(status.faults.map((f) => f.code)).toContain("parity-mismatch")
  })

  it("tolerates a corrupt manifest rather than refusing to report", async () => {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "backend-manifest.json"), "{oops")
    const status = await verifyDurability(root)
    expect(status.manifest.activeBackend).toBe("journal-v4")
  })

  it("records a non-fault error as a manifest-corrupt entry", async () => {
    writeCheckpoint(root, "gen-0001", state(0))
    fs.mkdirSync(path.join(root, "journal"), { recursive: true })
    // A directory where the journal file should be: `readFileSync` throws a
    // plain EISDIR Error, not a DurabilityFault.
    fs.mkdirSync(journalFile(root, "gen-0001"), { recursive: true })
    const status = await verifyDurability(root)
    expect(status.faults.map((f) => f.code)).toEqual(["manifest-corrupt"])
  })

  it("surfaces a corrupt checkpoint", async () => {
    writeCheckpoint(root, "gen-0001", state(0))
    fs.writeFileSync(path.join(generationDir(root, "gen-0001"), "checkpoint.json"), "{oops")
    const status = await verifyDurability(root)
    expect(status.faults.map((f) => f.code)).toEqual(["checkpoint-corrupt"])
  })
})

describe("readJournalState", () => {
  it("returns an empty state when nothing exists", () => {
    const root = tempRoot()
    try {
      expect(readJournalState(root)).toEqual({ sequence: 0, dbs: {} })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("rollback bundles", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
    writeCheckpoint(root, "gen-0001", state(4))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("freezes the manifest and generation, numbered monotonically", () => {
    const first = writeRollbackBundle(root, "one", () => 1)
    const second = writeRollbackBundle(root, "two", () => 2)
    expect([first.id, second.id]).toEqual(["bundle-0001", "bundle-0002"])
    expect(first.generation).toBe("gen-0001")
    expect(first.sequence).toBe(4)
    expect(listRollbackBundles(root).map((b) => b.reason)).toEqual(["one", "two"])
  })

  it("writes bundles read-only so they cannot be edited in place", () => {
    const bundle = writeRollbackBundle(root, "one")
    if (process.platform === "win32") return
    const file = path.join(root, "rollback", `${bundle.id}.json`)
    expect(fs.statSync(file).mode & 0o777).toBe(0o400)
  })

  it("lists nothing when no bundle was ever written", () => {
    expect(listRollbackBundles(tempRoot())).toEqual([])
  })
})

describe("migrateDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("copies the journal into sqlite, verifies parity, and promotes", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" }), commit(2, "s:b", { id: "b" })])
    const result = await migrateDurability(root, "sqlite-v5", { now: () => 100 })
    expect(result.promoted).toBe(true)
    expect(result.parity.ok).toBe(true)
    expect(readManifest(root)).toMatchObject({
      activeBackend: "sqlite-v5",
      shadowBackend: "journal-v4",
    })

    const sqlite = openBackend("sqlite-v5", root)
    const migrated = await sqlite.load()
    await sqlite.close()
    expect(migrated.sequence).toBe(2)
    expect(migrated.dbs.CogniaDB.rows.sessions).toEqual({
      "s:a": { id: "a" },
      "s:b": { id: "b" },
    })
  })

  it("writes a rollback bundle before touching anything", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    const result = await migrateDurability(root, "sqlite-v5")
    expect(listRollbackBundles(root)).toHaveLength(1)
    expect(result.bundle.manifest.activeBackend).toBe("journal-v4")
  })

  it("pins the manifest when the account has never been opted in", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    const result = await migrateDurability(root, "journal-v4", { now: () => 7 })
    expect(result.promoted).toBe(true)
    expect(readManifest(root).activeBackend).toBe("journal-v4")
    expect(listRollbackBundles(root).map((b) => b.reason)).toEqual(["pin journal-v4"])
  })

  it("refuses a second migration onto the already-pinned backend", async () => {
    await seedJournal(root, [])
    await migrateDurability(root, "journal-v4")
    await expect(migrateDurability(root, "journal-v4")).rejects.toThrow(/already on journal-v4/)
  })

  it("leaves the incumbent active when parity fails", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const result = await migrateDurability(root, "sqlite-v5", {
      verify: () => ({
        ok: false,
        comparedRows: 1,
        mismatches: [
          {
            kind: "content-hash",
            database: "CogniaDB",
            table: "sessions",
            expected: "a",
            actual: "b",
          },
        ],
      }),
    })
    expect(result.promoted).toBe(false)
    expect(readManifest(root).activeBackend).toBe("journal-v4")
    expect(readManifest(root).shadowBackend).toBeNull()
  })
})

describe("recoverDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("stages the journal into a new generation without activating", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const result = await recoverDurability(root, "journal")
    expect(result).toMatchObject({ source: "journal", generation: "gen-0002", sequence: 1 })
    expect(result.activated).toBe(false)
    expect(listGenerations(root)).toEqual(["gen-0001", "gen-0002"])
    expect(readCheckpoint(root, "gen-0002").dbs.CogniaDB.rows.sessions).toEqual({
      "s:a": { id: "a" },
    })
  })

  it("never overwrites the generation it recovered from", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const before = readCheckpoint(root, "gen-0001")
    await recoverDurability(root, "auto")
    expect(readCheckpoint(root, "gen-0001")).toEqual(before)
  })

  it("auto-selects the source with the highest verified sequence", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" }), commit(2, "s:b", { id: "b" })])
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(1, { "s:a": { id: "a" } }))
    await sqlite.close()
    const result = await recoverDurability(root, "auto")
    expect(result.source).toBe("journal")
    expect(result.sequence).toBe(2)
  })

  it("recovers from sqlite when explicitly asked", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(9, { "s:only": { id: "only" } }))
    await sqlite.close()
    const result = await recoverDurability(root, "sqlite")
    expect(result.source).toBe("sqlite")
    expect(readCheckpoint(root, result.generation).dbs.CogniaDB.rows.sessions).toEqual({
      "s:only": { id: "only" },
    })
  })

  it("activates and records a bundle when --activate is passed", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    writeManifest(root, {
      manifestFormat: 1,
      activeBackend: "sqlite-v5",
      shadowBackend: "journal-v4",
      rollbackWatermark: null,
      updatedAt: 0,
    })
    const result = await recoverDurability(root, "journal", { activate: true, now: () => 5 })
    expect(result.activated).toBe(true)
    expect(readManifest(root)).toMatchObject({
      activeBackend: "journal-v4",
      shadowBackend: null,
    })
    expect(listRollbackBundles(root)).toHaveLength(1)
  })

  it("throws when the explicitly named journal source holds nothing", async () => {
    await expect(recoverDurability(root, "journal")).rejects.toThrow(/no readable recovery source/)
  })

  it("propagates a sqlite fault when sqlite is the named source", async () => {
    await seedJournal(root, [])
    fs.mkdirSync(path.join(root, "sqlite"), { recursive: true })
    fs.writeFileSync(path.join(root, "sqlite", "store.sqlite"), "definitely not a database")
    await expect(recoverDurability(root, "sqlite")).rejects.toThrow()
  })

  it("throws when there is nothing to recover from", async () => {
    await expect(recoverDurability(root, "auto")).rejects.toThrow(/no readable recovery source/)
  })

  it("propagates a fault when the explicitly named source is broken", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    const file = journalFile(root, "gen-0001")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("s:a", "s:z"))
    await expect(recoverDurability(root, "journal")).rejects.toThrow(
      expect.objectContaining({ code: "journal-checksum-mismatch" })
    )
  })

  it("falls back to a healthy source under auto when one is broken", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const file = journalFile(root, "gen-0001")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"id":"a"', '"id":"z"'))
    const result = await recoverDurability(root, "auto")
    expect(result.source).toBe("snapshot")
  })
})

describe("rollbackDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("re-cuts an older generation as the newest and keeps everything", async () => {
    writeCheckpoint(root, "gen-0001", state(1, { "s:old": 1 }))
    writeCheckpoint(root, "gen-0002", state(9, { "s:new": 1 }))
    const result = rollbackDurability(root, "gen-0001", () => 3)
    expect(result.generation).toBe("gen-0003")
    expect(result.sequence).toBe(1)
    expect(listGenerations(root)).toEqual(["gen-0001", "gen-0002", "gen-0003"])
    expect(readCheckpoint(root, "gen-0003").dbs.CogniaDB.rows.sessions).toEqual({ "s:old": 1 })
    expect(readManifest(root).activeBackend).toBe("journal-v4")
  })

  it("records a rollback bundle", () => {
    writeCheckpoint(root, "gen-0001", state(1))
    rollbackDurability(root, "gen-0001")
    expect(listRollbackBundles(root)).toHaveLength(1)
  })

  it("rejects a non-generation id", () => {
    expect(() => rollbackDurability(root, "latest")).toThrow(/is not a generation id/)
  })

  it("rejects a generation that is not on disk", () => {
    expect(() => rollbackDurability(root, "gen-0007")).toThrow(/is not on disk/)
  })
})

describe("finalizeDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
    writeCheckpoint(root, "gen-0001", state(1))
    writeCheckpoint(root, "gen-0002", state(2))
    writeCheckpoint(root, "gen-0003", state(3))
    writeManifest(root, {
      manifestFormat: 1,
      activeBackend: "sqlite-v5",
      shadowBackend: "journal-v4",
      rollbackWatermark: null,
      updatedAt: 0,
    })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("requires --confirm", () => {
    expect(() => finalizeDurability(root, "gen-0002", { confirm: false })).toThrow(/--confirm/)
    expect(listGenerations(root)).toHaveLength(3)
  })

  it("prunes strictly below the watermark and keeps the named generation", () => {
    const result = finalizeDurability(root, "gen-0002", { confirm: true, now: () => 9 })
    expect(result.prunedGenerations).toEqual(["gen-0001"])
    expect(result.keptGenerations).toEqual(["gen-0002", "gen-0003"])
    expect(result.rollbackWatermark).toBe("gen-0002")
  })

  it("clears the shadow backend so the compatibility window ends", () => {
    const result = finalizeDurability(root, "gen-0003", { confirm: true })
    expect(result.manifest.shadowBackend).toBeNull()
    expect(readManifest(root).shadowBackend).toBeNull()
    expect(readManifest(root).activeBackend).toBe("sqlite-v5")
  })

  it("also removes the pruned generations' journal files", () => {
    fs.mkdirSync(path.join(root, "journal"), { recursive: true })
    fs.writeFileSync(journalFile(root, "gen-0001"), encodeCommitLine(commit(2, "s:a", 1)))
    finalizeDurability(root, "gen-0002", { confirm: true })
    expect(fs.existsSync(journalFile(root, "gen-0001"))).toBe(false)
  })

  it("rejects a generation that is not on disk", () => {
    expect(() => finalizeDurability(root, "gen-0009", { confirm: true })).toThrow(/is not on disk/)
  })

  it("rejects a non-generation id", () => {
    expect(() => finalizeDurability(root, "newest", { confirm: true })).toThrow(
      /is not a generation id/
    )
  })
})

describe("argument helpers", () => {
  it("accepts the three known backend ids", () => {
    expect(parseBackendArgument("sqlite-v5")).toBe("sqlite-v5")
  })

  it("rejects anything else", () => {
    expect(() => parseBackendArgument("postgres")).toThrow(/--to must be one of/)
    expect(() => parseBackendArgument(undefined)).toThrow(/--to must be one of/)
  })

  it("names the first generation", () => {
    expect(firstGeneration()).toBe("gen-0001")
  })
})
