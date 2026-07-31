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
  bulkAddCases,
  importedCaseId,
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
  await getDb().evalAssets.clear()
}, 30_000) // cold-open of the fake-idb schema (v97+) can exceed the 5s default.

async function seedEvalAsset(digest: string): Promise<void> {
  await getDb().evalAssets.put({
    digest,
    mediaType: digest.includes("document") ? "application/pdf" : "image/png",
    size: 1,
    encryptedBytes: {
      version: "cognia-eval-encrypted/v1",
      algorithm: "AES-GCM",
      iv: "iv",
      ciphertext: "ciphertext",
    },
    referenceCount: 0,
    createdAt: 1,
    expiresAt: 10,
  })
}

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
      gradedCaseCount: 1,
      ungradedCaseCount: 0,
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
    await seedEvalAsset("asset-1")
    const c = await addCase(ds.id, {
      input: "x",
      source: "handwritten",
      split: "regression",
      tags: ["release", "tools"],
      notes: "Release gate regression case",
      metadata: { owner: "release" },
      inputVars: { branch: "main" },
      contentParts: [
        { type: "text", text: "inspect this" },
        { type: "asset", assetId: "asset-1", mediaType: "image/png", privacy: "scanned" },
      ],
    })

    expect(await getCase(c.id)).toMatchObject({
      split: "regression",
      tags: ["release", "tools"],
      notes: "Release gate regression case",
      metadata: { owner: "release" },
      inputVars: { branch: "main" },
      contentParts: [
        { type: "text", text: "inspect this" },
        { type: "asset", assetId: "asset-1", mediaType: "image/png", privacy: "scanned" },
      ],
    })
    expect((await getDb().evalAssets.get("asset-1"))?.referenceCount).toBe(1)
  })

  it("maintains attachment references across case updates and deletion", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.image" })
    await seedEvalAsset("asset-1")
    await seedEvalAsset("asset-2")
    const created = await addCase(ds.id, {
      input: "inspect",
      source: "handwritten",
      contentParts: [
        { type: "asset", assetId: "asset-1", mediaType: "image/png", privacy: "local-only" },
      ],
    })
    await updateCase(created.id, {
      contentParts: [
        { type: "asset", assetId: "asset-2", mediaType: "image/png", privacy: "manual" },
      ],
    })
    expect((await getDb().evalAssets.get("asset-1"))?.referenceCount).toBe(0)
    expect((await getDb().evalAssets.get("asset-2"))?.referenceCount).toBe(1)
    await deleteCase(created.id)
    expect((await getDb().evalAssets.get("asset-2"))?.referenceCount).toBe(0)
  })

  it("rejects a case that references an attachment that was never ingested", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.image" })
    await expect(
      addCase(ds.id, {
        input: "inspect",
        source: "handwritten",
        contentParts: [
          {
            type: "asset",
            assetId: "missing",
            mediaType: "image/png",
            privacy: "local-only",
          },
        ],
      })
    ).rejects.toThrow(/unavailable/i)
    expect(await listCases(ds.id)).toHaveLength(0)
  })
})

