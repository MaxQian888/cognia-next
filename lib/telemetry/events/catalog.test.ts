import { TELEMETRY_EVENT_CATALOG } from "./catalog"

it("registers every supported behavior event name", () => {
  expect(Object.keys(TELEMETRY_EVENT_CATALOG).sort()).toEqual([
    "agent.execution.resolved",
    "agent.teammate.completed",
    "agent.teammate.failed",
    "agent.teammate.started",
    "chat.message.sent",
    "chat.turn.completed",
    "chat.turn.failed",
    "connector.message.received",
    "connector.message.sent",
    "support.diagnostics.consent.changed",
    "support.feedback.draft.exported",
    "support.feedback.draft.opened",
    "support.session.opened",
    "telemetry.preference.changed",
    "workflow.run.cancelled",
    "workflow.run.completed",
    "workflow.run.failed",
    "workflow.run.started",
  ])
})
