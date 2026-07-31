/**
 * @jest-environment jsdom
 */

import { StrictMode } from "react"
import { render } from "@testing-library/react"

const sinkMock = jest.fn()
jest.mock("@/hooks/fleet/use-fleet-history-sink", () => ({
  useFleetHistorySink: () => sinkMock(),
}))

const restoreMock = jest.fn()
const islandRestoreMock = jest.fn()
jest.mock("@/lib/tauri/fleet", () => ({
  fleetMonitorRestore: () => restoreMock(),
  islandRestore: () => islandRestoreMock(),
}))

import { FleetHistorySinkInitializer } from "./fleet-history-sink-initializer"

beforeEach(() => {
  sinkMock.mockReset()
  restoreMock.mockReset()
  islandRestoreMock.mockReset()
  restoreMock.mockResolvedValue({ enabled: false, port: null, configPath: null })
  islandRestoreMock.mockResolvedValue(false)
})

describe("FleetHistorySinkInitializer", () => {
  it("restores the monitor once and runs the history sink", () => {
    const { rerender } = render(<FleetHistorySinkInitializer />)
    expect(restoreMock).toHaveBeenCalledTimes(1)
    expect(sinkMock).toHaveBeenCalled()
    // Re-render must not re-trigger the boot restore.
    rerender(<FleetHistorySinkInitializer />)
    expect(restoreMock).toHaveBeenCalledTimes(1)
  })

  it("restores the island overlay after the monitor is back up", async () => {
    // Ordering matters: the island's first snapshot should come from a live
    // ingress rather than an empty one it then has to backfill.
    render(<FleetHistorySinkInitializer />)
    await Promise.resolve()
    await Promise.resolve()
    expect(islandRestoreMock).toHaveBeenCalledTimes(1)
    expect(restoreMock.mock.invocationCallOrder[0]).toBeLessThan(
      islandRestoreMock.mock.invocationCallOrder[0]
    )
  })

  it("renders nothing", () => {
    const { container } = render(<FleetHistorySinkInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("restores exactly once under StrictMode double-invoke", () => {
    // StrictMode runs the effect twice; the ref guard must suppress the second
    // restore so a remount can't mint a redundant token.
    render(
      <StrictMode>
        <FleetHistorySinkInitializer />
      </StrictMode>
    )
    expect(restoreMock).toHaveBeenCalledTimes(1)
  })
})
