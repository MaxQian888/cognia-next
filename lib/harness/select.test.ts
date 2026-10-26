import type { HarnessExecutionEvidence } from "@/types/harness/evolution"
import {
  BASE_LABEL,
  anonymize,
  parseJudgeVerdict,
  selectFinal,
  type SelectionHarness,
} from "./select"
import { makeComponents } from "./test-fixtures"

function evidence(overrides: Partial<HarnessExecutionEvidence> = {}): HarnessExecutionEvidence {
  return {
    snapshotId: "s",
    inputFingerprint: "i",
    environmentFingerprint: "e",
    output: "done",
    trajectory: "",
    deliverables: [],
    metrics: {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      costUsd: 0.1,
      latencyMs: 1,
      toolCalls: 1,
      toolFailures: 0,
      steps: 1,
    },
    validation: [{ check: "c", passed: true, status: "passed" }],
    blockedActions: [],
    delegations: [],
    degraded: false,
    delivered: true,
    ...overrides,
  }
}

const failing = evidence({
  delivered: false,
  validation: [{ check: "c", passed: false, status: "failed" }],
})

function harness(label: string, ev: HarnessExecutionEvidence[], memory = ""): SelectionHarness {
  return {
    label,
    snapshotId: `snap-${label}`,
    components: makeComponents({ memory }),
    evidence: ev,
  }
}

const neverJudge = jest.fn(async () => {
  throw new Error("judge must not run")
})

describe("selectFinal", () => {
  it("adopts a single final that beats every base rollout without a judge", async () => {
    const result = await selectFinal({
      base: harness(BASE_LABEL, [failing, failing]),
      finals: [harness("agg1", [evidence()]), harness("agg2", [failing])],
      seed: 1,
      judge: neverJudge,
    })
    expect(result).toMatchObject({
      outcome: "adopt",
      chosenLabel: "agg1",
      chosenSnapshotId: "snap-agg1",
      method: "deterministic",
    })
    expect(result.dominant).toEqual(["agg1"])
  })

  it("excludes regressions and keeps the base when nothing else is left", async () => {
    const result = await selectFinal({
      base: harness(BASE_LABEL, [evidence()]),
      finals: [harness("agg1", [failing])],
      seed: 1,
      judge: neverJudge,
    })
    expect(result).toMatchObject({
      outcome: "keep-base",
      method: "no-candidate",
      regressed: ["agg1"],
    })
  })

  it("asks a blind judge when finals tie with the base and adopts a confident preference", async () => {
    const judge = jest.fn(async (entries) => {
      expect(entries.map((e: { id: string }) => e.id).sort()).toEqual(["R1", "R2"])
      return null
    })
    const base = harness(BASE_LABEL, [evidence()])
    const finals = [harness("c1", [evidence()])]
    const mapping = anonymize(["c1", BASE_LABEL], 7)
    const candidateId = Object.entries(mapping).find(([, l]) => l === "c1")![0]
    judge.mockResolvedValueOnce({
      best: candidateId,
      ranking: [candidateId],
      confidence: "medium",
      evidence: { [candidateId]: "fewer retries" },
    } as never)
    const result = await selectFinal({ base, finals, seed: 7, judge })
    expect(result).toMatchObject({ outcome: "adopt", chosenLabel: "c1", method: "judge" })
    expect(result.reason).toContain("fewer retries")
    expect(result.anonymized).toEqual(mapping)
  })

  it("keeps the base on a low-confidence verdict, a base verdict or no verdict", async () => {
    const base = harness(BASE_LABEL, [evidence()])
    const finals = [harness("c1", [evidence()])]
    const mapping = anonymize(["c1", BASE_LABEL], 3)
    const id = (label: string) => Object.entries(mapping).find(([, l]) => l === label)![0]
    const low = await selectFinal({
      base,
      finals,
      seed: 3,
      judge: async () => ({ best: id("c1"), ranking: [], confidence: "low", evidence: {} }),
    })
    expect(low).toMatchObject({ outcome: "keep-base", method: "judge" })
    const forBase = await selectFinal({
      base,
      finals,
      seed: 3,
      judge: async () => ({ best: id(BASE_LABEL), ranking: [], confidence: "high", evidence: {} }),
    })
    expect(forBase.outcome).toBe("keep-base")
    const none = await selectFinal({ base, finals, seed: 3, judge: async () => null })
    expect(none.outcome).toBe("keep-base")
    const thrown = await selectFinal({ base, finals, seed: 3, judge: neverJudge })
    expect(thrown.outcome).toBe("keep-base")
  })

  it("tie-breaks between equally dominant finals by cost when the judge fails", async () => {
    const cheap = evidence({ metrics: { ...evidence().metrics, costUsd: 0.01 } })
    const result = await selectFinal({
      base: harness(BASE_LABEL, [failing]),
      finals: [harness("agg1", [evidence()]), harness("agg2", [cheap])],
      seed: 1,
      judge: async () => null,
    })
    expect(result).toMatchObject({ outcome: "adopt", chosenLabel: "agg2", method: "tie-break" })
  })

  it("adopts the judge's pick among dominant finals even at low confidence", async () => {
    const mapping = anonymize(["agg1", "agg2"], 5)
    const id = Object.entries(mapping).find(([, l]) => l === "agg1")![0]
    const result = await selectFinal({
      base: harness(BASE_LABEL, [failing]),
      finals: [harness("agg1", [evidence()]), harness("agg2", [evidence()])],
      seed: 5,
      judge: async () => ({ best: id, ranking: [id], confidence: "low", evidence: {} }),
    })
    expect(result).toMatchObject({ outcome: "adopt", chosenLabel: "agg1" })
  })

  it("ranks a candidate by its worst replicate and the base by its best", async () => {
    const result = await selectFinal({
      base: harness(BASE_LABEL, [failing, evidence()]),
      finals: [harness("agg1", [evidence(), failing])],
      seed: 1,
      judge: async () => null,
    })
    expect(result.dominant).toEqual([])
    expect(result.regressed).toEqual([])
    expect(result.outcome).toBe("keep-base")
  })

  it("keeps the base when no finals were produced", async () => {
    expect(
      await selectFinal({
        base: harness(BASE_LABEL, [evidence()]),
        finals: [],
        seed: 1,
        judge: neverJudge,
      })
    ).toMatchObject({ outcome: "keep-base", reason: "No final harness was produced." })
  })
})

describe("anonymize", () => {
  it("is a seeded permutation", () => {
    const a = anonymize(["x", "y", "z"], 42)
    expect(Object.keys(a)).toEqual(["R1", "R2", "R3"])
    expect(Object.values(a).sort()).toEqual(["x", "y", "z"])
    expect(anonymize(["x", "y", "z"], 42)).toEqual(a)
  })
})

describe("parseJudgeVerdict", () => {
  it("keeps only known ids and defaults confidence to low", () => {
    expect(
      parseJudgeVerdict(
        '{"best":"R2","ranking":["R2","R9","R1"],"evidence":{"R2":"ok","R9":"x"}}',
        ["R1", "R2"]
      )
    ).toEqual({ best: "R2", ranking: ["R2", "R1"], confidence: "low", evidence: { R2: "ok" } })
    expect(parseJudgeVerdict('{"best":"R7"}', ["R1"])).toBeNull()
    expect(parseJudgeVerdict("nope", ["R1"])).toBeNull()
  })
})
