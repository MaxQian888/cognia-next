/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

const startMock = jest.fn()
jest.mock("@/lib/code-adoption/turn-tracker", () => ({
  startCodeAdoptionTracker: () => startMock(),
}))

import { CodeAdoptionTrackerInitializer } from "./code-adoption-tracker-initializer"

beforeEach(() => startMock.mockReset())

describe("CodeAdoptionTrackerInitializer", () => {
  it("starts the tracker once on mount", () => {
    startMock.mockReturnValue(() => {})
    render(<CodeAdoptionTrackerInitializer />)
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  it("unsubscribes on unmount via the returned cleanup", () => {
    const stop = jest.fn()
    startMock.mockReturnValue(stop)
    const { unmount } = render(<CodeAdoptionTrackerInitializer />)
    unmount()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("renders nothing", () => {
    startMock.mockReturnValue(() => {})
    const { container } = render(<CodeAdoptionTrackerInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})
