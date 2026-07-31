import { render, waitFor } from "@testing-library/react"

const requestMock = jest.fn().mockResolvedValue("persisted")
jest.mock("@/lib/storage/persistence-request", () => ({
  requestPersistentStorage: (...a: unknown[]) => requestMock(...a),
}))

const getHealthMock = jest.fn()
jest.mock("@/lib/storage/storage-manager", () => ({
  StorageManager: { getHealth: (...a: unknown[]) => getHealthMock(...a) },
}))

const toastWarning = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    warning: (...a: unknown[]) => toastWarning(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

import { StoragePersistenceInitializer } from "./storage-persistence-initializer"

beforeEach(() => {
  requestMock.mockClear()
  getHealthMock.mockReset()
  toastWarning.mockClear()
  toastError.mockClear()
})

describe("StoragePersistenceInitializer", () => {
  it("requests persistent storage once on mount and renders nothing", async () => {
    getHealthMock.mockResolvedValue({ status: "healthy", usagePercent: 10 })
    const { container, rerender } = render(<StoragePersistenceInitializer />)
    expect(container).toBeEmptyDOMElement()
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1))
    rerender(<StoragePersistenceInitializer />)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it("does not toast when storage health is healthy", async () => {
    getHealthMock.mockResolvedValue({ status: "healthy", usagePercent: 12 })
    render(<StoragePersistenceInitializer />)
    await waitFor(() => expect(getHealthMock).toHaveBeenCalled())
    expect(toastWarning).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it("warns on a warning-level pressure status", async () => {
    getHealthMock.mockResolvedValue({ status: "warning", usagePercent: 80 })
    render(<StoragePersistenceInitializer />)
    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1))
    expect(String(toastWarning.mock.calls[0][0])).toContain("80")
    expect(toastError).not.toHaveBeenCalled()
  })

  it("errors on a critical-level pressure status", async () => {
    getHealthMock.mockResolvedValue({ status: "critical", usagePercent: 95 })
    render(<StoragePersistenceInitializer />)
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it("swallows a failing health probe without throwing", async () => {
    getHealthMock.mockRejectedValue(new Error("estimate unavailable"))
    render(<StoragePersistenceInitializer />)
    await waitFor(() => expect(requestMock).toHaveBeenCalled())
    expect(toastWarning).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })
})
