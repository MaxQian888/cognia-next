import {
  ManualTriggerConfig,
  CronConfig,
  ConnectorInboundConfig,
  IntegrationEventTriggerConfig,
  ChatMessageTriggerConfig,
  GoalCompletedTriggerConfig,
  WorkflowCompletedTriggerConfig,
  WebhookTriggerConfig,
  TeamTriggerConfig,
  DesktopEventTriggerConfig,
  PetEventTriggerConfig,
} from "./trigger-forms"

describe("trigger-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        ManualTriggerConfig,
        CronConfig,
        ConnectorInboundConfig,
        IntegrationEventTriggerConfig,
        ChatMessageTriggerConfig,
        GoalCompletedTriggerConfig,
        WorkflowCompletedTriggerConfig,
        WebhookTriggerConfig,
        TeamTriggerConfig,
        DesktopEventTriggerConfig,
        PetEventTriggerConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})
