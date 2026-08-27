import { OPEN_PLAN_STATUSES } from "@/types/agent/plan"
import { ISSUE_RUN_STATUSES } from "@/types/issues"

import {
  PLAN_STATUS_VARIANT,
  PLAN_STATUSES_FOR_TEST,
  RUN_STATUS_VARIANT,
  RUN_STATUSES_FOR_TEST,
} from "./workspace-activity-catalogue"

describe("workspace activity catalogue", () => {
  it("covers every open plan status without hand-listing them", () => {
    // Built from the authority rather than copied, so the open half cannot
    // drift away from `OPEN_PLAN_STATUSES` while looking correct.
    for (const status of OPEN_PLAN_STATUSES) {
      expect(PLAN_STATUSES_FOR_TEST).toContain(status)
    }
  })

  it("covers the three terminal plan statuses", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(PLAN_STATUSES_FOR_TEST).toContain(status)
    }
    expect(new Set(PLAN_STATUSES_FOR_TEST).size).toBe(PLAN_STATUSES_FOR_TEST.length)
  })

  it("is the run-status authority itself, not a copy of it", () => {
    expect(RUN_STATUSES_FOR_TEST).toBe(ISSUE_RUN_STATUSES)
  })

  it("draws every status it knows about", () => {
    // The variant maps live here rather than in the panel so "which statuses
    // exist" and "what each one looks like" cannot become two answers. The
    // `Record<…>` types already fail a missing key at compile time; this
    // catches a key whose value was left undefined at runtime.
    for (const status of PLAN_STATUSES_FOR_TEST) {
      expect(PLAN_STATUS_VARIANT[status]).toBeTruthy()
    }
    for (const status of RUN_STATUSES_FOR_TEST) {
      expect(RUN_STATUS_VARIANT[status]).toBeTruthy()
    }
  })

  it("reserves the loudest variant for the statuses that actually failed", () => {
    expect(PLAN_STATUS_VARIANT.failed).toBe("destructive")
    expect(RUN_STATUS_VARIANT.failed).toBe("destructive")
    expect(PLAN_STATUS_VARIANT.executing).toBe("default")
    expect(RUN_STATUS_VARIANT.running).toBe("default")
  })
})
