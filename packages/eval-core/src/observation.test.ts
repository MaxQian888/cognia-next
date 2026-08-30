import type { Score } from "./domain/eval"
import {
  buildObservation,
  isDecidingObservation,
  legacyObservationOrigin,
  summarizeObservations,
  type EvalObservationV1,
  type ObservationOrigin,
} from "./observation"

function score(overrides: Partial<Score> = {}): Score {
  return {
    scorerId: "tool-selection",
    dimension: "tool-use",
    status: "scored",
    value: 1,
    passed: true,
    ...overrides,
  }
}

function observation(
  origin: ObservationOrigin,
  overrides: Partial<Score> = {},
  id = "obs"
): EvalObservationV1 {
  return buildObservation({
    id,
    scope: { traceId: "t1" },
    origin,
    evaluatorVersionId: "ev@1",
    score: score(overrides),
    createdAt: 0,
  })
}

describe("buildObservation", () => {
  it("stamps the schema and keeps the score untouched", () => {
    const built = observation("online")
    expect(built.schema).toBe("cognia-observation/v1")
    expect(built.score).toEqual(score())
    expect(built.evaluatorVersionId).toBe("ev@1")
  })

  it("omits evidenceDigest rather than writing undefined", () => {
    expect("evidenceDigest" in observation("offline")).toBe(false)
    expect(
      buildObservation({
        id: "o",
        scope: {},
        origin: "human",
        evaluatorVersionId: "ev@1",
        score: score(),
        evidenceDigest: "sha256:abc",
        createdAt: 0,
      }).evidenceDigest
    ).toBe("sha256:abc")
  })
})

describe("isDecidingObservation", () => {
  it("counts only `scored` — the other three statuses decide nothing", () => {
    expect(isDecidingObservation(observation("online"))).toBe(true)
    for (const status of ["not-applicable", "errored", "measurement"] as const) {
      expect(isDecidingObservation(observation("online", { status }))).toBe(false)
    }
  })

  it("does not read an errored scorer as a failed agent", () => {
    const errored = observation("online", { status: "errored", passed: false })
    expect(isDecidingObservation(errored)).toBe(false)
    expect(summarizeObservations([errored]).passed).toBe(0)
    expect(summarizeObservations([errored]).deciding).toBe(0)
  })
})

describe("summarizeObservations", () => {
  it("splits by status and origin, counting passes only among deciding ones", () => {
    const summary = summarizeObservations([
      observation("offline", {}, "a"),
      observation("online", { passed: false }, "b"),
      observation("human", { status: "measurement" }, "c"),
      observation("online", { status: "errored" }, "d"),
    ])
    expect(summary.total).toBe(4)
    expect(summary.deciding).toBe(2)
    expect(summary.passed).toBe(1)
    expect(summary.byOrigin).toEqual({ offline: 1, online: 2, human: 1 })
    expect(summary.byStatus).toEqual({
      scored: 2,
      "not-applicable": 0,
      errored: 1,
      measurement: 1,
    })
  })

  it("returns zeroed buckets for an empty set instead of an empty object", () => {
    const summary = summarizeObservations([])
    expect(summary.byStatus.scored).toBe(0)
    expect(summary.byOrigin.online).toBe(0)
  })
})

describe("legacyObservationOrigin", () => {
  it("reads pre-envelope rows as offline without rewriting them", () => {
    expect(legacyObservationOrigin()).toBe("offline")
  })
})
