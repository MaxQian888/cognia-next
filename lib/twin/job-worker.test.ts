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
import { createTwinJob, getTwinJob } from "@/lib/db/twin-jobs"
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
      failureSummary: { allFailed: false, failures: [] },
      totalEmbeddingTokens: 0,
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
