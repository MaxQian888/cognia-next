import type { ProviderDiagnosticTarget } from "@cognia/provider-types"

import {
  cancelProviderDiagnosticJob,
  cancelProviderDiagnosticTarget,
  startProviderDiagnosticJob,
  type ResolvedProviderDiagnosticTarget,
} from "./service"

function target(id: string): ResolvedProviderDiagnosticTarget {
  const publicTarget: ProviderDiagnosticTarget = {
    id,
    providerId: "openai",
    modelId: `model-${id}`,
    credentialFingerprint: "credential:primary",
    endpoint: "https://api.openai.com/v1",
    capability: "text-generation",
  }
  return {
    ...publicTarget,
    credentials: { protocol: "openai", apiKey: "secret", baseURL: publicTarget.endpoint },
    estimatedMaxCostUsd: 0.01,
    billable: true,
  }
}

describe("startProviderDiagnosticJob spend ceiling", () => {
  // ADR-0104 caps a job at 50 requests and USD 0.25. Preferences used to be
  // spread over the defaults and then read back as *the* limit, so anything
  // that could write a settings row — a restored backup, an imported profile,
  // a companion payload — could raise the budget to whatever it liked.
  const many = (count: number) => Array.from({ length: count }, (_, i) => target(`t${i}`))

  it("refuses a request count over the hard cap even when the caller raises the limit", async () => {
    await expect(
      startProviderDiagnosticJob(
        {
          providerId: "openai",
          mode: "quick",
          capability: "text-generation",
          targets: many(51),
          unknownCostConfirmed: true,
          preferences: { maxRequestsPerJob: 5_000 },
        },
        { executeSample: async () => ({ metrics: { ttftMs: 1, totalDurationMs: 1 } }) }
      )
    ).rejects.toThrow("50 request limit")
  })

  it("refuses a cost over the hard cap even when the caller raises the budget", async () => {
    // 30 × $0.01 = $0.30, over the $0.25 ceiling but under the request cap.
    await expect(
      startProviderDiagnosticJob(
        {
          providerId: "openai",
          mode: "quick",
          capability: "text-generation",
          targets: many(30),
          unknownCostConfirmed: true,
          preferences: { maxEstimatedCostUsd: 100 },
        },
        { executeSample: async () => ({ metrics: { ttftMs: 1, totalDurationMs: 1 } }) }
      )
    ).rejects.toThrow("0.25 USD")
  })

  it("still honours a caller that asks for a tighter budget than the cap", async () => {
    await expect(
      startProviderDiagnosticJob(
        {
          providerId: "openai",
          mode: "quick",
          capability: "text-generation",
          targets: many(2),
          unknownCostConfirmed: true,
          preferences: { maxRequestsPerJob: 1 },
        },
        { executeSample: async () => ({ metrics: { ttftMs: 1, totalDurationMs: 1 } }) }
      )
    ).rejects.toThrow("1 request limit")
  })
})

