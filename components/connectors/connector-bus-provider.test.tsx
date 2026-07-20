/**
 * @jest-environment jsdom
 *
 * ConnectorBusProvider — thin React host over the shared installer.
 *
 * The full boot-sequence behaviour is covered by
 * `lib/connectors/bootstrap/install-connector-runtime.test.ts`; this suite
 * asserts the React lifecycle binding (install on mount, dispose on unmount,
 * children rendered) plus the ADR-0082 remote-host guard: while driving a
 * remote Cognia host the local runtime is deferred so bots are not double-dialed.
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
    // row filter) — passing options here would fork desktop behaviour.
    expect(mockInstall).toHaveBeenCalledWith()
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
