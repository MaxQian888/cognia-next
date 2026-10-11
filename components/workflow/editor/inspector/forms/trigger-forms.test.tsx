import { fireEvent, render } from "@testing-library/react"

import {
  ManualTriggerConfig,
  CronConfig,
  ConnectorInboundConfig,
  ConnectorSystemTriggerConfig,
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
        ConnectorSystemTriggerConfig,
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

describe("WebhookTriggerConfig", () => {
  it("edits the delivery id header that keys a retried delivery", () => {
    const onChange = jest.fn()
    const { container } = render(
      <WebhookTriggerConfig params={{ path: "incoming" }} onChange={onChange} />
    )
    const input = container.querySelector('[data-field="deliveryIdHeader"] input')
    if (!input) throw new Error("no delivery id header field")
    fireEvent.change(input, { target: { value: "X-GitHub-Delivery" } })
    expect(onChange).toHaveBeenCalledWith({
      path: "incoming",
      deliveryIdHeader: "X-GitHub-Delivery",
    })
  })
})
