// The action machine. Three properties carry the weight: an apply that lost a
// race fails instead of clobbering, a thin measurement is inconclusive rather
// than "no effect", and auto-revert refuses anything it did not write.

import type { SessionUsageRow } from "@/lib/db/session-usage"

import {
  applyWithCas,
  canAutoRevert,
  canTransition,
  gradeOutcome,
  hashValue,
  measuredDelta,
  measurementIsSufficient,
  MIN_MEASUREMENT_DAYS,
  MIN_MEASUREMENT_TURNS,
  previewAction,
  sampleWindow,
  transition,
  type MeasurementSample,
  type OptimizationActionRecord,
} from "./actions"
import type { OptimizationFindingV1 } from "./findings"

const T0 = new Date(2026, 5, 5, 12, 0, 0).getTime()
const DAY = 86_400_000
const flatPricing = () => ({ promptPer1M: 1000, completionPer1M: 2000 })

function row(over: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: "m1",
    sessionId: "s1",
    at: T0,
    model: "test-model",
    providerId: "acme",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 2,
    durationMs: 0,
    costSource: "sdk",
    costKnown: true,
    ...over,
  }
}

const finding: OptimizationFindingV1 = {
  schemaVersion: 1,
  id: "cacheColdStarts",
  detector: "cacheColdStarts",
  detectorVersion: 1,
  class: "fix",
  severity: "high",
  basis: "estimated",
  confidence: 0.8,
  impactUsd: 100,
  estimatedSavingUsd: 30,
  evidence: { turns: 100, units: 4, days: 7, unpricedTurns: 0 },
  titleKey: "t",
  bodyKey: "b",
  params: {},
  action: { target: "cognia-setting", key: "chat.cache", proposedValue: "on" },
}

function sample(over: Partial<MeasurementSample> = {}): MeasurementSample {
  return {
    fromMs: T0,
    toMs: T0 + 7 * DAY,
    turns: 100,
    knownCostUsd: 100,
    costPerTurnUsd: 1,
    ...over,
  }
}

describe("canTransition", () => {
  it("allows the happy path end to end", () => {
    expect(canTransition("previewed", "applied")).toBe(true)
    expect(canTransition("applied", "measuring")).toBe(true)
    expect(canTransition("measuring", "worked")).toBe(true)
  })

  it("refuses to skip the apply", () => {
    expect(canTransition("previewed", "measuring")).toBe(false)
    expect(canTransition("previewed", "worked")).toBe(false)
  })

  it("lets an inconclusive action be measured again", () => {
    expect(canTransition("inconclusive", "measuring")).toBe(true)
  })

  it("treats reverted as terminal", () => {
    expect(canTransition("reverted", "applied")).toBe(false)
    expect(canTransition("reverted", "measuring")).toBe(false)
  })

  it("lets a failed apply be retried from a fresh preview", () => {
    expect(canTransition("failed", "previewed")).toBe(true)
  })
})

describe("transition", () => {
  const record: OptimizationActionRecord = {
    schemaVersion: 1,
    id: "a",
    findingId: "cacheColdStarts",
    detector: "cacheColdStarts",
    detectorVersion: 1,
    state: "previewed",
    target: "cognia-setting",
    key: "chat.cache",
    createdAt: T0,
  }

  it("advances a legal move and carries the patch", () => {
    const next = transition(record, "applied", { appliedAt: T0 + 5 })
    expect(next?.state).toBe("applied")
    expect(next?.appliedAt).toBe(T0 + 5)
  })

  it("returns null on an illegal move rather than throwing", () => {
    // A stale UI clicking twice should be a no-op, not an error dialog about
    // a state machine.
    expect(transition(record, "worked")).toBeNull()
  })
})

describe("sampleWindow", () => {
  it("measures cost per PRICED turn, not per row", () => {
    const s = sampleWindow(
      [
        row({ costUsd: 4 }),
        row({ messageId: "b", costSource: "unknown", costKnown: false, costUsd: 0 }),
      ],
      T0 - DAY,
      T0 + DAY,
      flatPricing
    )
    expect(s.turns).toBe(2)
    expect(s.costPerTurnUsd).toBeCloseTo(4)
  })

  it("ignores rows outside the window", () => {
    const s = sampleWindow([row({ at: T0 - 10 * DAY })], T0 - DAY, T0 + DAY, flatPricing)
    expect(s.turns).toBe(0)
    expect(s.costPerTurnUsd).toBeNull()
  })
})

describe("measuredDelta", () => {
  it("is positive when the follow-up got cheaper per turn", () => {
    expect(measuredDelta(sample({ costPerTurnUsd: 2 }), sample({ costPerTurnUsd: 1 }))).toBeCloseTo(
      0.5
    )
  })

  it("is negative when it got worse", () => {
    expect(measuredDelta(sample({ costPerTurnUsd: 1 }), sample({ costPerTurnUsd: 2 }))).toBeCloseTo(
      -1
    )
  })

  it("is null when either side has no priced turn", () => {
    expect(measuredDelta(sample({ costPerTurnUsd: null }), sample())).toBeNull()
    expect(measuredDelta(sample(), sample({ costPerTurnUsd: null }))).toBeNull()
  })
})

describe("measurementIsSufficient", () => {
  it("requires both the day floor and the turn floor", () => {
    expect(measurementIsSufficient(sample())).toBe(true)
    expect(measurementIsSufficient(sample({ toMs: T0 + (MIN_MEASUREMENT_DAYS - 1) * DAY }))).toBe(
      false
    )
    expect(measurementIsSufficient(sample({ turns: MIN_MEASUREMENT_TURNS - 1 }))).toBe(false)
  })
})

