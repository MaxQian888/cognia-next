/** @jest-environment jsdom */
/**
 * Coverage for the distill-completion path of `processJob` — specifically
 * that per-agent `partialFailures` returned by `runDistillJob` are forwarded
 * onto the completed `twinJobs` row (and omitted on a clean run). The full
 * worker lifecycle (claim / backoff / dead-letter) is exercised elsewhere;
 * this suite mocks the distill runner so it can drive the result shape.
 */

import "fake-indexeddb/auto"

const mockRunDistill = jest.fn()
jest.mock("./distill/job-runner", () => ({
  runDistillJob: (...args: unknown[]) => mockRunDistill(...args),
}))

const mockRunIngest = jest.fn()
jest.mock("./ingest/job-runner", () => ({
  runIngestJob: (...args: unknown[]) => mockRunIngest(...args),
}))

import { processJob, type JobWorkerConfig } from "./job-worker"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { cancelJob, createTwinJob, getTwinJob, pauseJob } from "@/lib/db/twin-jobs"
import { createTwin, getTwin, setTwinEmbeddingIndex } from "@/lib/db/twins"
import { createTwinChunk } from "@/lib/db/twin-chunks"
import type { LlmClient } from "./distill/llm"
import type { RunDistillResult } from "./distill/job-runner"

const baseConfig: JobWorkerConfig = {
  embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test" },
  vectorBackend: "native",
  sourceLoader: async () => {
    throw new Error("not used in distill tests")
  },
  llm: {} as LlmClient,
}

const distillResult = (partialFailures: Record<string, string>): RunDistillResult => ({
  draftIds: ["twd_1"],
  llmUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  styleSampleCount: 0,
  playbookCount: 0,
  entityCount: 0,
  llmTokensUsed: 42,
  partialFailures,
})

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().twinJobs.clear()
  mockRunDistill.mockReset()
})

describe("processJob — distill partialFailures forwarding", () => {
  it("persists per-agent partialFailures onto the completed job", async () => {
    mockRunDistill.mockResolvedValue(distillResult({ knowledge: "timed out after 90s" }))
    const job = await createTwinJob({
      twinId: "twin_alice",
      kind: "distill",
      sourceIds: [],
      status: "running",
      phase: "synthesizer",
      progress: 50,
    })
    await processJob(job.id, baseConfig)
    const done = await getTwinJob(job.id)
    expect(done?.status).toBe("completed")
    expect(done?.partialFailures).toEqual({ knowledge: "timed out after 90s" })
  })

  it("omits partialFailures on a clean run", async () => {
    mockRunDistill.mockResolvedValue(distillResult({}))
    const job = await createTwinJob({
      twinId: "twin_alice",
      kind: "distill",
      sourceIds: [],
      status: "running",
      phase: "synthesizer",
      progress: 50,
    })
    await processJob(job.id, baseConfig)
    const done = await getTwinJob(job.id)
    expect(done?.status).toBe("completed")
    expect(done?.partialFailures).toBeUndefined()
  })
})

describe("processJob — ingest nameHints forwarding", () => {
  it("passes config.nameHints through to runIngestJob", async () => {
    mockRunIngest.mockResolvedValue({
      failureSummary: { allFailed: false, failures: [], failureCount: 0 },
      totalEmbeddingTokens: 0,
      totalChunks: 0,
      parsedSourceIds: [],
      writtenSourceIds: [],
    })
    const job = await createTwinJob({
      twinId: "twin_alice",
      kind: "ingest",
      sourceIds: [],
      status: "running",
      phase: "parsing",
      progress: 0,
    })
    await processJob(job.id, {
      ...baseConfig,
      store: { provider: "native" } as never,
      nameHints: ["Carol"],
    })
    expect(mockRunIngest).toHaveBeenCalledTimes(1)
    expect(mockRunIngest.mock.calls[0][0]).toMatchObject({ nameHints: ["Carol"] })
    const done = await getTwinJob(job.id)
    expect(done?.status).toBe("completed")
  })
})

describe("processJob — cooperative running-job control", () => {
  function waitForAbort(input: { signal: AbortSignal }): Promise<RunDistillResult> {
    return new Promise((_, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true })
    })
  }

  it("pauses a running distill without completing or retrying it", async () => {
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    mockRunDistill.mockImplementation((input) => {
      markStarted()
      return waitForAbort(input)
    })
    const job = await createTwinJob({
      twinId: "twin_alice",
      kind: "distill",
      sourceIds: [],
      status: "running",
    })
    const processing = processJob(job.id, baseConfig)
    await started
    await pauseJob(job.id)
    await processing
    expect(await getTwinJob(job.id)).toMatchObject({ status: "paused", phase: "paused" })
  })

  it("cancels a running distill with the existing sentinel format", async () => {
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    mockRunDistill.mockImplementation((input) => {
      markStarted()
      return waitForAbort(input)
    })
    const job = await createTwinJob({
      twinId: "twin_alice",
      kind: "distill",
      sourceIds: [],
      status: "running",
    })
    const processing = processJob(job.id, baseConfig)
    await started
    await cancelJob(job.id, "user request")
    await processing
    expect(await getTwinJob(job.id)).toMatchObject({
      status: "failed",
      phase: "cancelled",
      errorMessage: "[USER_CANCELLED] user request",
    })
  })
})

