import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createDualWriteBackend,
  durabilityRoot,
  ensureDurabilityRoot,
  openBackend,
  resolveBackend,
} from "./backend"
import { writeCheckpoint } from "./checkpoint"
import { writeManifest } from "./manifest"
import type { DurabilityCommit, DurabilityState, HeadlessDurabilityBackend } from "./types"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-backend-"))
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

describe("durabilityRoot", () => {
  it("scopes by account and escapes path-hostile ids", () => {
    expect(durabilityRoot("/home", "local")).toBe(path.join("/home", "durability", "local"))
    expect(durabilityRoot("/home", "a/b")).toBe(path.join("/home", "durability", "a%2Fb"))
  })

  it("creates the root with restrictive permissions", () => {
    const root = path.join(tempRoot(), "nested")
    try {
      ensureDurabilityRoot(root)
      expect(fs.existsSync(root)).toBe(true)
      if (process.platform !== "win32") {
        expect(fs.statSync(root).mode & 0o777).toBe(0o700)
      }
    } finally {
      fs.rmSync(path.dirname(root), { recursive: true, force: true })
    }
  })
})

describe("openBackend", () => {
  it("maps snapshot-v3 onto the checkpoint half of the journal backend", () => {
    const root = tempRoot()
    try {
      expect(openBackend("snapshot-v3", root).id).toBe("journal-v4")
      expect(openBackend("journal-v4", root).id).toBe("journal-v4")
      expect(openBackend("sqlite-v5", root).id).toBe("sqlite-v5")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("createDualWriteBackend", () => {
  function recorder(id: HeadlessDurabilityBackend["id"]): HeadlessDurabilityBackend & {
    seen: number[]
    closed: boolean
    compacted: number
  } {
    let sequence = 0
    return {
      id,
      seen: [],
      closed: false,
      compacted: 0,
      load: async () => state(sequence),
      commitSync(c) {
        sequence = c.sequence
        ;(this as unknown as { seen: number[] }).seen.push(c.sequence)
      },
      async commit(c) {
        this.commitSync(c)
      },
      lastSequence: () => sequence,
      async compact(s) {
        ;(this as unknown as { compacted: number }).compacted += 1
        return { generation: "x", previousGeneration: null, sequence: s.sequence }
      },
      async close() {
        ;(this as unknown as { closed: boolean }).closed = true
      },
    }
  }

  it("writes the journal first and mirrors into the shadow", async () => {
    const order: string[] = []
    const primary = recorder("journal-v4")
    const shadow = recorder("sqlite-v5")
    const wrappedPrimary = {
      ...primary,
      commitSync: (c: DurabilityCommit) => {
        order.push("primary")
        primary.commitSync(c)
      },
    }
    const wrappedShadow = {
      ...shadow,
      commitSync: (c: DurabilityCommit) => {
        order.push("shadow")
        shadow.commitSync(c)
      },
    }
    const dual = createDualWriteBackend(wrappedPrimary, wrappedShadow)
    dual.commitSync(commit(1, "s:a", 1))
    await dual.commit(commit(2, "s:b", 2))
    expect(order).toEqual(["primary", "shadow", "primary", "shadow"])
    expect(primary.seen).toEqual([1, 2])
    expect(shadow.seen).toEqual([1, 2])
  })

  it("answers load and lastSequence from the primary", async () => {
    const primary = recorder("journal-v4")
    const shadow = recorder("sqlite-v5")
    const dual = createDualWriteBackend(primary, shadow)
    dual.commitSync(commit(1, "s:a", 1))
    expect(dual.id).toBe("journal-v4")
    expect(dual.lastSequence()).toBe(1)
    expect((await dual.load()).sequence).toBe(1)
  })

  it("compacts and closes both", async () => {
    const primary = recorder("journal-v4")
    const shadow = recorder("sqlite-v5")
    const dual = createDualWriteBackend(primary, shadow)
    await dual.compact(state(3))
    await dual.close()
    expect(primary.compacted).toBe(1)
    expect(shadow.compacted).toBe(1)
    expect(primary.closed && shadow.closed).toBe(true)
  })
})

describe("resolveBackend", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("seeds a first-boot checkpoint from the caller's live state", async () => {
    const resolved = await resolveBackend({ root, seed: state(0, { "s:a": { id: "a" } }) })
    expect(resolved.manifest.activeBackend).toBe("journal-v4")
    expect(resolved.state.dbs.CogniaDB.rows.sessions).toEqual({ "s:a": { id: "a" } })
    await resolved.backend.close()
  })

  it("never re-seeds once a generation exists", async () => {
    writeCheckpoint(root, "gen-0001", state(2, { "s:kept": 1 }))
    const resolved = await resolveBackend({ root, seed: state(0, { "s:fresh": 1 }) })
    expect(resolved.state.dbs.CogniaDB.rows.sessions).toEqual({ "s:kept": 1 })
    await resolved.backend.close()
  })

  it("returns no shadow when the manifest has none", async () => {
    const resolved = await resolveBackend({ root, seed: state() })
    expect(resolved.shadowCatchUp).toBe(0)
    await resolved.backend.close()
  })

  it("rejects a manifest that shadows a backend onto itself", async () => {
    writeCheckpoint(root, "gen-0001", state())
    writeManifest(root, {
      manifestFormat: 1,
      activeBackend: "journal-v4",
      shadowBackend: "journal-v4",
      rollbackWatermark: null,
      updatedAt: 0,
    })
    await expect(resolveBackend({ root })).rejects.toThrow(/shadows .* onto itself/)
  })

  it("replays the journal tail into a lagging shadow", async () => {
    writeCheckpoint(root, "gen-0001", state(0))
    const journal = openBackend("journal-v4", root)
    await journal.load()
    journal.commitSync(commit(1, "s:a", { id: "a" }))
    journal.commitSync(commit(2, "s:b", { id: "b" }))
    await journal.close()

    // Seed SQLite at sequence 1 only — the interrupted dual-write window.
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(1, { "s:a": { id: "a" } }))
    await sqlite.close()

    writeManifest(root, {
      manifestFormat: 1,
      activeBackend: "journal-v4",
      shadowBackend: "sqlite-v5",
      rollbackWatermark: null,
      updatedAt: 0,
    })

    const resolved = await resolveBackend({ root })
    expect(resolved.shadowCatchUp).toBe(1)
    await resolved.backend.close()

    const check = openBackend("sqlite-v5", root)
    const caught = await check.load()
    await check.close()
    expect(caught.sequence).toBe(2)
    expect(caught.dbs.CogniaDB.rows.sessions).toEqual({
      "s:a": { id: "a" },
      "s:b": { id: "b" },
    })
  })

  it("rewrites a shadow that predates the checkpoint wholesale", async () => {
    writeCheckpoint(root, "gen-0001", state(10, { "s:a": { id: "a" } }))
    writeManifest(root, {
      manifestFormat: 1,
      activeBackend: "journal-v4",
      shadowBackend: "sqlite-v5",
      rollbackWatermark: null,
      updatedAt: 0,
    })
    const resolved = await resolveBackend({ root })
    expect(resolved.shadowCatchUp).toBe(10)
    await resolved.backend.close()

    const check = openBackend("sqlite-v5", root)
    const caught = await check.load()
    await check.close()
    expect(caught.sequence).toBe(10)
  })

  it("refuses to run with a shadow that is ahead of the journal", async () => {
    writeCheckpoint(root, "gen-0001", state(1))
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(5))
    await sqlite.close()
    writeManifest(root, {
      manifestFormat: 1,
      activeBackend: "journal-v4",
      shadowBackend: "sqlite-v5",
      rollbackWatermark: null,
      updatedAt: 0,
    })
    await expect(resolveBackend({ root })).rejects.toThrow(/ahead of the journal/)
  })
})
