import "."
import { getExecutor } from "../registry"

describe("trigger-nodes registration", () => {
  it.each([
    ["trigger.chat.message", 1],
    ["trigger.connector.inbound", 1],
    ["trigger.cron", 1],
    ["trigger.goal.completed", 1],
    ["trigger.integration.event", 1],
    ["trigger.manual", 1],
    ["trigger.team", 1],
    ["trigger.webhook", 1],
    ["trigger.workflow.completed", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})
