/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

// The db and the store are mocked so every branch of the bridge is reachable
// without standing up Dexie or the real 2 400-line artifact store.

const fakeTable = () => {
  const records: Record<string, unknown>[] = []
  return {
    records,
    toArray: jest.fn(async () => [...records]),
    bulkPut: jest.fn(async (rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        const idx = records.findIndex((r) => r.id === row.id)
        if (idx >= 0) records[idx] = row
        else records.push(row)
      }
    }),
    bulkDelete: jest.fn(async (ids: string[]) => {
      for (const id of ids) {
        const idx = records.findIndex((r) => r.id === id)
        if (idx >= 0) records.splice(idx, 1)
      }
    }),
    delete: jest.fn(async (id: string) => {
      const idx = records.findIndex((r) => r.id === id)
      if (idx >= 0) records.splice(idx, 1)
    }),
    where: jest.fn((field: string) => ({
      equals: jest.fn((value: unknown) => ({
        delete: jest.fn(async () => {
          for (let i = records.length - 1; i >= 0; i -= 1) {
            if (records[i][field] === value) records.splice(i, 1)
          }
          return 0
        }),
      })),
    })),
  }
}

let artifactsTable = fakeTable()
let artifactVersionsTable = fakeTable()

const fakeDb = {
  name: "cognia-db",
  artifacts: artifactsTable,
  artifactVersions: artifactVersionsTable,
  transaction: jest.fn(async (...args: unknown[]) => {
    const fn = args[args.length - 1] as () => Promise<void>
    await fn()
  }),
}

let getDbImpl = () => fakeDb as unknown
jest.mock("@/lib/db/schema", () => ({
  __esModule: true,
  getDb: () => getDbImpl(),
}))

interface StoreShape {
  artifacts: Record<string, Artifact>
  artifactVersions: Record<string, ArtifactVersion[]>
  artifactDexieMigrationPending?: boolean
}

function makeFakeStore(initial: StoreShape) {
  let state = initial
  const subs = new Set<(s: StoreShape) => void>()
  return {
    getState: () => state,
    setState: (updater: StoreShape | ((prev: StoreShape) => Partial<StoreShape>)) => {
      state =
        typeof updater === "function"
          ? { ...state, ...(updater as (p: StoreShape) => Partial<StoreShape>)(state) }
          : updater
      for (const fn of subs) fn(state)
    },
    subscribe: (fn: (s: StoreShape) => void) => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    persist: { getOptions: () => ({ name: "cognia-artifacts" }) },
    _reset: (next: StoreShape) => {
      state = next
      subs.clear()
    },
  }
}

const artifactStore = makeFakeStore({ artifacts: {}, artifactVersions: {} })
const completeArtifactDexieMigration = jest.fn(() => {
  artifactStore.setState((state) => ({ ...state, artifactDexieMigrationPending: false }))
})

// A getter, not a value: `jest.mock` factories are hoisted above the `const`
// below, so reading it eagerly is a TDZ error at require time.
jest.mock("@/stores/artifact/artifact-store", () => ({
  __esModule: true,
  ARTIFACT_STORAGE_KEY: "cognia-artifacts",
  completeArtifactDexieMigration: () => completeArtifactDexieMigration(),
  get useArtifactStore() {
    return artifactStore
  },
}))

const warn = jest.fn()
jest.mock("@cognia/logging", () => ({
  __esModule: true,
  loggers: {
    canvas: {
      warn: (...a: unknown[]) => warn(...a),
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  },
}))

import type { Artifact, ArtifactVersion } from "@/types/artifact/artifact"
import {
  ARTIFACT_SYNC_DEBOUNCE_MS,
  __resetArtifactDexieBridgeForTesting,
  diffArtifactMirror,
  startArtifactDexieBridge,
} from "./dexie-bridge"
import { ARTIFACT_MIGRATION_PENDING_KEY } from "./localstorage-migration"

function artifact(id: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    sessionId: "s_1",
    projectId: "p_1",
    messageId: "m_1",
    type: "code",
    title: id,
    content: `content-${id}`,
    version: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  }
}

function version(id: string, artifactId: string, n = 1): ArtifactVersion {
  return {
    id,
    artifactId,
    title: artifactId,
    content: `v${n}`,
    version: n,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  }
}

/** Let the bridge's hydrate → initial-sync promise chain settle. */
async function settle() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
}

