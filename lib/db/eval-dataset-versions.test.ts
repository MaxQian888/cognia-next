import "fake-indexeddb/auto"
import {
  snapshotVersion,
  getVersion,
  listVersions,
  tagVersion,
  deleteVersionsForDataset,
  hashCases,
} from "./eval-dataset-versions"
import { createDataset, addCase } from "./eval-datasets"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import type { EvalCase } from "@/types/eval/eval"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().evalDatasets.clear()
  await getDb().evalCases.clear()
  await getDb().evalDatasetVersions.clear()
})

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
    expect(v1.cases).toHaveLength(1)
    expect(v1.casesHash).toMatch(/.+/)

    // adding a case after the snapshot must NOT mutate the snapshot
    await addCase(ds.id, { input: "again", source: "handwritten" })
    const reloaded = await getVersion(v1.id)
    expect(reloaded?.cases).toHaveLength(1)
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
    expect(b.cases).toHaveLength(2)
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
})
