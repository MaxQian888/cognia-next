import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createTwin, getTwin, setTwinEmbeddingIndex } from "@/lib/db/twins"
import { createTwinChunk } from "@/lib/db/twin-chunks"
import type { Twin, TwinRuntimeEmbeddingSettings } from "@/types/twin"
import { buildTwinEmbeddingIndexRecord } from "./twin-embedding"
import {
  TwinEmbeddingRebuildRequiredError,
  TwinEmbeddingUnconfiguredError,
  assertTwinIngestCompatible,
  computeTwinEmbeddingStatus,
  countTwinChunksOutsideSources,
  getTwinEmbeddingStatus,
  loadTwinEmbeddingPlan,
  recordTwinEmbeddingIndexAfterIngest,
  type TwinEmbeddingStatusDeps,
} from "./twin-embedding-status"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const GLOBAL: TwinRuntimeEmbeddingSettings = {
  provider: "openai",
  model: "text-embedding-3-small",
  apiKey: "sk-global",
}

const COHERE_INDEX = buildTwinEmbeddingIndexRecord({
  provider: "cohere",
  model: "embed-english-v3.0",
  dimensions: 1024,
  builtAt: 100,
})

async function addChunk(twinId: string, sourceId: string, n: number): Promise<void> {
  await createTwinChunk({
    twinId,
    sourceId,
    content: `c${n}`,
    contentRedacted: `c${n}`,
    charStart: 0,
    charEnd: 2,
    vectorBackend: "native",
    vectorCollection: `cognia_twin_${twinId}`,
    vectorDocId: `${twinId}_${sourceId}_${n}`,
    strategy: "paragraph",
    tokenCount: 1,
    metadata: {},
  })
}

function ioDeps(twin: Twin | undefined, providerSettings = {}) {
  return {
    getTwin: jest.fn(async () => twin),
    loadProviderSettings: jest.fn(async () => providerSettings),
  }
}

describe("loadTwinEmbeddingPlan", () => {
  it("falls back to the global config for an unknown twin", async () => {
    const deps = ioDeps(undefined)
    const plan = await loadTwinEmbeddingPlan("missing", GLOBAL, deps)
    expect(plan).toMatchObject({ source: "global", config: GLOBAL, rebuildRequired: false })
    expect(plan.twin).toBeUndefined()
    expect(deps.loadProviderSettings).not.toHaveBeenCalled()
  })

  it("resolves the override with provider settings and flags a mismatched index", async () => {
    const twin: Twin = {
      id: "t1",
      name: "T",
      createdAt: 1,
      updatedAt: 1,
      embedding: { provider: "mistral" },
      embeddingIndex: COHERE_INDEX,
    }
    const deps = ioDeps(twin, { mistral: { apiKey: "mi-key" } })
    const plan = await loadTwinEmbeddingPlan("t1", GLOBAL, deps)
    expect(plan.source).toBe("twin")
    expect(plan.config).toMatchObject({
      provider: "mistral",
      model: "mistral-embed",
      apiKey: "mi-key",
    })
    expect(plan.credentialsReady).toBe(true)
    expect(plan.index).toEqual(COHERE_INDEX)
    expect(plan.rebuildRequired).toBe(true)
    expect(deps.loadProviderSettings).toHaveBeenCalledTimes(1)
  })

  it("skips the provider-settings read when the override keeps the global provider", async () => {
    const twin: Twin = {
      id: "t1",
      name: "T",
      createdAt: 1,
      updatedAt: 1,
      embedding: { provider: "openai", model: "text-embedding-3-large" },
    }
    const deps = ioDeps(twin)
    const plan = await loadTwinEmbeddingPlan("t1", GLOBAL, deps)
    expect(plan.config).toEqual({ ...GLOBAL, model: "text-embedding-3-large" })
    expect(deps.loadProviderSettings).not.toHaveBeenCalled()
  })

  it("reads the real twin row by default", async () => {
    const twin = await createTwin({ name: "Real", embedding: { provider: "openai", model: "m2" } })
    const plan = await loadTwinEmbeddingPlan(twin.id, GLOBAL)
    expect(plan.config.model).toBe("m2")
    expect(plan.twin?.id).toBe(twin.id)
  })
})

describe("chunk ownership + ingest pre-flight", () => {
  it("counts chunks that belong to sources outside the given set", async () => {
    const twin = await createTwin({ name: "C" })
    await addChunk(twin.id, "s1", 1)
    await addChunk(twin.id, "s1", 2)
    await addChunk(twin.id, "s2", 3)
    await addChunk("other-twin", "s1", 4)
    expect(await countTwinChunksOutsideSources(twin.id, ["s1"])).toBe(1)
    expect(await countTwinChunksOutsideSources(twin.id, ["s1", "s2"])).toBe(0)
    expect(await countTwinChunksOutsideSources("empty", ["s1"])).toBe(0)
  })

  it("refuses an override without credentials", async () => {
    const twin = await createTwin({ name: "C", embedding: { provider: "cohere" } })
    const plan = await loadTwinEmbeddingPlan(twin.id, GLOBAL, {
      getTwin,
      loadProviderSettings: async () => ({}),
    })
    await expect(assertTwinIngestCompatible(plan, [])).rejects.toBeInstanceOf(
      TwinEmbeddingUnconfiguredError
    )
  })

  it("refuses to mix models while chunks from the recorded model survive the job", async () => {
    const twin = await createTwin({ name: "C" })
    await setTwinEmbeddingIndex(twin.id, COHERE_INDEX)
    await addChunk(twin.id, "s1", 1)
    await addChunk(twin.id, "s2", 2)
    const plan = await loadTwinEmbeddingPlan(twin.id, GLOBAL)
    expect(plan.rebuildRequired).toBe(true)

    const refused = assertTwinIngestCompatible(plan, ["s1"])
    await expect(refused).rejects.toBeInstanceOf(TwinEmbeddingRebuildRequiredError)
    await expect(assertTwinIngestCompatible(plan, ["s1"])).rejects.toThrow(/^rebuild-required:/)
    // A job that replaces every chunk of the twin is itself a rebuild.
    await expect(assertTwinIngestCompatible(plan, ["s1", "s2"])).resolves.toBeUndefined()
  })

  it("lets a legacy twin (no record) ingest as before", async () => {
    const twin = await createTwin({ name: "C" })
    await addChunk(twin.id, "s1", 1)
    const plan = await loadTwinEmbeddingPlan(twin.id, GLOBAL)
    await expect(assertTwinIngestCompatible(plan, ["s2"])).resolves.toBeUndefined()
  })
})

