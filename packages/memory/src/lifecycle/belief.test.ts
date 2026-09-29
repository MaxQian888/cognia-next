import type { MemoryEvidence } from "../types/governance"
import {
  BELIEF_CAP,
  BELIEF_NON_SESSION_CREDIT,
  BELIEF_RECENCY_FLOOR,
  BELIEF_RECENCY_TAU_DAYS,
  BELIEF_RESIDUAL_CAP,
  BELIEF_SUPPORT_SATURATION,
  beliefStrength,
  computeBeliefInputs,
} from "./belief"

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

type EvidenceRow = Pick<MemoryEvidence, "sessionId" | "sourceId" | "createdAt" | "validationState">

function ev(over: Partial<EvidenceRow> = {}): EvidenceRow {
  return { sourceId: "src", createdAt: NOW, ...over }
}

const support = (breadth: number) => 1 - Math.exp(-breadth / 3)

describe("constants", () => {
  it("match ai-memory's belief.rs", () => {
    expect(BELIEF_SUPPORT_SATURATION).toBe(3)
    expect(BELIEF_NON_SESSION_CREDIT).toBe(0.2)
    expect(BELIEF_RESIDUAL_CAP).toBe(1)
    expect(BELIEF_RECENCY_TAU_DAYS).toBe(30)
    expect(BELIEF_RECENCY_FLOOR).toBe(0.5)
    expect(BELIEF_CAP).toBe(0.95)
  })
})

describe("computeBeliefInputs", () => {
  it("returns zero counters and no timestamp for no evidence", () => {
    expect(computeBeliefInputs([])).toEqual({ evidenceCount: 0, distinctSessions: 0 })
  })

  it("counts distinct sessions, not rows", () => {
    const inputs = computeBeliefInputs([
      ev({ sessionId: "s1", createdAt: NOW - 3 * DAY }),
      ev({ sessionId: "s1", createdAt: NOW - 2 * DAY }),
      ev({ sessionId: "s2", createdAt: NOW - 1 * DAY }),
    ])
    expect(inputs).toEqual({
      evidenceCount: 3,
      distinctSessions: 2,
      newestEvidenceAt: NOW - 1 * DAY,
    })
  })

  it("counts only sessions as witnesses; other evidence is residual", () => {
    const inputs = computeBeliefInputs([
      ev({ sourceId: "manual:m1:v2" }),
      ev({ sourceId: "manual:m1:v3" }),
      ev({ sourceId: "file-b" }),
      ev({ sessionId: "s1", sourceId: "file-a" }),
    ])
    expect(inputs.evidenceCount).toBe(4)
    expect(inputs.distinctSessions).toBe(1)
  })

  it("does not let repeated edits corroborate a memory", () => {
    const once = beliefStrength(computeBeliefInputs([ev({ sourceId: "manual:m1:v1" })]), {
      now: NOW,
    })
    const edited = beliefStrength(
      computeBeliefInputs(
        Array.from({ length: 20 }, (_, i) => ev({ sourceId: `manual:m1:v${i + 1}` }))
      ),
      { now: NOW }
    )
    const twoConversations = beliefStrength(
      computeBeliefInputs([ev({ sessionId: "s1" }), ev({ sessionId: "s2" })]),
      { now: NOW }
    )
    expect(once).not.toBeNull()
    // Residual credit is capped at one witness' worth, whatever the edit count.
    expect(edited!).toBeLessThanOrEqual(1 - Math.exp(-1 / 3) + 1e-9)
    expect(twoConversations!).toBeGreaterThan(edited!)
  })

  it("excludes revoked evidence entirely", () => {
    const inputs = computeBeliefInputs([
      ev({ sessionId: "s1", createdAt: NOW - 5 * DAY, validationState: "valid" }),
      ev({ sessionId: "s2", createdAt: NOW, validationState: "revoked" }),
      ev({ sessionId: "s3", createdAt: NOW - 4 * DAY, validationState: "unverifiable" }),
    ])
    expect(inputs).toEqual({
      evidenceCount: 2,
      distinctSessions: 2,
      newestEvidenceAt: NOW - 4 * DAY,
    })
  })

  it("omits newestEvidenceAt when every row is revoked", () => {
    expect(computeBeliefInputs([ev({ sessionId: "s1", validationState: "revoked" })])).toEqual({
      evidenceCount: 0,
      distinctSessions: 0,
    })
  })

  it("picks the newest timestamp regardless of order", () => {
    expect(
      computeBeliefInputs([
        ev({ sessionId: "a", createdAt: 5 }),
        ev({ sessionId: "b", createdAt: 50 }),
        ev({ sessionId: "c", createdAt: 10 }),
      ]).newestEvidenceAt
    ).toBe(50)
  })
})

