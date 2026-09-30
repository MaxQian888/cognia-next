import {
  adjustedField,
  clampInput,
  handlerFailed,
  isToolFailure,
  pendingMarker,
  scopeDenied,
  toolFailure,
  type Adjustments,
} from "./tool-result"

describe("toolFailure", () => {
  it("is decision-complete and sparse by default", () => {
    expect(toolFailure("no_match", "validation", "nope")).toEqual({
      ok: false,
      code: "no_match",
      error: "nope",
      failureStage: "validation",
      stateChanged: false,
    })
  })

  it("carries outcomeUnknown and one follow-up when given", () => {
    const failure = toolFailure("x", "execution", "e", {
      stateChanged: true,
      outcomeUnknown: true,
      followUp: { tool: "t", arguments: {}, mechanicallyFollowable: true, why: "w" },
    })
    expect(failure.stateChanged).toBe(true)
    expect(failure.outcomeUnknown).toBe(true)
    expect(failure.followUp?.tool).toBe("t")
    expect(isToolFailure(failure)).toBe(true)
  })

  it("maps gate outcomes to fixed codes and stages", () => {
    expect(scopeDenied("off")).toMatchObject({
      code: "scope_denied",
      failureStage: "authorization",
    })
    expect(handlerFailed("boom")).toMatchObject({
      code: "handler_error",
      failureStage: "execution",
      outcomeUnknown: true,
    })
  })

  it("does not mistake an ordinary object for a failure", () => {
    expect(isToolFailure({ ok: false, error: "x" })).toBe(false)
    expect(isToolFailure(null)).toBe(false)
  })
})

describe("pendingMarker", () => {
  it("names the exact continuation call", () => {
    expect(pendingMarker("job_output", { jobId: "j", fromOffset: 4 })).toEqual({
      executionState: "pending",
      continuation: { tool: "job_output", arguments: { jobId: "j", fromOffset: 4 } },
    })
  })
})

describe("clampInput", () => {
  const spec = { min: 1, max: 10, fallback: 5 }

  it("takes the fallback silently for missing or non-finite values", () => {
    const adjusted: Adjustments = {}
    expect(clampInput("n", undefined, spec, adjusted)).toBe(5)
    expect(clampInput("n", Number.NaN, spec, adjusted)).toBe(5)
    expect(adjustedField(adjusted)).toEqual({})
  })

  it("clamps out-of-range values and reports the effective value", () => {
    const adjusted: Adjustments = {}
    expect(clampInput("big", 99, spec, adjusted)).toBe(10)
    expect(clampInput("small", -3, spec, adjusted)).toBe(1)
    expect(clampInput("frac", 3.7, spec, adjusted)).toBe(3)
    expect(clampInput("ok", 4, spec, adjusted)).toBe(4)
    expect(adjustedField(adjusted)).toEqual({
      adjusted: {
        big: { requested: 99, effective: 10 },
        small: { requested: -3, effective: 1 },
        frac: { requested: 3.7, effective: 3 },
      },
    })
  })
})
