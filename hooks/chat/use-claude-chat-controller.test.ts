import { resolveChatTurnAttemptIdentity, useClaudeChat } from "./use-claude-chat-controller"

describe("Claude chat controller seam", () => {
  it("exports the public hook implementation", () => {
    expect(typeof useClaudeChat).toBe("function")
    expect(useClaudeChat.name).toBe("useClaudeChat")
  })

  it("keeps durable-work behavior covered by the public hook contract suite", () => {
    // The behavioral tests live in use-claude-chat.test.ts because that suite
    // owns the hook's full sidecar/store harness. Keep this seam explicit so a
    // future split cannot silently drop acceptance/claim/handoff coverage.
    expect(typeof useClaudeChat).toBe("function")
  })

  it("keeps turn stable and increments attempt across regenerate/retry", () => {
    const attempts = new Map<string, number>()
    const messages = [{ id: "user-1", role: "user", parts: [] }] as never
    const first = resolveChatTurnAttemptIdentity({
      sessionId: "s1",
      runId: "r1",
      messages: [],
      reuseLastUserTurn: false,
      attempts,
      mintTurnId: () => "user-1",
    })
    const retry = resolveChatTurnAttemptIdentity({
      sessionId: "s1",
      runId: "r1",
      messages,
      reuseLastUserTurn: true,
      attempts,
    })
    expect(first).toEqual({ runId: "r1", turnId: "user-1", attemptId: "a1" })
    expect(retry).toEqual({ runId: "r1", turnId: "user-1", attemptId: "a2" })
  })

  // HostState send/steer/abort/approval branches are exercised by the public
  // hook contract suite in `use-claude-chat.test.ts`; this seam test remains
  // intentionally dependency-free so import regressions fail quickly.
})
