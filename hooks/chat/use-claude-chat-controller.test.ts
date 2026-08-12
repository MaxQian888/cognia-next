import { useClaudeChat } from "./use-claude-chat-controller"

describe("Claude chat controller seam", () => {
  it("exports the public hook implementation", () => {
    expect(typeof useClaudeChat).toBe("function")
  })
})