describe("gradeOutcome", () => {
  it("calls a change that delivered most of its claim a win", () => {
    const grade = gradeOutcome(
      finding,
      sample({ costPerTurnUsd: 1 }),
      sample({ costPerTurnUsd: 0.75 })
    )
    expect(grade).toBe("worked")
  })

  it("calls a real but small improvement partial", () => {
    const grade = gradeOutcome(
      finding,
      sample({ costPerTurnUsd: 1 }),
      sample({ costPerTurnUsd: 0.9 })
    )
    expect(grade).toBe("partial")
  })

  it("calls an unchanged window no effect", () => {
    const grade = gradeOutcome(
      finding,
      sample({ costPerTurnUsd: 1 }),
      sample({ costPerTurnUsd: 1 })
    )
    expect(grade).toBe("no-effect")
  })

  it("refuses to grade a thin follow-up", () => {
    // Declaring no effect from four turns is how a good change gets reverted.
    const thin = sample({ turns: 4, toMs: T0 + DAY, costPerTurnUsd: 1 })
    expect(gradeOutcome(finding, sample({ costPerTurnUsd: 1 }), thin)).toBe("inconclusive")
  })

  it("refuses to grade against a thin baseline either", () => {
    const thin = sample({ turns: 4, toMs: T0 + DAY, costPerTurnUsd: 1 })
    expect(gradeOutcome(finding, thin, sample({ costPerTurnUsd: 0.5 }))).toBe("inconclusive")
  })

  it("is inconclusive when neither side could be priced", () => {
    expect(
      gradeOutcome(finding, sample({ costPerTurnUsd: null }), sample({ costPerTurnUsd: null }))
    ).toBe("inconclusive")
  })

  it("does not call a regression a win", () => {
    const grade = gradeOutcome(
      finding,
      sample({ costPerTurnUsd: 1 }),
      sample({ costPerTurnUsd: 1.5 })
    )
    expect(grade).toBe("no-effect")
  })
})

describe("applyWithCas", () => {
  it("writes when the current value is what the preview saw", async () => {
    const write = jest.fn(async () => {})
    const result = await applyWithCas({
      key: "chat.cache",
      expectedValue: "off",
      proposedValue: "on",
      read: async () => "off",
      write,
    })
    expect(result.ok).toBe(true)
    expect(write).toHaveBeenCalledWith("chat.cache", "on")
  })

  it("refuses when somebody changed the setting in between", async () => {
    const write = jest.fn(async () => {})
    const result = await applyWithCas({
      key: "chat.cache",
      expectedValue: "off",
      proposedValue: "on",
      read: async () => "something-else",
      write,
    })
    expect(result).toEqual({ ok: false, reason: "stale" })
    expect(write).not.toHaveBeenCalled()
  })

  it("treats an absent value as the empty string, so a first write can match", async () => {
    const result = await applyWithCas({
      key: "chat.cache",
      expectedValue: "",
      proposedValue: "on",
      read: async () => null,
      write: async () => {},
    })
    expect(result.ok).toBe(true)
  })

  it("reports a failed read or write rather than claiming success", async () => {
    const readFailed = await applyWithCas({
      key: "k",
      expectedValue: "",
      proposedValue: "v",
      read: async () => {
        throw new Error("locked")
      },
      write: async () => {},
    })
    expect(readFailed).toEqual({ ok: false, reason: "write-failed" })

    const writeFailed = await applyWithCas({
      key: "k",
      expectedValue: "",
      proposedValue: "v",
      read: async () => "",
      write: async () => {
        throw new Error("disk full")
      },
    })
    expect(writeFailed).toEqual({ ok: false, reason: "write-failed" })
  })
})

describe("canAutoRevert", () => {
  const record = { target: "cognia-setting" as const, appliedHash: hashValue("on") }

  it("reverts a setting that still holds exactly what we wrote", () => {
    expect(canAutoRevert({ record, currentValue: "on", optedIn: true })).toBe(true)
  })

  it("refuses when the user changed it afterwards", () => {
    expect(canAutoRevert({ record, currentValue: "their-value", optedIn: true })).toBe(false)
  })

  it("refuses without an explicit opt-in", () => {
    expect(canAutoRevert({ record, currentValue: "on", optedIn: false })).toBe(false)
  })

  it("never touches a repository file", () => {
    // Those belong to the Task Workspace ledger and to the user's git history.
    expect(
      canAutoRevert({
        record: { target: "repo-file", appliedHash: hashValue("on") },
        currentValue: "on",
        optedIn: true,
      })
    ).toBe(false)
  })

  it("refuses when it never recorded what it wrote", () => {
    expect(
      canAutoRevert({
        record: { target: "cognia-setting", appliedHash: undefined },
        currentValue: "on",
        optedIn: true,
      })
    ).toBe(false)
  })
})

describe("previewAction", () => {
  it("builds a record without writing anything", () => {
    const record = previewAction({ finding, expectedValue: "off", now: T0 })
    expect(record).toMatchObject({
      state: "previewed",
      target: "cognia-setting",
      key: "chat.cache",
      expectedValue: "off",
    })
    expect(record?.appliedValue).toBeUndefined()
  })

  it("returns null for a finding with no action", () => {
    expect(previewAction({ finding: { ...finding, action: undefined }, now: T0 })).toBeNull()
  })
})

describe("hashValue", () => {
  it("is stable and distinguishes different values", () => {
    expect(hashValue("on")).toBe(hashValue("on"))
    expect(hashValue("on")).not.toBe(hashValue("off"))
  })
})
