import { SidecarIssueLoopDriver } from "./sidecar-driver"
import type { ClaudeEvent, SendContent, SendOptions } from "@cognia/agent-config-types"

describe("SidecarIssueLoopDriver", () => {
  function setup() {
    let handler: ((evt: ClaudeEvent) => void) | undefined
    const unlisten = jest.fn(() => undefined)
    const onClaudeMessage = jest.fn(async (h: (evt: ClaudeEvent) => void) => {
      handler = h
      return unlisten
    })
    const sendPrompt = jest.fn(
      async (_sid: string, _prompt: SendContent, _opts?: SendOptions): Promise<void> => undefined
    )
    const interruptSession = jest.fn(async (_sid: string): Promise<void> => undefined)
    const now = jest.fn(() => 1000)
    const driver = new SidecarIssueLoopDriver(
      { sendPrompt, interruptSession, onClaudeMessage, now },
      { maxTurns: 10 }
    )
    return {
      driver,
      sendPrompt,
      interruptSession,
      onClaudeMessage,
      unlisten,
      now,
      emit(evt: ClaudeEvent) {
        handler?.(evt)
      },
    }
  }

  it("sends a prompt with cwd + builtinTools and resolves on session_ended", async () => {
    const ctx = setup()
    let sessionId = ""
    ctx.sendPrompt.mockImplementation(async (sid: string): Promise<void> => {
      sessionId = sid
    })
    const runPromise = ctx.driver.run({
      workspacePath: "/tmp/work",
      repoFullName: "octocat/hello",
      issueNumber: 5,
      issueTitle: "Fix typo",
      issueBody: "in README",
      signal: new AbortController().signal,
    })

    // Wait one tick for sendPrompt to register the session id.
    await Promise.resolve()
    await Promise.resolve()
    expect(ctx.sendPrompt).toHaveBeenCalledTimes(1)
    const args = ctx.sendPrompt.mock.calls[0]
    expect(args[2]).toMatchObject({
      cwd: "/tmp/work",
      systemPrompt: expect.stringContaining("<SUMMARY>"),
      builtinTools: { fileExtras: true, git: true, shellAdvanced: true },
      maxTurns: 10,
    })

    ctx.now.mockReturnValue(1500)
    ctx.emit({
      type: "session_ended",
      sessionId,
      result: {
        type: "result",
        subtype: "success",
        duration_ms: 100,
        is_error: false,
        result: "intro <SUMMARY>fixed typo</SUMMARY>",
        uuid: "u",
        session_id: "s",
      },
    })

    const result = await runPromise
    expect(result).toEqual({ summary: "fixed typo", durationMs: 500 })
    expect(ctx.unlisten).toHaveBeenCalled()
  })

  it("rejects when the sidecar reports an error", async () => {
    const ctx = setup()
    let sessionId = ""
    ctx.sendPrompt.mockImplementation(async (sid: string): Promise<void> => {
      sessionId = sid
    })
    const runPromise = ctx.driver.run({
      workspacePath: "/tmp/work",
      repoFullName: "octocat/hello",
      issueNumber: 6,
      issueTitle: "Bug",
      issueBody: "",
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    await Promise.resolve()
    ctx.emit({
      type: "session_ended",
      sessionId,
      error: "sdk crashed",
    })
    await expect(runPromise).rejects.toThrow(/sdk crashed/)
  })

  it("aborts via interruptSession and rejects when the signal fires mid-run", async () => {
    const ctx = setup()
    const ac = new AbortController()
    const runPromise = ctx.driver.run({
      workspacePath: "/tmp/work",
      repoFullName: "octocat/hello",
      issueNumber: 7,
      issueTitle: "Bug",
      issueBody: "",
      signal: ac.signal,
    })
    await Promise.resolve()
    await Promise.resolve()
    ac.abort()
    await expect(runPromise).rejects.toThrow(/aborted before session_ended/)
    expect(ctx.interruptSession).toHaveBeenCalledTimes(1)
  })

  it("calls interruptSession synchronously when the signal is pre-aborted", async () => {
    const ctx = setup()
    const ac = new AbortController()
    ac.abort()
    const runPromise = ctx.driver.run({
      workspacePath: "/tmp/work",
      repoFullName: "octocat/hello",
      issueNumber: 8,
      issueTitle: "Bug",
      issueBody: "",
      signal: ac.signal,
    })
    await expect(runPromise).rejects.toThrow(/aborted before session_ended/)
    expect(ctx.interruptSession).toHaveBeenCalledTimes(1)
  })

  it("propagates a sendPrompt failure and unsubscribes", async () => {
    const ctx = setup()
    ctx.sendPrompt.mockRejectedValueOnce(new Error("sidecar offline"))
    const runPromise = ctx.driver.run({
      workspacePath: "/tmp/work",
      repoFullName: "octocat/hello",
      issueNumber: 9,
      issueTitle: "x",
      issueBody: "",
      signal: new AbortController().signal,
    })
    await expect(runPromise).rejects.toThrow(/sidecar offline/)
    expect(ctx.unlisten).toHaveBeenCalled()
  })

  it("ignores events from other sessions", async () => {
    const ctx = setup()
    let sessionId = ""
    ctx.sendPrompt.mockImplementation(async (sid: string): Promise<void> => {
      sessionId = sid
    })
    const runPromise = ctx.driver.run({
      workspacePath: "/tmp/work",
      repoFullName: "octocat/hello",
      issueNumber: 10,
      issueTitle: "x",
      issueBody: "",
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    await Promise.resolve()
    // Stray event from a different session must not resolve the promise.
    ctx.emit({
      type: "session_ended",
      sessionId: "wf:gh-issue:other:1:1",
      result: {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        is_error: false,
        result: "wrong",
        uuid: "u",
        session_id: "s",
      },
    })
    // Now emit the real one.
    ctx.emit({
      type: "session_ended",
      sessionId,
      result: {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        is_error: false,
        result: "real <SUMMARY>done</SUMMARY>",
        uuid: "u",
        session_id: "s",
      },
    })
    const result = await runPromise
    expect(result.summary).toBe("done")
  })
})
