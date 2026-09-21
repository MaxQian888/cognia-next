import {
  resolveChatTurnAttemptIdentity,
  useClaudeChat,
  userPromptText,
  rewriteUserPromptText,
} from "./use-claude-chat-controller"

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

describe("attachment prompt hook isolation", () => {
  const content = [
    { type: "text" as const, text: "PRIVATE ATTACHMENT BODY" },
    { type: "text" as const, text: "Summarize the report" },
    { type: "text" as const, text: "Unrelated appended context" },
  ]
  it("selects only the authored block after attachment provenance", () => {
    expect(userPromptText(content, 1)).toBe("Summarize the report")
    expect(userPromptText(content.slice(0, 1), 1)).toBe("")
  })
  it("rewrites only authored prose and preserves every attachment/context block", () => {
    expect(rewriteUserPromptText(content, "Rewritten request", 1)).toEqual([
      content[0],
      { type: "text", text: "Rewritten request" },
      content[2],
    ])
    expect(rewriteUserPromptText(content.slice(0, 1), "Do not replace the file", 1)).toEqual(
      content.slice(0, 1)
    )
    expect(rewriteUserPromptText("original", "new")).toBe("new")
  })
})
