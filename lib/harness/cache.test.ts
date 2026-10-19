import type { HarnessEvolutionStep, HarnessExecutionEvidence } from "@/types/harness/evolution"
import {
  ROLLOUT_REUSE_MAX_AGE_MS,
  pickReusableRollout,
  rolloutCacheKey,
  rolloutReuseVerdict,
} from "./cache"

const evidence = { error: undefined } as unknown as HarnessExecutionEvidence

function step(overrides: Partial<HarnessEvolutionStep> = {}): HarnessEvolutionStep {
  return {
    id: "run-1:base1",
    runId: "run-1",
    label: "base1",
    kind: "rollout",
    status: "succeeded",
    evidence,
    attempts: 1,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    cacheKey: "key",
    endedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe("rolloutCacheKey", () => {
  it("separates replicates and every input", async () => {
    const base = {
      harnessContentHash: "h",
      taskInputHash: "t",
      environmentFingerprint: "e",
      replicate: 1,
    }
    const key = await rolloutCacheKey(base)
    expect(key).toMatch(/^hrc1-[0-9a-f]{40}$/)
    expect(await rolloutCacheKey({ ...base })).toBe(key)
    for (const change of [
      { replicate: 2 },
      { harnessContentHash: "h2" },
      { taskInputHash: "t2" },
      { environmentFingerprint: "e2" },
    ]) {
      expect(await rolloutCacheKey({ ...base, ...change })).not.toBe(key)
    }
  })
})

describe("rolloutReuseVerdict", () => {
  it("reuses a finished, fresh rollout with the same key", () => {
    expect(rolloutReuseVerdict(step(), "key", 2_000)).toEqual({ reuse: true })
  })

  it.each([
    [{ kind: "propose" as const }, /not a rollout/],
    [{ cacheKey: "other" }, /key mismatch/],
    [{ status: "failed" as const }, /did not finish/],
    [{ evidence: undefined }, /did not finish/],
    [{ evidence: { ...evidence, error: "request timed out" } }, /infrastructure/],
    [{ endedAt: 0 }, /older than the reuse window/],
  ])("refuses %j", (overrides, reason) => {
    const verdict = rolloutReuseVerdict(step(overrides), "key", ROLLOUT_REUSE_MAX_AGE_MS + 1)
    expect(verdict.reuse).toBe(false)
    expect(!verdict.reuse && verdict.reason).toMatch(reason)
  })

  it("keeps a rollout whose task failed for task reasons", () => {
    expect(
      rolloutReuseVerdict(step({ evidence: { ...evidence, error: "wrong answer" } }), "key", 2_000)
        .reuse
    ).toBe(true)
  })

  it("refuses when library skills drifted", () => {
    const verdict = rolloutReuseVerdict(step(), "key", 2_000, { driftedSkills: ["report"] })
    expect(!verdict.reuse && verdict.reason).toMatch(/report/)
  })
})

describe("pickReusableRollout", () => {
  it("returns the newest reusable candidate", () => {
    const old = step({ id: "a", endedAt: 1_000 })
    const fresh = step({ id: "b", endedAt: 1_500 })
    const broken = step({ id: "c", endedAt: 1_900, status: "failed" })
    expect(pickReusableRollout([old, broken, fresh], "key", 2_000)?.id).toBe("b")
    expect(pickReusableRollout([broken], "key", 2_000)).toBeUndefined()
  })
})
