import { render } from "@testing-library/react"

const unsubscribe = jest.fn()
const startMock = jest.fn().mockResolvedValue(unsubscribe)
jest.mock("@/lib/storage/retention", () => ({
  startStorageRetentionSweeper: (...a: unknown[]) => startMock(...a),
}))

import { StorageRetentionInitializer } from "./storage-retention-initializer"

beforeEach(() => {
  startMock.mockClear()
  unsubscribe.mockClear()
})

describe("StorageRetentionInitializer", () => {
  it("starts the sweeper once on mount and renders nothing", () => {
    const { container, rerender } = render(<StorageRetentionInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(startMock).toHaveBeenCalledTimes(1)
    rerender(<StorageRetentionInitializer />)
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<StorageRetentionInitializer />)
    // Let the start promise resolve so the unsubscribe handle is captured.
    await Promise.resolve()
    await Promise.resolve()
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
