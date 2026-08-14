import { useClaudeChat } from "./use-claude-chat-controller"

describe("Claude chat controller seam", () => {
  it("exports the public hook implementation", () => {
    expect(typeof useClaudeChat).toBe("function")
    expect(useClaudeChat.name).toBe("useClaudeChat")
  })

  // HostState send/steer/abort/approval branches are exercised by the public
  // hook contract suite in `use-claude-chat.test.ts`; this seam test remains
  // intentionally dependency-free so import regressions fail quickly.
})
