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

  async detach(): Promise<void> {
    /* not used in this test */
  }

  async takeControl(): Promise<void> {
    this.dispatchControlState({ role: "controller", controllerId: "test" })
  }

  async releaseControl(): Promise<void> {
    this.dispatchControlState({ role: "viewer", controllerId: null, reason: "released" })
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

  pushReplayGap(): void {
    this.dispatchReplayGap({ requestedAfter: 1, firstAvailable: 4, lastAvailable: 9 })
  }

  pushSnapshot(next: SessionInfo): void {
    this.applySessionSnapshot(next)
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
  it("retains decoded output even before subscribers attach", () => {
    const session = makeSession()
    expect(session.getLastOutput()).toBe("")

    session.pushData(new TextEncoder().encode("first "))
    session.onData(() => {})
    session.pushData(new TextEncoder().encode("second"))

    expect(session.getLastOutput()).toBe("first second")
  })

  it("bounds retained output by evicting the oldest chunks", () => {
    const session = makeSession()
    session.pushData(new Uint8Array(150 * 1024).fill("a".charCodeAt(0)))
    session.pushData(new Uint8Array(150 * 1024).fill("b".charCodeAt(0)))
    session.pushData(new Uint8Array(150 * 1024).fill("c".charCodeAt(0)))

    const output = session.getLastOutput()
    expect(output).toHaveLength(150 * 1024)
    expect(output.startsWith("c")).toBe(true)
    expect(output).not.toContain("a")
  })

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

  it("buffers data that arrives before any listener and replays it on subscribe", () => {
    const session = makeSession()
    // Simulates Rust's reattach replay landing before the xterm mounts.
    session.pushData(new Uint8Array([1, 2]))
    session.pushData(new Uint8Array([3]))
    const seen: Uint8Array[] = []
    session.onData((bytes) => seen.push(bytes))
    expect(seen.map((c) => Array.from(c))).toEqual([[1, 2], [3]])
  })

  it("does not replay the buffer to a second subscriber", () => {
    const session = makeSession()
    session.pushData(new Uint8Array([9]))
    const first: Uint8Array[] = []
    const second: Uint8Array[] = []
    session.onData((b) => first.push(b))
    session.onData((b) => second.push(b))
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it("re-buffers and replays after all listeners detach (tab switch)", () => {
    const session = makeSession()
    const off = session.onData(() => {})
    off()
    // Output produced while the tab is backgrounded (no mounted instance).
    session.pushData(new Uint8Array([7]))
    const seen: Uint8Array[] = []
    session.onData((bytes) => seen.push(bytes))
    expect(seen.map((c) => Array.from(c))).toEqual([[7]])
  })

  it("caps the early-data buffer, dropping the oldest chunks", () => {
    const session = makeSession()
    const big = () => new Uint8Array(400 * 1024) // 400KB; cap is 1MB
    session.pushData(big()) // oldest — should be evicted (3×400KB > 1MB)
    session.pushData(big())
    session.pushData(big())
    const seen: Uint8Array[] = []
    session.onData((bytes) => seen.push(bytes))
    // Oldest chunk dropped so total stays under the 1MB cap.
    expect(seen.length).toBe(2)
    expect(seen.reduce((n, c) => n + c.length, 0)).toBeLessThanOrEqual(1024 * 1024)
  })

  it("ignores empty data chunks in the buffer", () => {
    const session = makeSession()
    session.pushData(new Uint8Array([]))
    const seen: Uint8Array[] = []
    session.onData((bytes) => seen.push(bytes))
    expect(seen).toHaveLength(0)
  })
})

describe("BaseTerminalSession control state", () => {
  it("publishes controller acquisition and release", async () => {
    const session = makeSession()
    const states: string[] = []
    session.onControlState((state) => states.push(state.role))
    await Promise.resolve()
    await session.releaseControl()
    await session.takeControl()
    expect(states).toEqual(["controller", "viewer", "controller"])
  })
})

describe("BaseTerminalSession replay gaps", () => {
  it("surfaces missing output instead of silently presenting partial scrollback", () => {
    const session = makeSession()
    const gaps: number[] = []
    session.onReplayGap((gap) => gaps.push(gap.firstAvailable))
    session.pushReplayGap()
    expect(gaps).toEqual([4])
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

describe("BaseTerminalSession flow control", () => {
  it("defaults to an inert, self-describing no-op", async () => {
    // Rule 7: the dormancy is documented on the type, labelled in the UI
    // (`outputThrottledBuffered`), and pinned here. Transports without
    // end-to-end flow control degrade to renderer-side buffering only.
    const session = makeSession()
    expect(session.supportsFlowControl).toBe(false)
    await expect(session.setFlowControl(true)).resolves.toBe(false)
    await expect(session.setFlowControl(false)).resolves.toBe(false)
  })
})

describe("BaseTerminalSession session snapshots (ADR-0133)", () => {
  it("refreshes info in place, drops keys the host stopped sending, and notifies onInfo", () => {
    const session = new TestableTerminalSession({ ...info, sshHostKeyStatus: "learned" })
    const before = session.info
    const seen: SessionInfo[] = []
    const off = session.onInfo((next) => seen.push({ ...next }))

    session.pushSnapshot({
      ...info,
      currentController: "companion:dev-1",
      attachedClients: 2,
      participants: [
        { clientId: "desktop", deviceId: null, local: true, role: "viewer" },
        { clientId: "companion:dev-1", deviceId: "dev-1", local: false, role: "controller" },
      ],
    })

    // Same object — consumers holding `session.info` see the update.
    expect(session.info).toBe(before)
    expect(session.info.currentController).toBe("companion:dev-1")
    expect(session.participants).toHaveLength(2)
    expect(session.info.sshHostKeyStatus).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0].participants).toHaveLength(2)

    off()
    session.pushSnapshot({ ...info, participants: [] })
    expect(seen).toHaveLength(1)
    expect(session.participants).toEqual([])
  })

  it("ignores snapshots for another session and survives a throwing listener", () => {
    const session = makeSession()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const good = jest.fn()
    session.onInfo(() => {
      throw new Error("boom")
    })
    session.onInfo(good)

    session.pushSnapshot({ ...info, id: "someone-else", attachedClients: 9 })
    expect(session.info.attachedClients).toBeUndefined()
    expect(good).not.toHaveBeenCalled()

    session.pushSnapshot({ ...info, attachedClients: 3 })
    expect(good).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("reports an empty roster for hosts that predate participants", () => {
    expect(makeSession().participants).toEqual([])
  })
})