describe("bulkAddCases", () => {
  const rows = (n: number, prefix = "row") =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}-${i}`,
      input: `question ${i}`,
      source: "handwritten" as const,
      split: "test",
      reference: { expectedOutput: String(i), grading: { mode: "numeric" as const } },
    }))

  it("writes every case and bumps the dataset version exactly once", async () => {
    const ds = await createDataset({ name: "GSM8K", capability: "chat.qa" })
    const res = await bulkAddCases(ds.id, rows(450), { upsertBySourceId: true })

    expect(res).toEqual({ added: 450, updated: 0 })
    expect(await listCases(ds.id)).toHaveLength(450)
    // 450 rows span three chunks, but the version moves 1 → 2, not 1 → 451.
    // Per-case addCase would have bumped it once per row.
    expect((await getDataset(ds.id))?.version).toBe(2)
  })

  it("carries split, reference and grading through", async () => {
    const ds = await createDataset({ name: "GSM8K", capability: "chat.qa" })
    await bulkAddCases(ds.id, rows(1), { upsertBySourceId: true })
    expect((await listCases(ds.id))[0]).toMatchObject({
      split: "test",
      capability: "chat.qa",
      reference: { expectedOutput: "0", grading: { mode: "numeric" } },
    })
  })

  it("is idempotent by source id — re-importing converges instead of doubling", async () => {
    const ds = await createDataset({ name: "GSM8K", capability: "chat.qa" })
    await bulkAddCases(ds.id, rows(10), { upsertBySourceId: true })
    const first = await listCases(ds.id)

    const second = await bulkAddCases(ds.id, rows(10), { upsertBySourceId: true })
    expect(second).toEqual({ added: 0, updated: 10 })
    expect(await listCases(ds.id)).toHaveLength(10)
    // The original creation timestamps survive a re-import.
    expect((await listCases(ds.id)).map((c) => c.createdAt)).toEqual(first.map((c) => c.createdAt))
  })

  it("namespaces ids per dataset so two datasets can import the same benchmark", async () => {
    const a = await createDataset({ name: "A", capability: "chat.qa" })
    const b = await createDataset({ name: "B", capability: "chat.qa" })
    await bulkAddCases(a.id, rows(3), { upsertBySourceId: true })
    await bulkAddCases(b.id, rows(3), { upsertBySourceId: true })
    expect(await listCases(a.id)).toHaveLength(3)
    expect(await listCases(b.id)).toHaveLength(3)
    expect(importedCaseId(a.id, "row-0")).not.toBe(importedCaseId(b.id, "row-0"))
  })

  it("generates fresh ids when not upserting, so the same input can be added twice", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    await bulkAddCases(ds.id, rows(3))
    await bulkAddCases(ds.id, rows(3))
    // Without upsert the caller's ids are used verbatim, so these collide by
    // design — the import wizard only passes ids when upserting.
    expect((await listCases(ds.id)).length).toBe(3)

    await bulkAddCases(
      ds.id,
      rows(3).map(({ id: _drop, ...rest }) => rest)
    )
    expect((await listCases(ds.id)).length).toBe(6)
  })

  it("reports progress per chunk", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    const seen: number[] = []
    await bulkAddCases(ds.id, rows(450), {
      upsertBySourceId: true,
      onProgress: (written) => seen.push(written),
    })
    expect(seen).toEqual([200, 400, 450])
  })

  it("stops between chunks when aborted, keeping what already landed", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    const controller = new AbortController()
    await bulkAddCases(ds.id, rows(450), {
      upsertBySourceId: true,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
    expect(await listCases(ds.id)).toHaveLength(200)
    // A partial import still advances the version — the dataset did change.
    expect((await getDataset(ds.id))?.version).toBe(2)
  })

  it("no-ops on an empty list and rejects an unknown dataset", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    expect(await bulkAddCases(ds.id, [])).toEqual({ added: 0, updated: 0 })
    expect((await getDataset(ds.id))?.version).toBe(1)
    await expect(bulkAddCases("ghost", rows(1))).rejects.toThrow(/not found/)
  })
})

describe("dataset defaultGrading", () => {
  it("remembers the last import rule without affecting scoring", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    await updateDataset(ds.id, { defaultGrading: { mode: "choice", alphabet: "ABCD" } })
    expect((await getDataset(ds.id))?.defaultGrading).toEqual({ mode: "choice", alphabet: "ABCD" })
  })
})

describe("bulkAddCases — optional field coverage", () => {
  it("carries every optional case field through the bulk path", async () => {
    const ds = await createDataset({
      name: "Full",
      description: "everything",
      capability: "chat.qa",
      gate: { minPassAt1: 0.5 },
    })
    await seedEvalAsset("document-1")
    await bulkAddCases(ds.id, [
      {
        id: "src-1",
        input: "prompt",
        source: "real-trace",
        capability: "chat.other",
        createdAt: 42,
        history: [{ role: "user", content: "earlier" }],
        reference: { expectedTools: ["Read"] },
        failureMode: "wrong-tool",
        sourceTraceId: "tr-1",
        notes: "note",
        tags: ["a"],
        split: "test",
        metadata: { owner: "me" },
        inputVars: { branch: "main" },
        contentParts: [
          { type: "text", text: "prompt" },
          {
            type: "asset",
            assetId: "document-1",
            mediaType: "application/pdf",
            privacy: "manual",
          },
        ],
      },
    ])
    expect((await listCases(ds.id))[0]).toMatchObject({
      input: "prompt",
      source: "real-trace",
      capability: "chat.other",
      createdAt: 42,
      history: [{ role: "user", content: "earlier" }],
      reference: { expectedTools: ["Read"] },
      failureMode: "wrong-tool",
      sourceTraceId: "tr-1",
      notes: "note",
      tags: ["a"],
      split: "test",
      metadata: { owner: "me" },
      inputVars: { branch: "main" },
      contentParts: [
        { type: "text", text: "prompt" },
        {
          type: "asset",
          assetId: "document-1",
          mediaType: "application/pdf",
          privacy: "manual",
        },
      ],
    })
  })

  it("defaults capability to the dataset's and omits absent optionals", async () => {
    const ds = await createDataset({ name: "Bare", capability: "chat.qa" })
    await bulkAddCases(ds.id, [{ input: "prompt", source: "handwritten" }])
    const row = (await listCases(ds.id))[0]
    expect(row.capability).toBe("chat.qa")
    for (const key of ["history", "reference", "notes", "tags", "split", "metadata"]) {
      expect(row).not.toHaveProperty(key)
    }
  })
})

describe("guard clauses", () => {
  it("returns undefined for a blank or unknown id instead of throwing", async () => {
    expect(await getDataset("")).toBeUndefined()
    expect(await getDataset("ghost")).toBeUndefined()
    expect(await getCase("")).toBeUndefined()
    expect(await getCase("ghost")).toBeUndefined()
    expect(await listCases("")).toEqual([])
    expect(await updateDataset("ghost", { name: "x" })).toBeUndefined()
    expect(await updateCase("ghost", { input: "x" })).toBeUndefined()
    await expect(deleteCase("ghost")).resolves.toBeUndefined()
    await expect(deleteDataset("")).resolves.toBeUndefined()
  })

  it("does not bump a version when the parent dataset is gone", async () => {
    // A case whose dataset was deleted underneath it must not resurrect a row.
    const ds = await createDataset({ name: "A", capability: "chat.qa" })
    const c = await addCase(ds.id, { input: "x", source: "handwritten" })
    await getDb().evalDatasets.delete(ds.id)
    await expect(updateCase(c.id, { input: "y" })).resolves.toMatchObject({ input: "y" })
    expect(await getDataset(ds.id)).toBeUndefined()
  })
})