describe("startProviderDiagnosticJob", () => {
  it("runs warm-up plus three measured samples in precise mode and persists every outcome", async () => {
    const jobs: string[] = []
    const samples: Array<{ targetId: string; sampleRole: string }> = []
    const result = await startProviderDiagnosticJob(
      {
        providerId: "openai",
        mode: "precise",
        capability: "text-generation",
        targets: [target("a"), target("b")],
        unknownCostConfirmed: true,
      },
      {
        createId: (() => {
          let id = 0
          return () => `id-${++id}`
        })(),
        now: (() => {
          let at = 1_000
          return () => ++at
        })(),
        executeSample: async () => ({ metrics: { ttftMs: 10, totalDurationMs: 50 } }),
        recordJob: async (job) => {
          jobs.push(job.status)
          return job
        },
        recordSample: async (sample) => {
          samples.push({ targetId: sample.targetId, sampleRole: sample.sampleRole })
          return sample
        },
      }
    )

    expect(result.status).toBe("completed")
    expect(result.completedCount).toBe(8)
    expect(jobs[0]).toBe("running")
    expect(jobs.at(-1)).toBe("completed")
    expect(jobs.filter((status) => status === "running")).toHaveLength(9)
    expect(samples.filter((sample) => sample.sampleRole === "warmup")).toHaveLength(2)
    expect(samples.filter((sample) => sample.sampleRole === "measured")).toHaveLength(6)
  })

  it("rejects jobs that exceed request or known-price limits before sending", async () => {
    await expect(
      startProviderDiagnosticJob({
        providerId: "openai",
        mode: "precise",
        capability: "text-generation",
        targets: Array.from({ length: 13 }, (_, index) => target(String(index))),
        unknownCostConfirmed: true,
      })
    ).rejects.toThrow("50 request")

    await expect(
      startProviderDiagnosticJob({
        providerId: "openai",
        mode: "quick",
        capability: "text-generation",
        targets: [{ ...target("expensive"), estimatedMaxCostUsd: 0.3 }],
        unknownCostConfirmed: true,
      })
    ).rejects.toThrow("0.25 USD")
  })

  it("aborts active work, stops queued samples, and persists a cancelled partial result", async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const samples: string[] = []
    const running = startProviderDiagnosticJob(
      {
        jobId: "cancel-job",
        providerId: "openai",
        mode: "quick",
        capability: "text-generation",
        targets: [target("a"), target("b")],
        unknownCostConfirmed: true,
        preferences: { concurrency: 1 },
      },
      {
        executeSample: async (_target, _role, signal) => {
          entered()
          await new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          )
          throw new Error("unreachable")
        },
        recordJob: async (job) => job,
        recordSample: async (sample) => {
          samples.push(sample.status)
          return sample
        },
      }
    )
    await started
    expect(cancelProviderDiagnosticJob("cancel-job")).toBe(true)

    const result = await running
    expect(result.status).toBe("cancelled")
    expect(samples).toEqual(["cancelled"])
    expect(result.completedCount).toBe(1)
  })

  it("cancels one active target without cancelling the rest of the job", async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const statuses: Record<string, string> = {}
    const running = startProviderDiagnosticJob(
      {
        jobId: "target-cancel-job",
        providerId: "openai",
        mode: "quick",
        capability: "text-generation",
        targets: [target("a"), target("b")],
        unknownCostConfirmed: true,
        preferences: { concurrency: 1 },
      },
      {
        executeSample: async (current, _role, signal) => {
          if (current.id === "a") {
            entered()
            await new Promise((_, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true })
            )
          }
          return { metrics: { totalDurationMs: 1 } }
        },
        recordJob: async (job) => job,
        recordSample: async (sample) => {
          statuses[sample.targetId] = sample.status
          return sample
        },
      }
    )
    await started
    expect(cancelProviderDiagnosticTarget("target-cancel-job", "a")).toBe(true)

    const result = await running
    expect(result.status).toBe("completed")
    expect(statuses).toEqual({ a: "cancelled", b: "completed" })
  })

  it("enforces the capability timeout per sample", async () => {
    let persistedFailure: string | undefined
    const result = await startProviderDiagnosticJob(
      {
        jobId: "timeout-job",
        providerId: "openai",
        mode: "quick",
        capability: "text-generation",
        targets: [target("slow")],
        unknownCostConfirmed: true,
        preferences: { textTimeoutMs: 5 },
      },
      {
        executeSample: async (_target, _role, signal) => {
          await new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          )
          return { metrics: { totalDurationMs: 1 } }
        },
        recordJob: async (job) => job,
        recordSample: async (sample) => {
          persistedFailure = sample.failure?.code
          return sample
        },
      }
    )

    expect(result.status).toBe("completed")
    expect(result.completedCount).toBe(1)
    expect(persistedFailure).toBe("timeout")
  })
})
