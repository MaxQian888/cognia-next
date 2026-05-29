/**
 * Tests for the `twins` Dexie table (schema v29) and its CRUD module.
 * Covers basic CRUD, archive toggling, clone semantics, cascade delete
 * across every twin* table, character detachment, and the v29 upgrade
 * backfill that auto-registers pre-existing twinIds.
 */

import "fake-indexeddb/auto"
import {
  archiveTwin,
  backfillTwinRegistryFromUsage,
  cloneTwin,
  createTwin,
  deleteTwin,
  getTwin,
  listTwins,
  observeTwins,
  renameTwin,
  updateTwin,
} from "./twins"
import { createTwinSource } from "./twin-sources"
import { createTwinChunk } from "./twin-chunks"
import { ensureTwinProfile } from "./twin-profile"
import { createTwinDraft } from "./twin-drafts"
import { createTwinJob } from "./twin-jobs"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import type { Character } from "@/lib/claude/types"
import { syncTwinCronToScheduler } from "@/lib/twin/cron/cron-bridge"

// `deleteTwin` reaches outside the twin Dexie DB to clean up scheduler cron
// tasks + the remote vector collection (T1.3). Both are pulled via dynamic
// import, so mock the modules here.
jest.mock("@/lib/twin/cron/cron-bridge", () => ({
  syncTwinCronToScheduler: jest.fn(async () => ({})),
}))
const mockDeleteCollection = jest.fn(async () => {})
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: jest.fn(async () => ({ store: { deleteCollection: mockDeleteCollection } })),
}))

