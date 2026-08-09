import {
  runStartupCommands,
  STARTUP_COMMAND_DELAY_MS,
  STARTUP_COMMAND_TIMEOUT_MS,
  type StartupCommandSession,
} from "./startup-commands"

function makeSession(opts: { hasIntegration?: boolean } = {}): StartupCommandSession & {
  written: string[]
  promptCbs: Array<() => void>
  triggerPrompt: () => void
} {
  const written: string[] = []
  const promptCbs: Array<() => void> = []

  return {
    written,
    promptCbs,
    write: (data) => written.push(data),
    onNextPrompt:
      opts.hasIntegration !== false
        ? (cb) => {
            promptCbs.push(cb)
            return () => {
              const idx = promptCbs.indexOf(cb)
              if (idx >= 0) promptCbs.splice(idx, 1)
            }
          }
        : undefined,
    triggerPrompt: () => {
      const cb = promptCbs.shift()
      if (cb) cb()
    },
  }
}

jest.useFakeTimers()

/** Flush the microtask queue so Promises resolve between timer ticks. */
async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe("startup-commands", () => {
  afterEach(() => {
    jest.clearAllTimers()
  })

  it("writes all commands to the PTY with \\r appended", async () => {
    const session = makeSession({ hasIntegration: false })
    runStartupCommands(session, ["echo hello", "ls"])

    // First command is written immediately.
    expect(session.written).toContain("echo hello\r")

    // After delay, second command fires.
    jest.advanceTimersByTime(STARTUP_COMMAND_DELAY_MS + 10)
    await flushMicrotasks()
    expect(session.written).toContain("ls\r")
  })

  it("waits for prompt between commands when shell integration is available", async () => {
    const session = makeSession({ hasIntegration: true })
    runStartupCommands(session, ["cmd1", "cmd2", "cmd3"])

    // First command fires immediately.
    await flushMicrotasks()
    expect(session.written).toEqual(["cmd1\r"])

    // Second command waits for prompt.
    session.triggerPrompt()
    await flushMicrotasks()
    expect(session.written).toEqual(["cmd1\r", "cmd2\r"])

    // Third command waits for next prompt.
    session.triggerPrompt()
    await flushMicrotasks()
    expect(session.written).toEqual(["cmd1\r", "cmd2\r", "cmd3\r"])
  })

  it("falls back to delay when shell integration is not available", async () => {
    const session = makeSession({ hasIntegration: false })
    runStartupCommands(session, ["a", "b"])

    expect(session.written).toEqual(["a\r"])

    jest.advanceTimersByTime(STARTUP_COMMAND_DELAY_MS + 10)
    await flushMicrotasks()
    expect(session.written).toEqual(["a\r", "b\r"])
  })

  it("times out and proceeds if prompt never fires", async () => {
    const session = makeSession({ hasIntegration: true })
    runStartupCommands(session, ["slow", "next"])

    await flushMicrotasks()
    expect(session.written).toEqual(["slow\r"])

    // Don't trigger prompt — let it timeout.
    jest.advanceTimersByTime(STARTUP_COMMAND_TIMEOUT_MS + 10)
    await flushMicrotasks()
    expect(session.written).toEqual(["slow\r", "next\r"])
  })

  it("cancel() stops further commands from executing", async () => {
    const session = makeSession({ hasIntegration: false })
    const runner = runStartupCommands(session, ["first", "second"])

    expect(session.written).toEqual(["first\r"])
    runner.cancel()

    jest.advanceTimersByTime(STARTUP_COMMAND_DELAY_MS + 10)
    await flushMicrotasks()
    // Second command should NOT have been written.
    expect(session.written).toEqual(["first\r"])
  })

  it("handles empty command list gracefully", async () => {
    const session = makeSession()
    runStartupCommands(session, [])
    await flushMicrotasks()
    expect(session.written).toEqual([])
  })

  it("handles single command without waiting", async () => {
    const session = makeSession({ hasIntegration: true })
    runStartupCommands(session, ["only-one"])
    await flushMicrotasks()
    expect(session.written).toEqual(["only-one\r"])
    // No prompt listener should be active for a single command.
    expect(session.promptCbs).toHaveLength(0)
  })
})
