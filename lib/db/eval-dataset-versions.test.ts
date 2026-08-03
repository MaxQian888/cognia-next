import {
  snapshotVersion,
  getVersion,
  listVersions,
  tagVersion,
  restoreVersion,
  deleteVersionsForDataset,
  hashCases,
} from "./eval-dataset-versions"
import {
  createDataset,
  getDataset,
  addCase,
  updateCase,
  listCases,
  deleteCase,
} from "./eval-datasets"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import type { EvalCase } from "@/types/eval/eval"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().evalDatasets.clear()
  await getDb().evalCases.clear()
  await getDb().evalDatasetVersions.clear()
})
afterAll(dbFixture.dispose)

function caseRow(over: Partial<EvalCase>): EvalCase {
  return {
    id: "c",
    datasetId: "d",
    input: "hi",
    capability: "chat",
    source: "handwritten",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe("hashCases", () => {
  it("is order-independent and ignores timestamps", () => {
    const a = caseRow({ id: "1", createdAt: 100, updatedAt: 200 })
    const b = caseRow({ id: "2", input: "yo", createdAt: 5, updatedAt: 9 })
    expect(hashCases([a, b])).toBe(hashCases([b, a]))
    const a2 = { ...a, createdAt: 999, updatedAt: 999 }
    expect(hashCases([a2, b])).toBe(hashCases([a, b]))
  })

  it("changes when content changes", () => {
    const a = caseRow({ id: "1" })
    expect(hashCases([a])).not.toBe(hashCases([caseRow({ id: "1", input: "different" })]))
  })
})

describe("eval-dataset-versions", () => {
  it("snapshots the current case set immutably", async () => {
    const ds = await createDataset({ name: "d", capability: "chat" })
    await addCase(ds.id, { input: "hi", source: "handwritten" })
    const v1 = await snapshotVersion(ds.id)
    expect(v1.id).toMatch(/^evdv_/)
    expect(v1.caseIds).toHaveLength(1)
    expect(v1.casesHash).toMatch(/.+/)

    // adding a case after the snapshot must NOT mutate the snapshot
    await addCase(ds.id, { input: "again", source: "handwritten" })
    const reloaded = await getVersion(v1.id)
    expect(reloaded?.caseIds).toHaveLength(1)
  })

  it("dedups identical snapshots within the same dataset version", async () => {
    const ds = await createDataset({ name: "d", capability: "chat" })
    await addCase(ds.id, { input: "hi", source: "handwritten" })
    const a = await snapshotVersion(ds.id)
    const b = await snapshotVersion(ds.id)
    expect(b.id).toBe(a.id)
    expect(await listVersions(ds.id)).toHaveLength(1)
  })

  it("creates a new snapshot when the dataset version bumps", async () => {
    const ds = await createDataset({ name: "d", capability: "chat" })
    await addCase(ds.id, { input: "hi", source: "handwritten" })
    const a = await snapshotVersion(ds.id)
    // addCase bumps dataset.version → a new version → new snapshot id
    await addCase(ds.id, { input: "second", source: "handwritten" })
    const b = await snapshotVersion(ds.id)
    expect(b.id).not.toBe(a.id)
    expect(b.caseIds).toHaveLength(2)
  })

  it("throws on a missing dataset", async () => {
    await expect(snapshotVersion("nope")).rejects.toThrow(/not found/)
  })

  it("tags and untags a version, newest-first listing", async () => {
    const ds = await createDataset({ name: "d", capability: "chat" })
    const v = await snapshotVersion(ds.id)
    await tagVersion(v.id, "prod")
    expect((await getVersion(v.id))?.tag).toBe("prod")
    await tagVersion(v.id, "")
    expect((await getVersion(v.id))?.tag).toBeUndefined()
    await tagVersion("missing", "x") // no-op
  })

  it("returns [] / undefined for empty ids and deletes by dataset", async () => {
    expect(await listVersions("")).toEqual([])
    expect(await getVersion("")).toBeUndefined()
    const ds = await createDataset({ name: "d", capability: "chat" })
    await snapshotVersion(ds.id)
    await deleteVersionsForDataset(ds.id)
    expect(await listVersions(ds.id)).toHaveLength(0)
    await deleteVersionsForDataset("") // no-op
  })

  it("stores case IDS, not full frozen copies", async () => {
    // Snapshots used to duplicate every case's text. Each case edit bumps the
    // dataset version and the next run snapshots it, so a thousand-case
    // benchmark wrote about half a megabyte per edit-then-run cycle for data
    // already sitting in `evalCases`.
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    const a = await addCase(ds.id, { input: "first", source: "handwritten" })
    const b = await addCase(ds.id, { input: "second", source: "handwritten" })
    const version = await snapshotVersion(ds.id)
    // Order-insensitive: `listCases` sorts by createdAt, and two cases added in
    // the same millisecond tie.
    expect([...version.caseIds].sort()).toEqual([a.id, b.id].sort())
    expect(version.cases).toBeUndefined()
    expect(version.casesHash).toBeTruthy()
  })

  it("still yields a new snapshot when case CONTENT changes under the same ids", async () => {
    // The hash pins content, so editing a case in place is still a new version.
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    const c = await addCase(ds.id, { input: "first", source: "handwritten" })
    const before = await snapshotVersion(ds.id)
    await updateCase(c.id, { input: "edited" })
    const after = await snapshotVersion(ds.id)
    expect(after.caseIds).toEqual(before.caseIds)
    expect(after.casesHash).not.toBe(before.casesHash)
    expect(after.id).not.toBe(before.id)
  })
})

describe("restoreVersion", () => {
  it("deletes cases added since the snapshot and bumps the version once", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    const a = await addCase(ds.id, { input: "first", source: "handwritten" })
    const snap = await snapshotVersion(ds.id)
    await addCase(ds.id, { input: "second", source: "handwritten" })
    await addCase(ds.id, { input: "third", source: "handwritten" })
    const versionBefore = (await getDataset(ds.id))!.version

    const result = await restoreVersion(snap.id)
    expect(result).toEqual({ deleted: 2, readded: 0 })
    expect((await listCases(ds.id)).map((c) => c.id)).toEqual([a.id])
    // A restore is ONE version bump, like any other edit — not two per case.
    expect((await getDataset(ds.id))!.version).toBe(versionBefore + 1)
  })

  it("cannot resurrect a case an id-only snapshot did not copy", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    const a = await addCase(ds.id, { input: "first", source: "handwritten" })
    const b = await addCase(ds.id, { input: "second", source: "handwritten" })
    const snap = await snapshotVersion(ds.id)
    await deleteCase(b.id)

    const result = await restoreVersion(snap.id)
    // `b` is gone from the dataset and the snapshot kept no copy, so restore
    // leaves it deleted rather than silently dropping the request.
    expect(result.readded).toBe(0)
    expect((await listCases(ds.id)).map((c) => c.id)).toEqual([a.id])
  })

  it("re-adds a deleted case from a legacy full-copy snapshot", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    const a = await addCase(ds.id, { input: "first", source: "handwritten" })
    const b = await addCase(ds.id, { input: "second", source: "handwritten" })
    // Simulate a pre-slimming snapshot by writing the copies onto the row.
    const snap = await snapshotVersion(ds.id)
    await getDb().evalDatasetVersions.put({
      ...snap,
      cases: [
        { ...a, createdAt: 1, updatedAt: 1 },
        { ...b, createdAt: 1, updatedAt: 1 },
      ],
    })
    await deleteCase(b.id)

    const result = await restoreVersion(snap.id)
    expect(result.readded).toBe(1)
    expect((await listCases(ds.id)).map((c) => c.id).sort()).toEqual([a.id, b.id].sort())
  })

  it("no-ops (no version bump) when the dataset already matches", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    await addCase(ds.id, { input: "first", source: "handwritten" })
    const snap = await snapshotVersion(ds.id)
    const versionBefore = (await getDataset(ds.id))!.version
    expect(await restoreVersion(snap.id)).toEqual({ deleted: 0, readded: 0 })
    expect((await getDataset(ds.id))!.version).toBe(versionBefore)
  })

  it("rejects an unknown version id", async () => {
    await expect(restoreVersion("ghost")).rejects.toThrow(/not found/)
  })
})
