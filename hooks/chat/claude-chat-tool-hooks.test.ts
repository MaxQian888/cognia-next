import { chatToolCallsById, rememberChatToolCall } from "./claude-chat-tool-hooks"

describe("Claude chat tool correlation", () => {
  it("remembers tool calls by id", () => {
    rememberChatToolCall("tool-1", "Read", { path: "/tmp/a" })
    expect(chatToolCallsById.get("tool-1")).toEqual({ name: "Read", input: { path: "/tmp/a" } })
  })
})
