import { DEFAULT_PERMISSION_POLICY, type TaskOverlapPolicy } from "@/types/scheduler"
import { decideConcurrencyAdmission, resolveConcurrencyLimit } from "./concurrency-limit"

describe("resolveConcurrencyLimit", () => {
  it("keeps a positive integer as-is", () => {
    expect(resolveConcurrencyLimit(1)).toBe(1)
    expect(resolveConcurrencyLimit(12)).toBe(12)
  })

  it("floors a fractional cap rather than admitting a partial slot", () => {
    expect(resolveConcurrencyLimit(3.9)).toBe(3)
  })

  // A cap of 0 honoured literally would stop every task on the host forever,
  // which is the one failure this sanitizer exists to prevent.
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
    "falls back to the shipped default for %p rather than bricking the scheduler",
    (value) => {
      expect(resolveConcurrencyLimit(value as number | undefined)).toBe(
        DEFAULT_PERMISSION_POLICY.maxConcurrentExecutions
      )
    }
  )
})

describe("decideConcurrencyAdmission", () => {
  const admission = (runningCount: number, overlapPolicy: TaskOverlapPolicy, limit = 5) =>
    decideConcurrencyAdmission({ runningCount, limit, overlapPolicy })

  it("admits while a slot is free", () => {
    expect(admission(4, "skip")).toEqual({ admit: true })
  })

  it("admits from an idle host", () => {
    expect(admission(0, "skip")).toEqual({ admit: true })
  })

  it.each<TaskOverlapPolicy>(["queue-one", "queue-all"])(
    "buffers a capped start under %s so the fire is not lost",
    (overlapPolicy) => {
      expect(admission(5, overlapPolicy)).toEqual({ admit: false, disposition: "buffer" })
    }
  )

  it.each<TaskOverlapPolicy>(["skip", "allow", "cancel-previous"])(
    "drops a capped start under %s, because none of these have a waiting semantic to reuse",
    (overlapPolicy) => {
      const verdict = admission(5, overlapPolicy)
      expect(verdict.admit).toBe(false)
      expect(verdict).toMatchObject({ disposition: "drop" })
    }
  )

  // The whole point of the cap. `allow` says "do not hold this task up behind
  // itself", which is not a claim to be exempt from the user's host ceiling.
  it("caps an `allow` task rather than treating it as exempt", () => {
    expect(admission(5, "allow")).toMatchObject({ admit: false, disposition: "drop" })
  })

  it("names the running count and the limit so the run history explains itself", () => {
    const verdict = admission(7, "skip", 7)
    expect(verdict).toMatchObject({ admit: false, disposition: "drop" })
    if (verdict.admit || verdict.disposition !== "drop") throw new Error("expected a drop")
    expect(verdict.message).toContain("7")
    expect(verdict.message).toMatch(/limit of 7/)
  })

  it("still blocks when the host is somehow over the cap", () => {
    expect(admission(9, "skip")).toMatchObject({ admit: false })
  })
})