beforeEach(async () => {
  jest.clearAllMocks()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function buildCharacter(overrides: Partial<Character> = {}): Character {
  const now = Date.now()
  return {
    id: overrides.id ?? `char_${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name ?? "Test Character",
    avatarColor: overrides.avatarColor ?? "oklch(0.7 0.15 250)",
    systemPrompt: overrides.systemPrompt ?? "",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  } as Character
}

async function putCharacter(character: Character): Promise<void> {
  await getDb().characters.put(character)
}

describe("twins CRUD", () => {
  it("creates a twin with defaults", async () => {
    const twin = await createTwin({ name: "Work me" })
    expect(twin.id).toMatch(/^twn_/)
    expect(twin.name).toBe("Work me")
    expect(twin.createdAt).toBeGreaterThan(0)
    expect(twin.updatedAt).toBe(twin.createdAt)
    expect(twin.archived).toBeUndefined()
  })

  it("honors explicit id + timestamps when supplied (used by upgrade hooks)", async () => {
    const twin = await createTwin({
      id: "twin-explicit",
      name: "Mentor",
      createdAt: 100,
      updatedAt: 200,
      color: "#abcdef",
    })
    expect(twin.id).toBe("twin-explicit")
    expect(twin.createdAt).toBe(100)
    expect(twin.updatedAt).toBe(200)
    expect(twin.color).toBe("#abcdef")
  })

  it("getTwin returns undefined for missing rows", async () => {
    expect(await getTwin("does-not-exist")).toBeUndefined()
  })

  it("listTwins hides archived rows by default and orders by updatedAt desc", async () => {
    await createTwin({ id: "a", name: "A", updatedAt: 100 })
    await createTwin({ id: "b", name: "B", updatedAt: 300 })
    await createTwin({ id: "c", name: "C", updatedAt: 200, archived: true })
    const visible = await listTwins()
    expect(visible.map((t) => t.id)).toEqual(["b", "a"])
    const all = await listTwins({ includeArchived: true })
    expect(all.map((t) => t.id)).toEqual(["b", "c", "a"])
  })

  it("observeTwins is the same shape as listTwins (used by useLiveQuery)", async () => {
    await createTwin({ id: "x", name: "X" })
    const a = await observeTwins()
    const b = await listTwins()
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id))
  })

  it("renameTwin trims input and bumps updatedAt", async () => {
    const twin = await createTwin({ name: "Old", updatedAt: 100 })
    const renamed = await renameTwin(twin.id, "  New  ")
    expect(renamed?.name).toBe("New")
    expect(renamed?.updatedAt).toBeGreaterThan(100)
  })

  it("renameTwin rejects empty names", async () => {
    const twin = await createTwin({ name: "Old" })
    await expect(renameTwin(twin.id, "   ")).rejects.toThrow(/non-empty/)
  })

  it("updateTwin patches arbitrary fields and bumps updatedAt", async () => {
    const twin = await createTwin({ name: "X", updatedAt: 100 })
    const patched = await updateTwin(twin.id, { color: "#f00", description: "hi" })
    expect(patched?.color).toBe("#f00")
    expect(patched?.description).toBe("hi")
    expect(patched?.updatedAt).toBeGreaterThan(100)
  })

  it("archiveTwin toggles the boolean", async () => {
    const twin = await createTwin({ name: "X" })
    const archived = await archiveTwin(twin.id)
    expect(archived?.archived).toBe(true)
    const restored = await archiveTwin(twin.id, false)
    expect(restored?.archived).toBe(false)
  })

  it("cloneTwin produces a new row with derived name + fresh ids", async () => {
    const src = await createTwin({ name: "Source", color: "#abc", description: "d" })
    const clone = await cloneTwin(src.id, "")
    expect(clone.id).not.toBe(src.id)
    expect(clone.name).toBe("Source (copy)")
    expect(clone.color).toBe("#abc")
    expect(clone.description).toBe("d")
    const custom = await cloneTwin(src.id, "  My copy  ")
    expect(custom.name).toBe("My copy")
  })

  it("cloneTwin throws when the source row is missing", async () => {
    await expect(cloneTwin("missing", "x")).rejects.toThrow(/not found/)
  })
})

describe("deleteTwin cascade", () => {
  it("wipes every twin* table, detaches characters, and reports counts", async () => {
    const twin = await createTwin({ id: "twin-cascade", name: "C" })

    await createTwinSource({
      twinId: twin.id,
      kind: "document",
      format: "markdown",
      source: "manual",
      title: "doc",
      bytes: 3,
      fingerprint: "fp",
      redacted: false,
    })
    await createTwinChunk({
      twinId: twin.id,
      sourceId: "src-x",
      content: "hello",
      contentRedacted: "hello",
      charStart: 0,
      charEnd: 5,
      vectorBackend: "qdrant",
      vectorCollection: "twin",
      vectorDocId: "doc-1",
      strategy: "paragraph",
      tokenCount: 1,
      metadata: {},
    })
    await ensureTwinProfile(twin.id)
    await createTwinDraft({
      twinId: twin.id,
      jobId: "job-1",
      kind: "character",
      payload: { kind: "character", data: { name: "x" } },
      provenance: { chunkIds: [], rationale: "" },
    })
    await createTwinJob({
      twinId: twin.id,
      kind: "ingest",
      sourceIds: [],
    })

    const character = buildCharacter({ twinId: twin.id })
    await putCharacter(character)

    const result = await deleteTwin(twin.id)
    expect(result.sources).toBe(1)
    expect(result.chunks).toBe(1)
    expect(result.drafts).toBe(1)
    expect(result.jobs).toBe(1)
    expect(result.profileDeleted).toBe(true)
    expect(result.detachedCharacterIds).toEqual([character.id])

    expect(await getTwin(twin.id)).toBeUndefined()
    const detached = await getDb().characters.get(character.id)
    expect(detached?.twinId).toBeUndefined()
    expect(detached?.twinSettings).toBeUndefined()
  })

  it("returns zero counts when there's nothing to cascade", async () => {
    const twin = await createTwin({ name: "Empty" })
    const result = await deleteTwin(twin.id)
    expect(result).toEqual({
      sources: 0,
      chunks: 0,
      drafts: 0,
      jobs: 0,
      profileDeleted: false,
      detachedCharacterIds: [],
    })
  })

  it("removes scheduler cron tasks and drops the remote vector collection (T1.3)", async () => {
    const twin = await createTwin({ id: "twin-cleanup", name: "X" })
    await deleteTwin(twin.id)
    expect(syncTwinCronToScheduler).toHaveBeenCalledWith("twin-cleanup", undefined)
    expect(mockDeleteCollection).toHaveBeenCalledWith("cognia_twin_twin-cleanup")
  })

  it("tolerates cleanup failures without failing the row delete (T1.3)", async () => {
    ;(syncTwinCronToScheduler as jest.Mock).mockRejectedValueOnce(new Error("scheduler down"))
    mockDeleteCollection.mockRejectedValueOnce(new Error("vector store down"))
    const twin = await createTwin({ id: "twin-resilient", name: "Y" })
    await expect(deleteTwin(twin.id)).resolves.toMatchObject({ profileDeleted: false })
    expect(await getTwin("twin-resilient")).toBeUndefined()
  })
})

describe("backfillTwinRegistryFromUsage", () => {
  it("creates registry rows for twinIds seen on existing twin* / character rows", async () => {
    // Seed twin* rows referencing ids that don't yet exist in `twins`.
    await createTwinSource({
      twinId: "from-source",
      kind: "document",
      format: "markdown",
      source: "m",
      title: "t",
      bytes: 1,
      fingerprint: "fp",
      redacted: false,
    })
    await createTwinChunk({
      twinId: "from-chunk",
      sourceId: "x",
      content: "",
      contentRedacted: "",
      charStart: 0,
      charEnd: 0,
      vectorBackend: "qdrant",
      vectorCollection: "c",
      vectorDocId: "d",
      strategy: "paragraph",
      tokenCount: 0,
      metadata: {},
    })
    await ensureTwinProfile("from-profile")
    await createTwinDraft({
      twinId: "from-draft",
      jobId: "j",
      kind: "character",
      payload: { kind: "character", data: {} },
      provenance: { chunkIds: [], rationale: "" },
    })
    await createTwinJob({ twinId: "from-job", kind: "ingest", sourceIds: [] })
    await putCharacter(buildCharacter({ id: "c1", name: "Named", twinId: "from-character" }))

    const created = await backfillTwinRegistryFromUsage()
    const createdIds = new Set(created.map((t) => t.id))
    const expected = [
      "from-source",
      "from-chunk",
      "from-profile",
      "from-draft",
      "from-job",
      "from-character",
    ]
    // Every requested id should have a registry row. Seeded built-in
    // characters may add EXTRA twinIds (e.g. if a future seed binds one),
    // so we assert containment rather than exact equality.
    const missing = expected.filter((id) => !createdIds.has(id))
    expect(missing).toEqual([])
    // Character-backed row borrows the character's name.
    const named = created.find((t) => t.id === "from-character")
    expect(named?.name).toBe("Named")
    // Twin-only rows fall back to the id as the display name.
    const sourceBacked = created.find((t) => t.id === "from-source")
    expect(sourceBacked?.name).toBe("from-source")
  })

  it("is idempotent — re-running with existing rows is a no-op", async () => {
    await createTwin({ id: "preexisting", name: "Already there" })
    await createTwinSource({
      twinId: "preexisting",
      kind: "document",
      format: "markdown",
      source: "m",
      title: "t",
      bytes: 1,
      fingerprint: "fp2",
      redacted: false,
    })
    const created = await backfillTwinRegistryFromUsage()
    expect(created).toEqual([])
    const all = await listTwins()
    expect(all.map((t) => t.id)).toEqual(["preexisting"])
  })
})
