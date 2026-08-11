import {
  GoalCreateConfig,
  GoalListConfig,
  GoalTransitionConfig,
  GoalEventsConfig,
  GoalUpdateObjectiveConfig,
  GoalUpdateConfigConfig,
  GoalToggleSubgoalConfig,
  GoalAnalyticsConfig,
  GoalTemplateListConfig,
  GoalTemplateCreateGoalConfig,
  GoalTemplateUpsertConfig,
  GoalTemplateFavoriteConfig,
  GoalTemplateDeleteConfig,
} from "./goal-forms"

describe("goal-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        GoalCreateConfig,
        GoalListConfig,
        GoalTransitionConfig,
        GoalEventsConfig,
        GoalUpdateObjectiveConfig,
        GoalUpdateConfigConfig,
        GoalToggleSubgoalConfig,
        GoalAnalyticsConfig,
        GoalTemplateListConfig,
        GoalTemplateCreateGoalConfig,
        GoalTemplateUpsertConfig,
        GoalTemplateFavoriteConfig,
        GoalTemplateDeleteConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})