describe("recordTwinEmbeddingIndexAfterIngest", () => {
  const openai = { provider: "openai" as const, model: "text-embedding-3-small" }

  it("stamps the record when every chunk of the twin came from this job", async () => {
    const twin = await createTwin({ name: "R" })
    await addChunk(twin.id, "s1", 1)
    const record = await recordTwinEmbeddingIndexAfterIngest({
      twinId: twin.id,
      embedding: openai,
      dimensions: 1536,
      writtenSourceIds: ["s1"],
      now: 42,
    })
    expect(record).toEqual({
      ...openai,
      dimensions: 1536,
      fingerprint: "openai::text-embedding-3-small::1536",
      builtAt: 42,
    })
    expect((await getTwin(twin.id))?.embeddingIndex).toEqual(record)
  })

  it("leaves a legacy index unrecorded while older chunks remain", async () => {
    const twin = await createTwin({ name: "R" })
    await addChunk(twin.id, "old", 1)
    await addChunk(twin.id, "s1", 2)
    const record = await recordTwinEmbeddingIndexAfterIngest({
      twinId: twin.id,
      embedding: openai,
      dimensions: 1536,
      writtenSourceIds: ["s1"],
    })
    expect(record).toBeUndefined()
    expect((await getTwin(twin.id))?.embeddingIndex).toBeUndefined()
  })

  it("refreshes a matching record even when other sources keep their chunks", async () => {
    const twin = await createTwin({ name: "R" })
    await setTwinEmbeddingIndex(
      twin.id,
      buildTwinEmbeddingIndexRecord({ ...openai, dimensions: 1536, builtAt: 1 })
    )
    await addChunk(twin.id, "old", 1)
    await addChunk(twin.id, "s1", 2)
    const record = await recordTwinEmbeddingIndexAfterIngest({
      twinId: twin.id,
      embedding: openai,
      dimensions: 1536,
      writtenSourceIds: ["s1"],
      now: 99,
    })
    expect(record?.builtAt).toBe(99)
  })

  it("does nothing when no chunk was embedded", async () => {
    const twin = await createTwin({ name: "R" })
    expect(
      await recordTwinEmbeddingIndexAfterIngest({
        twinId: twin.id,
        embedding: openai,
        dimensions: undefined,
        writtenSourceIds: ["s1"],
      })
    ).toBeUndefined()
    expect(
      await recordTwinEmbeddingIndexAfterIngest({
        twinId: "missing",
        embedding: openai,
        dimensions: 3,
        writtenSourceIds: ["s1"],
      })
    ).toBeUndefined()
  })
})

describe("twin embedding status", () => {
  it("computes a legacy status for chunks without a record", () => {
    const status = computeTwinEmbeddingStatus({
      twinId: "t",
      twin: { id: "t", name: "T", createdAt: 1, updatedAt: 1 },
      global: GLOBAL,
      chunkCount: 3,
    })
    expect(status).toEqual({
      twinId: "t",
      exists: true,
      source: "global",
      effective: { provider: "openai", model: "text-embedding-3-small", expectedDimensions: 1536 },
      global: { provider: "openai", model: "text-embedding-3-small" },
      credentialsReady: true,
      chunkCount: 3,
      legacyIndex: true,
      rebuildRequired: false,
    })
  })

  it("getTwinEmbeddingStatus reports the override, the record and rebuild-required", async () => {
    const twin: Twin = {
      id: "t",
      name: "T",
      createdAt: 1,
      updatedAt: 1,
      embedding: { provider: "voyage" },
      embeddingIndex: COHERE_INDEX,
    }
    const deps: TwinEmbeddingStatusDeps = {
      getTwin: jest.fn(async () => twin),
      loadProviderSettings: jest.fn(async () => ({})),
      getGlobalEmbedding: jest.fn(async () => GLOBAL),
      countChunks: jest.fn(async () => 12),
    }
    const status = await getTwinEmbeddingStatus("t", deps)
    expect(status).toMatchObject({
      exists: true,
      source: "twin",
      effective: { provider: "voyage", model: "voyage-3" },
      override: { provider: "voyage" },
      index: COHERE_INDEX,
      chunkCount: 12,
      legacyIndex: false,
      rebuildRequired: true,
      // No shared key for voyage when the global provider is openai.
      credentialsReady: false,
    })
    expect(deps.loadProviderSettings).toHaveBeenCalledTimes(1)
  })

  it("getTwinEmbeddingStatus reports a missing twin with the global config", async () => {
    const status = await getTwinEmbeddingStatus("nope", {
      getTwin: async () => undefined,
      loadProviderSettings: async () => ({}),
      getGlobalEmbedding: async () => GLOBAL,
      countChunks: async () => 0,
    })
    expect(status).toMatchObject({
      exists: false,
      source: "global",
      legacyIndex: false,
      rebuildRequired: false,
    })
  })
})
