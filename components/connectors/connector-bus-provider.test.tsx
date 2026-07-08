/**
 * @jest-environment jsdom
 *
 * ConnectorBusProvider — thin React host over the shared installer.
 *
 * The full boot-sequence behaviour is covered by
 * `lib/connectors/bootstrap/install-connector-runtime.test.ts`; this suite
 * only asserts the React lifecycle binding: install on mount, dispose on
 * unmount, children rendered.
 */

import { render } from "@testing-library/react"
import { ConnectorBusProvider } from "./connector-bus-provider"
import { installConnectorRuntime } from "@/lib/connectors/bootstrap/install-connector-runtime"

const mockDispose = jest.fn()
jest.mock("@/lib/connectors/bootstrap/install-connector-runtime", () => ({
  installConnectorRuntime: jest.fn(() => mockDispose),
}))
const mockInstall = installConnectorRuntime as jest.MockedFunction<typeof installConnectorRuntime>

beforeEach(() => {
  jest.clearAllMocks()
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
})
