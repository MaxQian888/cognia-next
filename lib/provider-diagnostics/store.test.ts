/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type {
  ProviderBalanceSnapshot,
  ProviderDiagnosticJob,
  ProviderDiagnosticSample,
} from "@cognia/provider-types"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"

import {
  clearProviderDiagnosticHistory,
  exportProviderDiagnosticHistory,
  listProviderBalanceSnapshots,
  pruneProviderDiagnosticHistory,
  queryLatestProviderDiagnosticSamples,
  queryLatestProviderModelDiagnosticSamples,
  queryProviderDiagnosticHistory,
  recordProviderBalanceSnapshot,
  recordProviderDiagnosticJob,
  recordProviderDiagnosticSample,
} from "./store"

function job(id: string, startedAt: number): ProviderDiagnosticJob {
  return {
    id,
    providerId: "openai",
    mode: "quick",
    capability: "text-generation",
    status: "completed",
    targetCount: 1,
    completedCount: 1,
    requestLimit: 50,
    maxEstimatedCostUsd: 0.25,
    startedAt,
    completedAt: startedAt + 100,
  }
}

function sample(id: string, startedAt: number): ProviderDiagnosticSample {
  return {
    id,
    jobId: "job-1",
    targetId: "openai:gpt-5:credential-1:endpoint-1",
    providerId: "openai",
    modelId: "gpt-5",
    credentialFingerprint: "credential:credential-1",
    endpoint: "https://api.openai.com/v1",
    capability: "text-generation",
    promptVersion: "provider-diagnostics-text-v1",
    sampleRole: "measured",
    status: "completed",
    startedAt,
    completedAt: startedAt + 100,
    metrics: { ttftMs: 20, totalDurationMs: 100 },
  }
}

function balance(id: string, fetchedAt: number): ProviderBalanceSnapshot {
  return {
    id,
    providerId: "deepseek",
    sourceId: "deepseek-official",
    credentialFingerprint: "credential:key-1",
    amounts: [
      { unit: "CNY", remaining: 10 },
      { unit: "USD", remaining: 2 },
    ],
    fetchedAt,
    staleAt: fetchedAt + 30_000,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("latest-sample queries (rail badges)", () => {
  it("returns the newest sample per provider without scanning every row", async () => {
    await recordProviderDiagnosticSample(sample("s1", 100))
    await recordProviderDiagnosticSample(sample("s2", 300))
    await recordProviderDiagnosticSample({ ...sample("s3", 200), providerId: "anthropic" })
    await recordProviderDiagnosticSample({
      ...sample("s4", 250),
      providerId: "anthropic",
      status: "failed",
    })
    const latest = await queryLatestProviderDiagnosticSamples()
    expect([...latest.keys()].sort()).toEqual(["anthropic", "openai"])
    expect(latest.get("openai")?.id).toBe("s2")
    expect(latest.get("anthropic")?.id).toBe("s4")
    expect(await queryLatestProviderDiagnosticSamples()).toEqual(latest)
  })

  it("returns an empty map when nothing was recorded", async () => {
    expect((await queryLatestProviderDiagnosticSamples()).size).toBe(0)
    expect((await queryLatestProviderModelDiagnosticSamples("openai")).size).toBe(0)
  })

  it("returns the newest sample per model for one provider only", async () => {
    await recordProviderDiagnosticSample(sample("s1", 100))
    await recordProviderDiagnosticSample({ ...sample("s2", 300), modelId: "gpt-5" })
    await recordProviderDiagnosticSample({ ...sample("s3", 200), modelId: "gpt-5-mini" })
    await recordProviderDiagnosticSample({ ...sample("s4", 900), providerId: "anthropic" })
    const latest = await queryLatestProviderModelDiagnosticSamples("openai")
    expect([...latest.keys()].sort()).toEqual(["gpt-5", "gpt-5-mini"])
    expect(latest.get("gpt-5")?.id).toBe("s2")
    expect(latest.get("gpt-5-mini")?.id).toBe("s3")
  })
})

describe("provider diagnostics persistence", () => {
  it("queries samples by provider without merging native balance units", async () => {
    await recordProviderDiagnosticJob(job("job-1", 100))
    await recordProviderDiagnosticSample(sample("sample-1", 110))
    await recordProviderBalanceSnapshot(balance("balance-1", 120))

    expect(await queryProviderDiagnosticHistory({ providerId: "openai" })).toEqual([
      expect.objectContaining({ id: "sample-1", modelId: "gpt-5" }),
    ])
    expect(await listProviderBalanceSnapshots({ providerId: "deepseek" })).toEqual([
      expect.objectContaining({
        amounts: [
          { unit: "CNY", remaining: 10 },
          { unit: "USD", remaining: 2 },
        ],
      }),
    ])
  })

  it("prunes expired rows first and then the globally oldest history rows", async () => {
    await recordProviderDiagnosticJob(job("expired-job", 1))
    await recordProviderDiagnosticSample(sample("expired-sample", 2))
    await recordProviderDiagnosticJob(job("new-job", 900))
    await recordProviderDiagnosticSample(sample("new-sample", 901))
    await recordProviderBalanceSnapshot(balance("new-balance", 902))

    await pruneProviderDiagnosticHistory({ now: 1_000, retentionMs: 500, rowLimit: 2 })

    expect(await queryProviderDiagnosticHistory({})).toEqual([
      expect.objectContaining({ id: "new-sample" }),
    ])
    expect(await listProviderBalanceSnapshots({})).toEqual([
      expect.objectContaining({ id: "new-balance" }),
    ])
  })

  it("exports sanitized records and clears only the requested provider", async () => {
    await recordProviderDiagnosticSample(sample("openai-sample", 100))
    await recordProviderDiagnosticSample({
      ...sample("anthropic-sample", 200),
      providerId: "anthropic",
      endpoint: "https://api.anthropic.com/v1?token=must-not-export",
      failure: { code: "authentication", retryable: false, message: "Bearer secret-value" },
    })

    const json = await exportProviderDiagnosticHistory({ providerId: "anthropic", format: "json" })
    expect(json).toContain("api.anthropic.com")
    expect(json).not.toContain("must-not-export")
    expect(json).not.toContain("secret-value")

    await clearProviderDiagnosticHistory({ providerId: "anthropic" })
    expect(await queryProviderDiagnosticHistory({})).toEqual([
      expect.objectContaining({ id: "openai-sample" }),
    ])
  })
})