describe("processJob — per-twin embedding", () => {
  const ingestResult = (overrides: Record<string, unknown> = {}) => ({
    failureSummary: { allFailed: false, failures: [], failureCount: 0 },
    totalEmbeddingTokens: 5,
    totalChunks: 2,
    parsedSourceIds: ["src_1"],
    writtenSourceIds: ["src_1"],
    embeddingDimensions: 3072,
    ...overrides,
  })

  async function ingestJob(twinId: string) {
    return createTwinJob({ twinId, kind: "ingest", sourceIds: [], status: "running" })
  }

  beforeEach(async () => {
    await Promise.all([getDb().twins.clear(), getDb().twinChunks.clear()])
    mockRunIngest.mockReset()
  })

  it("ingests with the twin's override and records what built the index", async () => {
    const twin = await createTwin({
      name: "Override",
      embedding: { provider: "openai", model: "text-embedding-3-large" },
    })
    mockRunIngest.mockResolvedValue(ingestResult())
    const job = await ingestJob(twin.id)

    await processJob(job.id, {
      ...baseConfig,
      store: { provider: "native" } as never,
      now: () => 777,
    })

    expect(mockRunIngest.mock.calls[0][0].embedding).toEqual({
      provider: "openai",
      model: "text-embedding-3-large",
      apiKey: "sk-test",
    })
    expect((await getTwinJob(job.id))?.status).toBe("completed")
    expect((await getTwin(twin.id))?.embeddingIndex).toEqual({
      provider: "openai",
      model: "text-embedding-3-large",
      dimensions: 3072,
      fingerprint: "openai::text-embedding-3-large::3072",
      builtAt: 777,
    })
  })

  it("fails (without retry) instead of mixing models into a recorded index", async () => {
    const twin = await createTwin({ name: "Stale" })
    await setTwinEmbeddingIndex(twin.id, {
      provider: "cohere",
      model: "embed-english-v3.0",
      dimensions: 1024,
      fingerprint: "cohere::embed-english-v3.0::1024",
      builtAt: 1,
    })
    await createTwinChunk({
      twinId: twin.id,
      sourceId: "kept_source",
      content: "x",
      contentRedacted: "x",
      charStart: 0,
      charEnd: 1,
      vectorBackend: "native",
      vectorCollection: `cognia_twin_${twin.id}`,
      vectorDocId: "kept",
      strategy: "paragraph",
      tokenCount: 1,
      metadata: {},
    })
    const job = await ingestJob(twin.id)

    await processJob(job.id, { ...baseConfig, store: { provider: "native" } as never })

    expect(mockRunIngest).not.toHaveBeenCalled()
    const failed = await getTwinJob(job.id)
    // Failed outright — not requeued with backoff (`requeueJob` would leave
    // it `queued` with a `nextAttemptAt`).
    expect(failed?.status).toBe("failed")
    expect(failed?.nextAttemptAt).toBeUndefined()
    expect(failed?.errorMessage).toMatch(/^rebuild-required:/)
  })

  it("fails an ingest whose override has no credentials", async () => {
    const twin = await createTwin({ name: "NoKey", embedding: { provider: "cohere" } })
    const job = await ingestJob(twin.id)

    await processJob(job.id, { ...baseConfig, store: { provider: "native" } as never })

    expect(mockRunIngest).not.toHaveBeenCalled()
    expect((await getTwinJob(job.id))?.errorMessage).toMatch(/^twin-embedding-unconfigured:/)
  })

  it("distills style samples with the twin's effective embedding", async () => {
    const twin = await createTwin({
      name: "Distill",
      embedding: { provider: "openai", model: "text-embedding-3-large" },
    })
    mockRunDistill.mockResolvedValue(distillResult({}))
    const job = await createTwinJob({ twinId: twin.id, kind: "distill", sourceIds: [] })

    await processJob(job.id, baseConfig)

    expect(mockRunDistill.mock.calls[0][0].embedding).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-large",
    })
  })

  it("distills without embeddings when the override has no credentials", async () => {
    const twin = await createTwin({ name: "NoKey", embedding: { provider: "mistral" } })
    mockRunDistill.mockResolvedValue(distillResult({}))
    const job = await createTwinJob({ twinId: twin.id, kind: "distill", sourceIds: [] })

    await processJob(job.id, baseConfig)

    expect(mockRunDistill.mock.calls[0][0].embedding).toBeUndefined()
    expect((await getTwinJob(job.id))?.status).toBe("completed")
  })
})