describe("beliefStrength", () => {
  it("returns null when inputs are unknown", () => {
    expect(beliefStrength(undefined)).toBeNull()
  })

  it("returns null when breadth is zero", () => {
    expect(beliefStrength({ evidenceCount: 0, distinctSessions: 0 })).toBeNull()
    expect(beliefStrength({ evidenceCount: -3, distinctSessions: -1 })).toBeNull()
  })

  it("computes support from one witness", () => {
    expect(beliefStrength({ evidenceCount: 1, distinctSessions: 1 }, { now: NOW })).toBeCloseTo(
      support(1),
      12
    )
  })

  it("grows with distinct sessions", () => {
    const one = beliefStrength({ evidenceCount: 1, distinctSessions: 1 }, { now: NOW })!
    const three = beliefStrength({ evidenceCount: 3, distinctSessions: 3 }, { now: NOW })!
    expect(three).toBeCloseTo(support(3), 12)
    expect(three).toBeGreaterThan(one)
  })

  it("credits extra rows from the same session with a capped residual", () => {
    // residual 2 → +0.4 breadth
    expect(beliefStrength({ evidenceCount: 3, distinctSessions: 1 }, { now: NOW })).toBeCloseTo(
      support(1.4),
      12
    )
    // residual 99 → capped at +1
    expect(beliefStrength({ evidenceCount: 100, distinctSessions: 1 }, { now: NOW })).toBeCloseTo(
      support(2),
      12
    )
    // Ten restatements in one session never beat two distinct sessions + residual cap.
    const chatty = beliefStrength({ evidenceCount: 10, distinctSessions: 1 }, { now: NOW })!
    const broad = beliefStrength({ evidenceCount: 3, distinctSessions: 3 }, { now: NOW })!
    expect(chatty).toBeLessThan(broad)
  })

  it("gives residual-only rows partial credit", () => {
    expect(beliefStrength({ evidenceCount: 2, distinctSessions: 0 }, { now: NOW })).toBeCloseTo(
      support(0.4),
      12
    )
  })

  it("shades older evidence toward the 0.5 recency floor", () => {
    const base = { evidenceCount: 1, distinctSessions: 1 }
    expect(beliefStrength({ ...base, newestEvidenceAt: NOW }, { now: NOW })).toBeCloseTo(
      support(1),
      12
    )
    expect(beliefStrength({ ...base, newestEvidenceAt: NOW - 30 * DAY }, { now: NOW })).toBeCloseTo(
      support(1) * (0.5 + 0.5 * Math.exp(-1)),
      12
    )
    const ancient = beliefStrength({ ...base, newestEvidenceAt: NOW - 3650 * DAY }, { now: NOW })!
    expect(ancient).toBeCloseTo(support(1) * 0.5, 6)
    expect(ancient).toBeGreaterThanOrEqual(support(1) * 0.5)
  })

  it("treats future evidence as fresh", () => {
    expect(
      beliefStrength(
        { evidenceCount: 1, distinctSessions: 1, newestEvidenceAt: NOW + 5 * DAY },
        { now: NOW }
      )
    ).toBeCloseTo(support(1), 12)
  })

  it("divides by 1 + live contradictions", () => {
    const inputs = { evidenceCount: 2, distinctSessions: 2 }
    expect(beliefStrength(inputs, { now: NOW, liveContradictions: 1 })).toBeCloseTo(
      support(2) / 2,
      12
    )
    expect(beliefStrength(inputs, { now: NOW, liveContradictions: 3 })).toBeCloseTo(
      support(2) / 4,
      12
    )
    expect(beliefStrength(inputs, { now: NOW, liveContradictions: -2 })).toBeCloseTo(support(2), 12)
  })

  it("never exceeds the 0.95 cap", () => {
    expect(beliefStrength({ evidenceCount: 500, distinctSessions: 500 }, { now: NOW })).toBe(
      BELIEF_CAP
    )
  })

  it("defaults the clock to Date.now()", () => {
    const spy = jest.spyOn(Date, "now").mockReturnValue(NOW + 30 * DAY)
    try {
      expect(
        beliefStrength({ evidenceCount: 1, distinctSessions: 1, newestEvidenceAt: NOW })
      ).toBeCloseTo(support(1) * (0.5 + 0.5 * Math.exp(-1)), 12)
    } finally {
      spy.mockRestore()
    }
  })
})
