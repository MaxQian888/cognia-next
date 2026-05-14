import {
  __resetTerminalBridgeForTesting,
  configureTerminalBridge,
  createTerminal,
  disposeTerminal,
  disposeTerminalsByExtension,
  getTerminal,
  listTerminals,
  sendText,
  subscribeTerminalEvents,
  type ShellChildProcess,
  type TerminalEvent,
  type TerminalOutputSink,
} from "./terminal-bridge"

function makeFakeChild(): ShellChildProcess & {
  emitStdout(text: string): void
  emitStderr(text: string): void
  emitClose(exitCode: number): void
} {
  const stdoutListeners: Array<(c: string) => void> = []
  const stderrListeners: Array<(c: string) => void> = []
  let resolveFinished: (e: { exitCode: number | null; signal: string | null }) => void = () => {}
  const finished = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    resolveFinished = resolve
  })
  const child = {
    pid: 12345,
    write: jest.fn(),
    kill: jest.fn(),
    finished,
    onStdout: (listener: (c: string) => void) => {
      stdoutListeners.push(listener)
      return () => {
        const idx = stdoutListeners.indexOf(listener)
        if (idx >= 0) stdoutListeners.splice(idx, 1)
      }
    },
    onStderr: (listener: (c: string) => void) => {
      stderrListeners.push(listener)
      return () => {
        const idx = stderrListeners.indexOf(listener)
        if (idx >= 0) stderrListeners.splice(idx, 1)
      }
    },
    emitStdout: (text: string) => stdoutListeners.forEach((l) => l(text)),
    emitStderr: (text: string) => stderrListeners.forEach((l) => l(text)),
    emitClose: (exitCode: number) => {
      resolveFinished({ exitCode, signal: null })
    },
  }
  return child
}

function makeFakeSink(): TerminalOutputSink & {
  appendCalls: Array<{ id: string; kind: string; text: string }>
  closedCalls: Array<{ id: string; exitCode: number | null }>
} {
  const appendCalls: Array<{ id: string; kind: string; text: string }> = []
  const closedCalls: Array<{ id: string; exitCode: number | null }> = []
  return {
    appendCalls,
    closedCalls,
    appendLine(terminalId, kind, text) {
      appendCalls.push({ id: terminalId, kind, text })
    },
    markClosed(terminalId, exitCode) {
      closedCalls.push({ id: terminalId, exitCode })
    },
  }
}

