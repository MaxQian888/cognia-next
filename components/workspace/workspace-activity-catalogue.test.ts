import { OPEN_PLAN_STATUSES } from "@/types/agent/plan"
import { ISSUE_RUN_STATUSES } from "@/types/issues"

import { PLAN_STATUSES_FOR_TEST, RUN_STATUSES_FOR_TEST } from "./workspace-activity-catalogue"

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
})
