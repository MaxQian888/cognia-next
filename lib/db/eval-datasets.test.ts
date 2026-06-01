import "fake-indexeddb/auto"
import {
  createDataset,
  getDataset,
  listDatasets,
  listDatasetsByCapability,
  updateDataset,
  deleteDataset,
  addCase,
  getCase,
  listCases,
  updateCase,
  deleteCase,
} from "./eval-datasets"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().evalDatasets.clear()
  await getDb().evalCases.clear()
})

describe("dataset CRUD", () => {
  it("creates a dataset with a generated id, version 1 and timestamps", async () => {
    const ds = await createDataset({ name: "Tool use", capability: "chat.tool-use" })
    expect(ds.id).toMatch(/^evds_/)
    expect(ds.version).toBe(1)
    expect(ds.createdAt).toBeGreaterThan(0)
    expect(await getDataset(ds.id)).toMatchObject({ name: "Tool use" })
  })

  it("lists datasets and filters by capability", async () => {
    await createDataset({ name: "A", capability: "chat.tool-use" })
    await createDataset({ name: "B", capability: "chat.rag" })
    expect(await listDatasets()).toHaveLength(2)
    const ragOnly = await listDatasetsByCapability("chat.rag")
    expect(ragOnly.map((d) => d.name)).toEqual(["B"])
  })

  it("updates name/description and bumps updatedAt without changing version", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.tool-use" })
    const updated = await updateDataset(ds.id, { description: "now described" })
    expect(updated?.description).toBe("now described")
    expect(updated?.version).toBe(1)
  })

  it("deletes a dataset and cascades its cases", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.tool-use" })
    await addCase(ds.id, { input: "x", source: "handwritten" })
    await deleteDataset(ds.id)
    expect(await getDataset(ds.id)).toBeUndefined()
    expect(await listCases(ds.id)).toHaveLength(0)
  })
})

describe("case CRUD", () => {
  it("adds a case with a generated id, inheriting the dataset capability", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.tool-use" })
    const c = await addCase(ds.id, { input: "do x", source: "handwritten" })
    expect(c.id).toMatch(/^evc_/)
    expect(c.datasetId).toBe(ds.id)
    expect(c.capability).toBe("chat.tool-use")
  })

  it("bumps the dataset version on add / update / delete", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.tool-use" })
    const c = await addCase(ds.id, { input: "x", source: "handwritten" })
    expect((await getDataset(ds.id))?.version).toBe(2)
    await updateCase(c.id, { input: "y" })
    expect((await getDataset(ds.id))?.version).toBe(3)
    await deleteCase(c.id)
    expect((await getDataset(ds.id))?.version).toBe(4)
  })

  it("lists cases for a dataset in creation order", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.tool-use" })
    await addCase(ds.id, { input: "first", source: "handwritten", createdAt: 1 })
    await addCase(ds.id, { input: "second", source: "handwritten", createdAt: 2 })
    const cases = await listCases(ds.id)
    expect(cases.map((c) => c.input)).toEqual(["first", "second"])
  })

  it("preserves a reference and source-trace linkage on the case", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.tool-use" })
    const c = await addCase(ds.id, {
      input: "x",
      source: "real-trace",
      sourceTraceId: "trace-9",
      reference: { expectedTools: ["Read"] },
    })
    expect(await getCase(c.id)).toMatchObject({
      sourceTraceId: "trace-9",
      reference: { expectedTools: ["Read"] },
    })
  })
})
