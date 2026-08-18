/**
 * @jest-environment jsdom
 *
 * ConnectorBusProvider — thin React host over the shared installer.
 *
 * The full boot-sequence behaviour is covered by
 * `lib/connectors/bootstrap/install-connector-runtime.test.ts`; this suite
 * asserts the React lifecycle binding (install on mount, dispose on unmount,
 * children rendered), the ADR-0082 remote-host guard (while driving a remote
 * Cognia host the local runtime is deferred so bots are not double-dialed),
 * and the ADR-0131 §2.7 lease-loss reclaim.
 */

import { render } from "@testing-library/react"
import { ConnectorBusProvider } from "./connector-bus-provider"
import { installConnectorRuntime } from "@/lib/connectors/bootstrap/install-connector-runtime"
import { setActiveRemoteTransport, __resetRoutingForTests } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"

const mockDispose = jest.fn()
jest.mock("@/lib/connectors/bootstrap/install-connector-runtime", () => ({
  installConnectorRuntime: jest.fn(() => mockDispose),
}))
const mockInstall = installConnectorRuntime as jest.MockedFunction<typeof installConnectorRuntime>

// Minimal stand-in for an active remote transport — the guard only checks
// presence (`activeRemote !== null`), never invokes it.
const fakeRemote = { call: jest.fn(), subscribe: jest.fn() } as unknown as Transport

beforeEach(() => {
  jest.clearAllMocks()
  __resetRoutingForTests()
})

afterEach(() => {
  __resetRoutingForTests()
})

describe("ConnectorBusProvider", () => {
  it("installs the connector runtime once on mount with default options", () => {
    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    expect(mockInstall).toHaveBeenCalledTimes(1)
    // Desktop keeps the installer defaults (isTauri gate, console log, no
    // row filter) — passing any of those here would fork desktop behaviour.
    // The only option is the lease-loss callback.
    expect(mockInstall).toHaveBeenCalledWith({ onRuntimeReleased: expect.any(Function) })
    expect(mockDispose).not.toHaveBeenCalled()
  })

  it("disposes the runtime on unmount", () => {
    const { unmount } = render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    unmount()
    expect(mockDispose).toHaveBeenCalledTimes(1)
  })

  it("renders children", () => {
    const { getByText } = render(
      <ConnectorBusProvider>
        <span>hello world</span>
      </ConnectorBusProvider>
    )
    expect(getByText("hello world")).toBeTruthy()
  })

  it("does not boot the local runtime while a remote host is active", () => {
    // The paired host's brain owns the connectors — a second copy here would
    // double-dial the same bots.
    setActiveRemoteTransport(fakeRemote)
    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    expect(mockInstall).not.toHaveBeenCalled()
  })

  it("tears the local runtime down when a remote host is activated mid-session", () => {
    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    expect(mockInstall).toHaveBeenCalledTimes(1)

    setActiveRemoteTransport(fakeRemote)
    expect(mockDispose).toHaveBeenCalledTimes(1)
  })

  it("reclaims the runtime when routing returns to local", () => {
    setActiveRemoteTransport(fakeRemote)
    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    expect(mockInstall).not.toHaveBeenCalled()

    setActiveRemoteTransport(null)
    expect(mockInstall).toHaveBeenCalledTimes(1)
    expect(mockDispose).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// ADR-0131 §2.7 — a peer took the runtime lease
// ─────────────────────────────────────────────────────────────────────────

describe("ConnectorBusProvider lease-loss reclaim", () => {
  /** Capture scheduled retries so the backoff can be driven deterministically. */
  function makeScheduler() {
    const scheduled: Array<{ run: () => void; delayMs: number }> = []
    const scheduleRetry = jest.fn((run: () => void, delayMs: number) => {
      const entry = { run, delayMs }
      scheduled.push(entry)
      return () => {
        const i = scheduled.indexOf(entry)
        if (i >= 0) scheduled.splice(i, 1)
      }
    })
    return { scheduled, scheduleRetry }
  }

  /** Fire the lease-loss callback the provider handed to the installer. */
  function releaseRuntime(call = 0) {
    const options = mockInstall.mock.calls[call]?.[0] as
      | { onRuntimeReleased?: (reason: "unmount" | "lease-lost") => void }
      | undefined
    options?.onRuntimeReleased?.("lease-lost")
  }

  it("re-acquires the runtime after a lost lease, on a backoff", () => {
    // Nothing in the React lifecycle fires when the installer tears itself
    // down; without this the desktop sits with no runtime until a restart.
    const { scheduled, scheduleRetry } = makeScheduler()
    render(<ConnectorBusProvider scheduleRetry={scheduleRetry} />)
    expect(mockInstall).toHaveBeenCalledTimes(1)

    releaseRuntime()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].delayMs).toBe(30_000)

    scheduled[0].run()
    expect(mockInstall).toHaveBeenCalledTimes(2)
  })

  it("backs off further on each consecutive loss and caps at five minutes", () => {
    const { scheduled, scheduleRetry } = makeScheduler()
    render(<ConnectorBusProvider scheduleRetry={scheduleRetry} />)

    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      releaseRuntime(i)
      const next = scheduled.shift()
      if (!next) throw new Error("expected a scheduled retry")
      delays.push(next.delayMs)
      next.run()
    }
    // A brain-owned deployment loses this race forever; hammering it would be
    // pure waste, so the ladder settles rather than growing without bound.
    expect(delays).toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000])
  })

  it("abandons the retry when a remote host is activated in the meantime", () => {
    // An activated remote host means we are MEANT to have no runtime; racing
    // for the lease there would double-dial the bots.
    const { scheduled, scheduleRetry } = makeScheduler()
    render(<ConnectorBusProvider scheduleRetry={scheduleRetry} />)
    releaseRuntime()

    setActiveRemoteTransport(fakeRemote)
    const pending = scheduled[0]
    pending?.run()
    expect(mockInstall).toHaveBeenCalledTimes(1)
  })

  it("cancels a pending retry when a remote host activates before it fires", () => {
    const { scheduled, scheduleRetry } = makeScheduler()
    render(<ConnectorBusProvider scheduleRetry={scheduleRetry} />)
    releaseRuntime()
    expect(scheduled).toHaveLength(1)

    setActiveRemoteTransport(fakeRemote)
    expect(scheduled).toHaveLength(0)
  })

  it("restarts the ladder when routing returns to local", () => {
    const { scheduled, scheduleRetry } = makeScheduler()
    render(<ConnectorBusProvider scheduleRetry={scheduleRetry} />)
    releaseRuntime(0)
    scheduled.shift()?.run()
    releaseRuntime(1)
    expect(scheduled.shift()?.delayMs).toBe(60_000)

    setActiveRemoteTransport(fakeRemote)
    setActiveRemoteTransport(null)

    releaseRuntime(mockInstall.mock.calls.length - 1)
    expect(scheduled.shift()?.delayMs).toBe(30_000)
  })

  it("cancels a pending retry on unmount", () => {
    const { scheduled, scheduleRetry } = makeScheduler()
    const { unmount } = render(<ConnectorBusProvider scheduleRetry={scheduleRetry} />)
    releaseRuntime()
    expect(scheduled).toHaveLength(1)

    unmount()
    expect(scheduled).toHaveLength(0)
  })
})
