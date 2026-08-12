import { handleEvent, isTeamSubSession } from "./claude-chat-events"

describe("Claude chat event seam", () => {
  it("exports event routing and filters team sub-sessions", () => {
    expect(typeof handleEvent).toBe("function")
    expect(isTeamSubSession("team::char::member")).toBe(true)
  })
})