beforeEach(() => {
  jest.useFakeTimers()
  warn.mockClear()
  completeArtifactDexieMigration.mockClear()
  window.localStorage.clear()
  artifactsTable = fakeTable()
  artifactVersionsTable = fakeTable()
  fakeDb.artifacts = artifactsTable
  fakeDb.artifactVersions = artifactVersionsTable
  fakeDb.name = "cognia-db"
  getDbImpl = () => fakeDb as unknown
  artifactStore._reset({ artifacts: {}, artifactVersions: {} })
  __resetArtifactDexieBridgeForTesting()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("diffArtifactMirror", () => {
  it("upserts only the artifacts whose object identity changed", () => {
    const stable = artifact("a")
    const changed = artifact("b")
    const diff = diffArtifactMirror(
      { a: stable, b: changed },
      new Set(),
      { a: stable, b: { ...changed, content: "edited" } },
      {}
    )
    expect(diff.artifactUpserts.map((r) => r.id)).toEqual(["b"])
  })

  it("deletes an artifact that left the store", () => {
    const diff = diffArtifactMirror({ a: artifact("a") }, new Set(), {}, {})
    expect(diff.removedArtifactIds).toEqual(["a"])
  })

  it("writes a version once and never rewrites it", () => {
    const a = artifact("a")
    const v = version("v1", "a")
    const first = diffArtifactMirror({}, new Set(), { a }, { a: [v] })
    expect(first.versionUpserts.map((r) => r.id)).toEqual(["v1"])
    const second = diffArtifactMirror({ a }, first.seenVersionIds, { a }, { a: [v] })
    expect(second.versionUpserts).toEqual([])
  })

  it("removes versions that were pruned by retention", () => {
    const a = artifact("a")
    const diff = diffArtifactMirror(
      { a },
      new Set(["v1", "v2"]),
      { a },
      { a: [version("v2", "a", 2)] }
    )
    expect(diff.removedVersionIds).toEqual(["v1"])
  })

  it("drops history whose artifact is gone rather than resurrecting it", () => {
    // The store can hold `artifactVersions[id]` for a moment after the artifact
    // row itself was deleted. Writing those would leave history pointing at an
    // id that no longer resolves.
    const diff = diffArtifactMirror({}, new Set(), {}, { ghost: [version("v1", "ghost")] })
    expect(diff.versionUpserts).toEqual([])
  })

  it("stamps a version with its parent artifact's workspace", () => {
    const a = artifact("a", { projectId: "p_9" })
    const diff = diffArtifactMirror({}, new Set(), { a }, { a: [version("v1", "a")] })
    expect(diff.versionUpserts[0].projectId).toBe("p_9")
  })
})

describe("startArtifactDexieBridge", () => {
  it("carries the artifacts the store rehydrated from localStorage into Dexie", async () => {
    artifactStore._reset({
      artifacts: { a: artifact("a") },
      artifactVersions: {},
      artifactDexieMigrationPending: true,
    })

    startArtifactDexieBridge()
    await settle()

    expect(artifactsTable.records.map((r) => r.id)).toEqual(["a"])
    expect(completeArtifactDexieMigration).toHaveBeenCalledTimes(1)
    expect(artifactStore.getState().artifactDexieMigrationPending).toBe(false)
  })

  it("keeps the migration pending when the initial Dexie transaction fails", async () => {
    artifactStore._reset({
      artifacts: { a: artifact("a") },
      artifactVersions: {},
      artifactDexieMigrationPending: true,
    })
    fakeDb.transaction.mockRejectedValueOnce(new Error("QuotaExceededError"))

    startArtifactDexieBridge()
    await settle()

    expect(completeArtifactDexieMigration).not.toHaveBeenCalled()
    expect(artifactStore.getState().artifactDexieMigrationPending).toBe(true)
  })

  it("seeds the store from Dexie on a boot with an empty blob", async () => {
    artifactsTable.records.push({
      id: "a",
      sessionId: "s_1",
      messageId: "m_1",
      type: "code",
      title: "a",
      content: "from-dexie",
      version: 1,
      createdAt: 1,
      updatedAt: 2,
    })
    artifactVersionsTable.records.push({
      id: "v1",
      artifactId: "a",
      content: "v1",
      version: 1,
      createdAt: 1,
    })

    startArtifactDexieBridge()
    await settle()

    expect(artifactStore.getState().artifacts.a.content).toBe("from-dexie")
    expect(artifactStore.getState().artifactVersions.a).toHaveLength(1)
    // Priming: the rows it just read must not be written straight back.
    expect(artifactsTable.bulkPut).not.toHaveBeenCalled()
  })

  it("lets memory win over a stale row", async () => {
    artifactsTable.records.push({
      id: "a",
      sessionId: "s_1",
      messageId: "m_1",
      type: "code",
      title: "a",
      content: "stale",
      version: 1,
      createdAt: 1,
      updatedAt: 2,
    })
    artifactStore._reset({
      artifacts: { a: artifact("a", { content: "fresh" }) },
      artifactVersions: {},
    })

    startArtifactDexieBridge()
    await settle()

    expect(artifactStore.getState().artifacts.a.content).toBe("fresh")
    expect(artifactsTable.records[0].content).toBe("fresh")
  })

  it("replays a migration a previous run parked but never wrote", async () => {
    window.localStorage.setItem(
      ARTIFACT_MIGRATION_PENDING_KEY,
      JSON.stringify({
        artifacts: {
          rescued: {
            id: "rescued",
            sessionId: "s_1",
            messageId: "m_1",
            type: "code",
            title: "rescued",
            content: "x",
            version: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        artifactVersions: {},
      })
    )

    startArtifactDexieBridge()
    await settle()

    expect(artifactsTable.records.map((r) => r.id)).toEqual(["rescued"])
    // Cleared only after the write landed.
    expect(window.localStorage.getItem(ARTIFACT_MIGRATION_PENDING_KEY)).toBeNull()
    // …and the ISO strings became real Dates on the way into the store.
    expect(artifactStore.getState().artifacts.rescued.createdAt).toBeInstanceOf(Date)
  })

  it("coalesces a burst of edits into one transaction", async () => {
    startArtifactDexieBridge()
    await settle()
    fakeDb.transaction.mockClear()

    for (let i = 0; i < 5; i += 1) {
      artifactStore.setState({
        artifacts: { a: artifact("a", { content: `edit-${i}` }) },
        artifactVersions: {},
      })
    }
    expect(fakeDb.transaction).not.toHaveBeenCalled()

    jest.advanceTimersByTime(ARTIFACT_SYNC_DEBOUNCE_MS)
    await settle()

    expect(fakeDb.transaction).toHaveBeenCalledTimes(1)
    expect(artifactsTable.records[0].content).toBe("edit-4")
  })

  it("ignores a store write that touched neither map", async () => {
    startArtifactDexieBridge()
    await settle()
    fakeDb.transaction.mockClear()

    const current = artifactStore.getState()
    artifactStore.setState({ ...current })
    jest.advanceTimersByTime(ARTIFACT_SYNC_DEBOUNCE_MS)
    await settle()

    expect(fakeDb.transaction).not.toHaveBeenCalled()
  })

  it("refuses to write into a database the mirror was not built against", async () => {
    // Locking an account clears the Dexie selection BEFORE it clears the store,
    // so a live subscription sees an empty store pointed at another database.
    // Writing there would delete every row in it.
    artifactStore._reset({ artifacts: { a: artifact("a") }, artifactVersions: {} })
    startArtifactDexieBridge()
    await settle()
    expect(artifactsTable.records).toHaveLength(1)

    const otherDb = { ...fakeDb, name: "cognia-account-acct_b" }
    getDbImpl = () => otherDb as unknown
    artifactStore.setState({ artifacts: {}, artifactVersions: {} })
    jest.advanceTimersByTime(ARTIFACT_SYNC_DEBOUNCE_MS)
    await settle()

    expect(artifactsTable.records).toHaveLength(1)
  })

  it("disables the mirror when hydration fails instead of deleting the table", async () => {
    artifactsTable.toArray.mockRejectedValueOnce(new Error("DatabaseClosedError"))
    artifactsTable.records.push({
      id: "survivor",
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "s",
      content: "c",
      version: 1,
      createdAt: 1,
      updatedAt: 2,
    })

    startArtifactDexieBridge()
    await settle()

    artifactStore.setState({ artifacts: {}, artifactVersions: {} })
    jest.advanceTimersByTime(ARTIFACT_SYNC_DEBOUNCE_MS)
    await settle()

    expect(artifactsTable.records.map((r) => r.id)).toEqual(["survivor"])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("mirror disabled"),
      expect.objectContaining({ err: expect.stringContaining("DatabaseClosedError") })
    )
  })

  it("flushes a pending write when the bridge is disposed", async () => {
    const dispose = startArtifactDexieBridge()
    await settle()
    fakeDb.transaction.mockClear()

    artifactStore.setState({ artifacts: { a: artifact("a") }, artifactVersions: {} })
    dispose()
    await settle()

    expect(artifactsTable.records.map((r) => r.id)).toEqual(["a"])
  })

  it("is idempotent while running and restartable after disposal", async () => {
    const first = startArtifactDexieBridge()
    await settle()
    const second = startArtifactDexieBridge()
    expect(second()).toBeUndefined()

    first()
    artifactStore._reset({ artifacts: { later: artifact("later") }, artifactVersions: {} })
    startArtifactDexieBridge()
    await settle()

    expect(artifactsTable.records.map((r) => r.id)).toEqual(["later"])
  })
})
