/**
 * Tests for the BaseTerminalSession abstract listener/exit-state plumbing.
 *
 * We test the base by instantiating a minimal concrete subclass that
 * routes the protected `dispatch*` / `handleExit` helpers to a public
 * surface. Both `TerminalSession` (Tauri) and `RemoteTerminalSession`
 * (WS) reuse this base class — their own test files cover the
 * transport-specific wire format.
 */

import { BaseTerminalSession } from "./base-session"
import type { IntegrationEvent, SessionInfo } from "./types"

class TestableTerminalSession extends BaseTerminalSession {
  readonly info: SessionInfo

  constructor(info: SessionInfo) {
    super()
    this.info = info
  }

  async write(): Promise<void> {
    /* not used in this test */
  }

  async resize(): Promise<void> {
    /* not used in this test */
  }

  async kill(): Promise<void> {
    /* not used in this test */
  }

  // Exposing the protected helpers so the tests can drive them
  // without standing up a real transport.
  pushData(bytes: Uint8Array): void {
    this.dispatchData(bytes)
  }

  pushIntegration(event: IntegrationEvent): void {
    this.dispatchIntegration(event)
  }

  pushExit(code: number | null): void {
    this.handleExit(code)
  }
}

const info: SessionInfo = {
  id: "test-session",
  projectId: null,
  extensionId: null,
  origin: "local",
  shell: "/bin/bash",
}

function makeSession(): TestableTerminalSession {
  return new TestableTerminalSession(info)
}

describe("BaseTerminalSession.onData", () => {
  it("fans out to every subscriber", () => {
    const session = makeSession()
    const a: Uint8Array[] = []
    const b: Uint8Array[] = []
    session.onData((bytes) => a.push(bytes))
    session.onData((bytes) => b.push(bytes))
    session.pushData(new Uint8Array([1, 2, 3]))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(Array.from(a[0])).toEqual([1, 2, 3])
  })

  it("returned unsubscribe stops further dispatch", () => {
    const session = makeSession()
    const captured: Uint8Array[] = []
    const off = session.onData((bytes) => captured.push(bytes))
    session.pushData(new Uint8Array([1]))
    off()
    session.pushData(new Uint8Array([2]))
    expect(captured).toHaveLength(1)
  })

  it("swallows listener exceptions and keeps fanning out", () => {
    const session = makeSession()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const seen: Uint8Array[] = []
    session.onData(() => {
      throw new Error("boom")
    })
    session.onData((bytes) => seen.push(bytes))
    session.pushData(new Uint8Array([5]))
    expect(seen).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("BaseTerminalSession.onIntegration", () => {
  it("forwards integration events verbatim", () => {
    const session = makeSession()
    const seen: IntegrationEvent[] = []
    session.onIntegration((event) => seen.push(event))
    session.pushIntegration({ kind: "prompt_start" })
    session.pushIntegration({ kind: "command_end", exit_code: 1 })
    expect(seen).toEqual([{ kind: "prompt_start" }, { kind: "command_end", exit_code: 1 }])
  })

  it("unsubscribe stops integration dispatch", () => {
    const session = makeSession()
    const seen: IntegrationEvent[] = []
    const off = session.onIntegration((event) => seen.push(event))
    session.pushIntegration({ kind: "prompt_start" })
    off()
    session.pushIntegration({ kind: "prompt_end" })
    expect(seen).toEqual([{ kind: "prompt_start" }])
  })
})

describe("BaseTerminalSession.onExit / handleExit", () => {
  it("invokes subscribed exit listeners exactly once and clears them", () => {
    const session = makeSession()
    const a = jest.fn()
    const b = jest.fn()
    session.onExit(a)
    session.onExit(b)
    session.pushExit(7)
    expect(a).toHaveBeenCalledWith(7)
    expect(b).toHaveBeenCalledWith(7)
    // Second call is idempotent.
    session.pushExit(0)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(session.isExited).toBe(true)
    expect(session.lastExitCode).toBe(7)
  })

  it("fires immediately for late subscribers (on next microtask)", async () => {
    const session = makeSession()
    session.pushExit(42)
    const captured = jest.fn()
    session.onExit(captured)
    await Promise.resolve()
    expect(captured).toHaveBeenCalledWith(42)
  })

  it("swallows exit listener exceptions and keeps fanning out", () => {
    const session = makeSession()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const after = jest.fn()
    session.onExit(() => {
      throw new Error("boom")
    })
    session.onExit(after)
    session.pushExit(0)
    expect(after).toHaveBeenCalledWith(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("handleExit accepts null for signal-killed processes", () => {
    const session = makeSession()
    const seen = jest.fn()
    session.onExit(seen)
    session.pushExit(null)
    expect(seen).toHaveBeenCalledWith(null)
    expect(session.lastExitCode).toBeNull()
  })
})

describe("BaseTerminalSession info / id passthrough", () => {
  it("exposes id from the info block", () => {
    const session = makeSession()
    expect(session.id).toBe("test-session")
  })
})
