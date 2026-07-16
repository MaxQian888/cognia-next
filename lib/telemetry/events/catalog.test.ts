import { TELEMETRY_EVENT_CATALOG } from "./catalog"

it("registers every supported behavior event name", () => {
  expect(Object.keys(TELEMETRY_EVENT_CATALOG).sort()).toEqual([
    "chat.message.sent",
    "connector.message.received",
    "telemetry.preference.changed",
    "workflow.run.started",
  ])
})
