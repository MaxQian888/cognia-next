/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

let onMessageCallback: ((evt: unknown) => void) | null = null
const onClaudeUnsub = jest.fn()
const sendPromptMock = jest.fn().mockResolvedValue(undefined)
const closeSessionMock = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/claude/ipc", () => ({
  onClaudeMessage: jest.fn(async (cb: (evt: unknown) => void) => {
    onMessageCallback = cb
    return onClaudeUnsub
  }),
  closeSession: (id: string) => closeSessionMock(id),
  sendPrompt: (...args: unknown[]) => sendPromptMock(...args),
}))

jest.mock("@/lib/skills/ai-prompts", () => ({
  buildAiSystemPrompt: () => "system",
  buildAiUserPrompt: (intent: unknown, current: unknown) =>
    `intent:${JSON.stringify({ intent, current })}`,
}))

import { useSkillAi } from "./use-skill-ai"

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(true)
  onMessageCallback = null
  onClaudeUnsub.mockClear()
  sendPromptMock.mockClear()
  closeSessionMock.mockClear()
})

describe("useSkillAi", () => {
  it("rejects outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useSkillAi())
    await expect(
      act(async () => {
        await result.current.run("improve" as never, {
          name: "skill",
          content: "old",
        })
      })
    ).rejects.toThrow(/desktop mode/)
  })

  it("resolves the buffered text once session_ended fires", async () => {
    const { result } = renderHook(() => useSkillAi())
    let runPromise!: Promise<string | null>
    await act(async () => {
      runPromise = result.current.run("improve" as never, {
        name: "skill",
        content: "old",
      })
      // Allow the listener to register.
      await new Promise<void>((r) => setTimeout(r, 0))
      onMessageCallback?.({
        type: "event",
        sessionId: getActiveSessionId(),
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "new content" }] },
        },
      })
      onMessageCallback?.({
        type: "session_ended",
        sessionId: getActiveSessionId(),
      })
    })
    await expect(runPromise).resolves.toBe("new content")
  })

  it("strips ```markdown fences from the model output", async () => {
    const { result } = renderHook(() => useSkillAi())
    let runPromise!: Promise<string | null>
    await act(async () => {
      runPromise = result.current.run("improve" as never, {
        name: "skill",
        content: "old",
      })
      await new Promise<void>((r) => setTimeout(r, 0))
      onMessageCallback?.({
        type: "event",
        sessionId: getActiveSessionId(),
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "```markdown\nfenced\n```" }] },
        },
      })
      onMessageCallback?.({
        type: "session_ended",
        sessionId: getActiveSessionId(),
      })
    })
    await expect(runPromise).resolves.toBe("fenced")
  })

  it("session_ended with error rejects with that error", async () => {
    const { result } = renderHook(() => useSkillAi())
    let runPromise!: Promise<string | null>
    await act(async () => {
      runPromise = result.current.run("improve" as never, {
        name: "skill",
        content: "old",
      })
      // Attach a catch handler now so jest doesn't see an "unhandled rejection"
      // before the next act() resolves.
      runPromise.catch(() => undefined)
      await new Promise<void>((r) => setTimeout(r, 0))
      onMessageCallback?.({
        type: "session_ended",
        sessionId: getActiveSessionId(),
        error: "bad",
      })
    })
    await expect(runPromise).rejects.toThrow("bad")
  })

  it("sidecar_exited rejects with sidecar message", async () => {
    const { result } = renderHook(() => useSkillAi())
    let runPromise!: Promise<string | null>
    await act(async () => {
      runPromise = result.current.run("improve" as never, {
        name: "skill",
        content: "old",
      })
      runPromise.catch(() => undefined)
      await new Promise<void>((r) => setTimeout(r, 0))
      onMessageCallback?.({ type: "sidecar_exited" })
    })
    await expect(runPromise).rejects.toThrow(/Sidecar exited/)
  })

  it("cancel closes the active session and clears the ref", async () => {
    const { result } = renderHook(() => useSkillAi())
    let runPromise!: Promise<string | null>
    await act(async () => {
      runPromise = result.current.run("improve" as never, {
        name: "skill",
        content: "old",
      })
      await new Promise<void>((r) => setTimeout(r, 0))
      result.current.cancel()
      // We still need to settle the promise so jest doesn't warn.
      onMessageCallback?.({
        type: "session_ended",
        sessionId: getActiveSessionId(),
      })
    })
    expect(closeSessionMock).toHaveBeenCalled()
    await runPromise.catch(() => undefined)
  })

  it("sendPrompt failure is converted into a rejection", async () => {
    sendPromptMock.mockRejectedValueOnce(new Error("nope"))
    const { result } = renderHook(() => useSkillAi())
    let runPromise!: Promise<string | null>
    await act(async () => {
      runPromise = result.current.run("improve" as never, {
        name: "skill",
        content: "old",
      })
      runPromise.catch(() => undefined)
      await new Promise<void>((r) => setTimeout(r, 5))
    })
    await expect(runPromise).rejects.toThrow("nope")
  })

  it("times out after the configured TIMEOUT_MS", async () => {
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => useSkillAi())
      const runPromise: Promise<string | null> = result.current.run("improve" as never, {
        name: "skill",
        content: "old",
      })
      runPromise.catch(() => undefined)
      await Promise.resolve()
      jest.advanceTimersByTime(60_001)
      await expect(runPromise).rejects.toThrow(/timed out/)
    } finally {
      jest.useRealTimers()
    }
  })
})

function getActiveSessionId(): string {
  // The hook generates session ids with a `skill-ai-` prefix; we read them
  // back via the call args of sendPrompt.
  const lastCall = sendPromptMock.mock.calls[sendPromptMock.mock.calls.length - 1]
  return (lastCall?.[0] as string) ?? ""
}
