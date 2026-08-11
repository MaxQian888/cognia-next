import {
  PlanCreateConfig,
  PlanListConfig,
  PlanEventsConfig,
  PlanTransitionConfig,
  PlanUpdateDraftConfig,
  PlanRejectConfig,
  PlanRefineConfig,
  PlanSetStepStatusConfig,
} from "./plan-forms"

describe("plan-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        PlanCreateConfig,
        PlanListConfig,
        PlanEventsConfig,
        PlanTransitionConfig,
        PlanUpdateDraftConfig,
        PlanRejectConfig,
        PlanRefineConfig,
        PlanSetStepStatusConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})
