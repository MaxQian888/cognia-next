/** @jest-environment jsdom */
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
import { saveRun, listRunsByDataset } from "./eval-runs"
import { saveCaseResult, listCaseResults } from "./eval-run-cases"
import { snapshotVersion, listVersions } from "./eval-dataset-versions"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().evalDatasets.clear()
  await getDb().evalCases.clear()
  await getDb().evalRuns.clear()
  await getDb().evalRunCaseResults.clear()
  await getDb().evalDatasetVersions.clear()
}, 30_000) // cold-open of the fake-idb schema (v97+) can exceed the 5s default.

describe("dataset CRUD", () => {
  it("creates a dataset with a generated id, version 1 and timestamps", async () => {
    const ds = await createDataset({ name: "Tool use", capability: "chat.tool-use" })
    expect(ds.id).toMatch(/^evds_/)
    expect(ds.version).toBe(1)
    expect(ds.createdAt).toBeGreaterThan(0)
    expect(await getDataset(ds.id)).toMatchObject({ name: "Tool use" })
  })

  it("stamps a provided gate template onto the new dataset", async () => {
    const ds = await createDataset({
      name: "Gated",
      capability: "chat.tool-use",
      gate: { minPassAt1: 0.8 },
    })
    expect((await getDataset(ds.id))?.gate).toEqual({ minPassAt1: 0.8 })
  })

  it("omits the gate when the template is empty", async () => {
    const ds = await createDataset({ name: "Ungated", capability: "chat.tool-use", gate: {} })
    expect((await getDataset(ds.id))?.gate).toBeUndefined()
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

  it("updateDataset persists gate thresholds", async () => {
    const ds = await createDataset({ name: "g", capability: "chat.tool-use" })
    const next = await updateDataset(ds.id, { gate: { minPassAt1: 0.8 } })
    expect(next?.gate).toEqual({ minPassAt1: 0.8 })
    expect((await getDataset(ds.id))?.gate).toEqual({ minPassAt1: 0.8 })
  })

  it("deletes a dataset and cascades its cases", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.tool-use" })
    await addCase(ds.id, { input: "x", source: "handwritten" })
    await deleteDataset(ds.id)
    expect(await getDataset(ds.id)).toBeUndefined()
    expect(await listCases(ds.id)).toHaveLength(0)
  })

  it("deletes a dataset and cascades its runs, case verdicts and version snapshots", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.tool-use" })
    await addCase(ds.id, { input: "x", source: "handwritten" })
    await snapshotVersion(ds.id)
    await saveRun({
      runId: "run-1",
      datasetId: ds.id,
      datasetVersion: 1,
      targetLabel: "opus",
      k: 1,
      caseCount: 1,
      scorers: {},
      passAt1: 1,
      passHatK: 1,
      totalCostUsd: 0,
      avgLatencyMs: 1,
      createdAt: Date.now(),
    })
    await saveCaseResult({ runId: "run-1", caseId: "c1", scores: {}, passAt1: true })

    await deleteDataset(ds.id)

    expect(await getDataset(ds.id)).toBeUndefined()
    expect(await listCases(ds.id)).toHaveLength(0)
    expect(await listRunsByDataset(ds.id)).toHaveLength(0)
    expect(await listCaseResults("run-1")).toHaveLength(0)
    expect(await listVersions(ds.id)).toHaveLength(0)
  })

  it("deleteDataset is a no-op for a missing id", async () => {
    await expect(deleteDataset("")).resolves.toBeUndefined()
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

  it("persists optional authoring metadata when adding a case", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.tool-use" })
    const c = await addCase(ds.id, {
      input: "x",
      source: "handwritten",
      split: "regression",
      tags: ["release", "tools"],
      notes: "Release gate regression case",
      metadata: { owner: "release" },
      inputVars: { branch: "main" },
    })

    expect(await getCase(c.id)).toMatchObject({
      split: "regression",
      tags: ["release", "tools"],
      notes: "Release gate regression case",
      metadata: { owner: "release" },
      inputVars: { branch: "main" },
    })
  })
})
