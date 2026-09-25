import type { PluginTerminalAPI } from "@cognia/plugin-sdk"
import { captureCommand, openPty, quietShell, runCommand, safeKill, ScanAbortError } from "./pty"
import { createMockTerminal, counterId, immediateSleep } from "./mock-shell.test-helpers"

/** Minimal terminal stub with byte-level emit control. */
function byteTerminal() {
  let handler: ((b: Uint8Array) => void) | null = null
  const writes: string[] = []
  const killed: string[] = []
  const terminal = {
    spawn: async () => ({ id: "s1", shell: "bash" }),
    onData: (_id: string, h: (b: Uint8Array) => void) => {
      handler = h
      return () => {
        handler = null
      }
    },
    write: async (_id: string, data: string | Uint8Array) => {
      writes.push(typeof data === "string" ? data : new TextDecoder().decode(data))
    },
    kill: async (id: string) => {
      killed.push(id)
    },
  } as unknown as PluginTerminalAPI
  return {
    terminal,
    writes,
    killed,
    emitBytes: (b: Uint8Array) => handler?.(b),
    emit: (s: string) => handler?.(new TextEncoder().encode(s)),
  }
}

describe("openPty", () => {
  it("buffers output and forwards cleaned text while streaming", async () => {
    const t = byteTerminal()
    const seen: string[] = []
    const pty = await openPty(t.terminal, { onConsole: (s) => seen.push(s) })

    t.emit("raw-out")
    expect(pty.buffer()).toBe("raw-out")
    expect(seen).toHaveLength(0) // not forwarding yet

    pty.forward(true)
    t.emit("more")
    expect(seen).toEqual(["more"])

    pty.forward(false)
    t.emit("quiet")
    expect(seen).toEqual(["more"])
    expect(pty.buffer()).toContain("quiet")
  })

  it("decodes UTF-8 across chunk boundaries", async () => {
    const t = byteTerminal()
    const seen: string[] = []
    const pty = await openPty(t.terminal, { onConsole: (s) => seen.push(s) })
    pty.forward(true)

    // "界" is 3 bytes in UTF-8 (E7 95 8C) — split it across two emissions.
    const bytes = new TextEncoder().encode("a界b")
    t.emitBytes(bytes.slice(0, 2)) // "a" + first byte of 界
    t.emitBytes(bytes.slice(2))
    expect(seen.join("")).toBe("a界b")
    expect(pty.buffer()).toBe("a界b")
  })

  it("keeps only a bounded tail while forwarding, but the whole buffer while capturing", async () => {
    const t = byteTerminal()
    const pty = await openPty(t.terminal, { onConsole: () => {} })
    pty.forward(true)

    const chunk = "x".repeat(128 * 1024)
    t.emit(chunk)
    t.emit(chunk)
    t.emit(chunk)
    expect(pty.buffer().length).toBeLessThanOrEqual(256 * 1024)
    expect(pty.buffer().endsWith("x".repeat(100))).toBe(true)

    // Forwarding off → captures keep the whole buffer (a capture's begin
    // marker must survive to be found).
    pty.forward(false)
    t.emit(chunk)
    t.emit(chunk)
    expect(pty.buffer().length).toBeGreaterThan(256 * 1024)
  })

  it("flushes a partial multibyte tail on dispose", async () => {
    const t = byteTerminal()
    const pty = await openPty(t.terminal, {})
    t.emitBytes(new Uint8Array([0xe7, 0x95])) // first two bytes of 界
    pty.dispose()
    // The dangling bytes flush as a replacement char rather than vanishing.
    expect(pty.buffer()).toBe("\uFFFD")
  })

  it("unsubscribes on dispose", async () => {
    const t = byteTerminal()
    const pty = await openPty(t.terminal, {})
    pty.dispose()
    t.emit("late")
    expect(pty.buffer()).not.toContain("late")
  })
})

describe("framed commands", () => {
  it("runCommand resolves the framed exit code", async () => {
    const { terminal } = createMockTerminal(() => ({ output: "hi", exitCode: 7 }))
    const pty = await openPty(terminal, {})
    const code = await runCommand(terminal, pty, "echo hi", counterId()(), {
      sleep: immediateSleep,
      pollMs: 1,
    })
    expect(code).toBe(7)
  })

  it("captureCommand returns the framed payload", async () => {
    const { terminal } = createMockTerminal(() => ({ output: "PAYLOAD", exitCode: 0 }))
    const pty = await openPty(terminal, {})
    const { raw, exitCode } = await captureCommand(terminal, pty, "cat f", counterId()(), {
      sleep: immediateSleep,
      pollMs: 1,
    })
    expect(exitCode).toBe(0)
    expect(raw).toContain("PAYLOAD")
  })

  it("aborts a poll and kills the session", async () => {
    const { terminal, killed, writes } = createMockTerminal(() => ({}))
    const pty = await openPty(terminal, {})
    // A command that never completes: record the write but emit nothing back,
    // so the poll can only end via the abort signal.
    terminal.write = async (_id, data) => {
      writes.push(String(data))
    }
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 0)
    await expect(
      runCommand(terminal, pty, "sleep 60", counterId()(), {
        // A real timer yield — Promise.resolve() would starve the abort's
        // setTimeout behind an unbroken microtask chain.
        sleep: () => new Promise((r) => setTimeout(r, 0)),
        pollMs: 1,
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(ScanAbortError)
    expect(killed).toContain("sess-1")
  })

  it("quietShell writes the echo/prompt suppression", async () => {
    const { terminal, writes } = createMockTerminal(() => ({}))
    const pty = await openPty(terminal, {})
    await quietShell(terminal, pty)
    expect(writes.join("")).toContain("stty -echo")
  })

  it("safeKill swallows an already-dead session", async () => {
    const { terminal } = createMockTerminal(() => ({}))
    terminal.kill = jest.fn().mockRejectedValue(new Error("gone"))
    await expect(safeKill(terminal, "sess-1")).resolves.toBeUndefined()
  })
})