describe("terminal-bridge", () => {
  beforeEach(() => __resetTerminalBridgeForTesting())

  describe("configuration", () => {
    it("throws when createTerminal is called before configure", () => {
      expect(() => createTerminal({ extensionId: "x", name: "T" })).toThrow(/not configured/i)
    })
  })

  describe("createTerminal", () => {
    it("spawns the child process when shellPath is set", () => {
      const sink = makeFakeSink()
      const spawn = jest.fn(() => makeFakeChild())
      configureTerminalBridge({ spawn, outputSink: sink })

      const t = createTerminal({
        extensionId: "ext.a",
        name: "Build",
        shellPath: "/bin/echo",
        shellArgs: ["hi"],
        cwd: "/tmp",
      })
      expect(spawn).toHaveBeenCalledWith("/bin/echo", ["hi"], {
        cwd: "/tmp",
        env: undefined,
      })
      expect(t.child).toBeDefined()
      expect(getTerminal(t.id)).toBe(t)
    })

    it("creates an input-only terminal when shellPath is omitted", () => {
      const sink = makeFakeSink()
      const spawn = jest.fn(() => makeFakeChild())
      configureTerminalBridge({ spawn, outputSink: sink })

      const t = createTerminal({ extensionId: "x", name: "Pure" })
      expect(t.child).toBeNull()
      expect(spawn).not.toHaveBeenCalled()
    })

    it("appends the system banner line on create", () => {
      const sink = makeFakeSink()
      configureTerminalBridge({ spawn: () => makeFakeChild(), outputSink: sink })
      createTerminal({
        extensionId: "x",
        name: "Build",
        shellPath: "/bin/echo",
        shellArgs: ["hi"],
      })
      expect(sink.appendCalls[0]?.kind).toBe("system")
      expect(sink.appendCalls[0]?.text).toContain("Build")
    })
  })

  describe("stdout / stderr / close pumping", () => {
    it("streams stdout / stderr into the sink + emits events", async () => {
      const sink = makeFakeSink()
      const child = makeFakeChild()
      configureTerminalBridge({ spawn: () => child, outputSink: sink })
      const events: TerminalEvent[] = []
      const dispose = subscribeTerminalEvents((e) => events.push(e))

      const t = createTerminal({
        extensionId: "x",
        name: "T",
        shellPath: "sh",
      })
      child.emitStdout("hello\n")
      child.emitStderr("warn\n")
      await new Promise((r) => setTimeout(r, 0))
      expect(sink.appendCalls.some((c) => c.kind === "stdout" && c.text === "hello\n")).toBe(true)
      expect(sink.appendCalls.some((c) => c.kind === "stderr" && c.text === "warn\n")).toBe(true)
      const kinds = events.map((e) => e.type)
      expect(kinds).toEqual(expect.arrayContaining(["open", "stdout", "stderr"]))
      expect(t.id).toBeDefined()
      dispose()
    })

    it("marks the terminal closed when the process exits", async () => {
      const sink = makeFakeSink()
      const child = makeFakeChild()
      configureTerminalBridge({ spawn: () => child, outputSink: sink })
      const t = createTerminal({ extensionId: "x", name: "T", shellPath: "sh" })
      child.emitClose(0)
      await child.finished
      await new Promise((r) => setTimeout(r, 0))
      expect(sink.closedCalls).toEqual([{ id: t.id, exitCode: 0 }])
      expect(t.exitCode).toBe(0)
    })
  })

  describe("sendText", () => {
    it("forwards into the child's stdin with a newline by default", () => {
      const sink = makeFakeSink()
      const child = makeFakeChild()
      configureTerminalBridge({ spawn: () => child, outputSink: sink })
      const t = createTerminal({ extensionId: "x", name: "T", shellPath: "sh" })
      sendText(t.id, "ls")
      expect(child.write).toHaveBeenCalledWith("ls\n")
      expect(sink.appendCalls.some((c) => c.text === "> ls")).toBe(true)
    })

    it("respects addNewLine=false", () => {
      const sink = makeFakeSink()
      const child = makeFakeChild()
      configureTerminalBridge({ spawn: () => child, outputSink: sink })
      const t = createTerminal({ extensionId: "x", name: "T", shellPath: "sh" })
      sendText(t.id, "ls", false)
      expect(child.write).toHaveBeenCalledWith("ls")
    })

    it("is a no-op for an unknown id and for disposed terminals", () => {
      const sink = makeFakeSink()
      const child = makeFakeChild()
      configureTerminalBridge({ spawn: () => child, outputSink: sink })
      sendText("nope", "x")
      const t = createTerminal({ extensionId: "x", name: "T", shellPath: "sh" })
      disposeTerminal(t.id)
      sendText(t.id, "after dispose")
      // First sendText would have written; we expect zero writes after dispose.
      expect(child.write).not.toHaveBeenCalledWith("after dispose\n")
    })

    it("appends user input to input-only terminals without crashing", () => {
      const sink = makeFakeSink()
      configureTerminalBridge({ spawn: () => makeFakeChild(), outputSink: sink })
      const t = createTerminal({ extensionId: "x", name: "T" })
      sendText(t.id, "echo")
      expect(sink.appendCalls.some((c) => c.text === "> echo")).toBe(true)
    })
  })

  describe("disposeTerminal", () => {
    it("kills the child with SIGTERM", () => {
      const sink = makeFakeSink()
      const child = makeFakeChild()
      configureTerminalBridge({ spawn: () => child, outputSink: sink })
      const t = createTerminal({ extensionId: "x", name: "T", shellPath: "sh" })
      expect(disposeTerminal(t.id)).toBe(true)
      expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    })

    it("emits close + markClosed for input-only terminals", async () => {
      const sink = makeFakeSink()
      configureTerminalBridge({ spawn: () => makeFakeChild(), outputSink: sink })
      const events: TerminalEvent[] = []
      subscribeTerminalEvents((e) => events.push(e))
      const t = createTerminal({ extensionId: "x", name: "T" })
      disposeTerminal(t.id)
      await new Promise((r) => setTimeout(r, 0))
      expect(sink.closedCalls).toEqual([{ id: t.id, exitCode: 0 }])
      const closes = events.filter((e) => e.type === "close")
      expect(closes).toHaveLength(1)
    })

    it("is idempotent on repeat dispose", () => {
      const sink = makeFakeSink()
      configureTerminalBridge({ spawn: () => makeFakeChild(), outputSink: sink })
      const t = createTerminal({ extensionId: "x", name: "T", shellPath: "sh" })
      expect(disposeTerminal(t.id)).toBe(true)
      expect(disposeTerminal(t.id)).toBe(false)
    })

    it("returns false for unknown ids", () => {
      const sink = makeFakeSink()
      configureTerminalBridge({ spawn: () => makeFakeChild(), outputSink: sink })
      expect(disposeTerminal("nope")).toBe(false)
    })

    it("survives a child whose kill() throws", () => {
      const sink = makeFakeSink()
      const child = makeFakeChild()
      child.kill = jest.fn(() => {
        throw new Error("kill boom")
      })
      configureTerminalBridge({ spawn: () => child, outputSink: sink })
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const t = createTerminal({ extensionId: "x", name: "T", shellPath: "sh" })
        disposeTerminal(t.id)
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it("bulk-disposes by extension id", () => {
      const sink = makeFakeSink()
      configureTerminalBridge({ spawn: () => makeFakeChild(), outputSink: sink })
      createTerminal({ extensionId: "ext.a", name: "1", shellPath: "sh" })
      createTerminal({ extensionId: "ext.a", name: "2", shellPath: "sh" })
      createTerminal({ extensionId: "ext.b", name: "3", shellPath: "sh" })
      const removed = disposeTerminalsByExtension("ext.a")
      expect(removed).toBe(2)
      expect(listTerminals().filter((t) => !t.disposed)).toHaveLength(1)
    })
  })

  describe("subscribeTerminalEvents listener resilience", () => {
    it("survives a listener that throws", async () => {
      const sink = makeFakeSink()
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        configureTerminalBridge({ spawn: () => makeFakeChild(), outputSink: sink })
        subscribeTerminalEvents(() => {
          throw new Error("listener boom")
        })
        createTerminal({ extensionId: "x", name: "T" })
        await new Promise((r) => setTimeout(r, 0))
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })
})
