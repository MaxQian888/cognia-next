import type { BehaviorEventRow } from "./behavior-event-types"

it("represents a persisted typed behavior event", () => {
  const row: BehaviorEventRow = {
    id: "event-1",
    eventName: "chat.message.sent",
    at: 1,
    sessionId: "session-1",
    attributes: { provider: "anthropic", streamed: true },
  }
  expect(row.attributes).toEqual({ provider: "anthropic", streamed: true })
})
