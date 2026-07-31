/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { StorageCleanupSheet } from "./storage-cleanup-sheet"
import type { CleanupResult } from "@/lib/storage"

const result: CleanupResult = { freedSpace: 2048, deletedItems: 3, details: [], errors: [] }
const quick = jest.fn(async () => result)
const deep = jest.fn(async () => result)
const cleanup = { quick, deep, isRunning: false }
jest.mock("@/hooks/storage/use-storage-cleanup", () => ({
  useStorageCleanup: () => cleanup,
}))

// Avoid pulling the Dexie-backed storage index; only formatBytes is needed.
jest.mock("@/lib/storage", () => ({
  StorageManager: { formatBytes: (b: number) => `${b}B` },
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}))

beforeEach(() => {
  quick.mockClear().mockResolvedValue(result)
  deep.mockClear().mockResolvedValue(result)
  cleanup.isRunning = false
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("<StorageCleanupSheet />", () => {
  it("runs a quick clean, toasts freed space, notifies and closes", async () => {
    const onOpenChange = jest.fn()
    const onCleaned = jest.fn()
    const user = userEvent.setup()
    render(<StorageCleanupSheet open onOpenChange={onOpenChange} onCleaned={onCleaned} />)
    await user.click(screen.getByTestId("storage-cleanup-quick"))
    await waitFor(() => expect(quick).toHaveBeenCalled())
    expect(deep).not.toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalled()
    expect(onCleaned).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("runs a deep clean", async () => {
    const user = userEvent.setup()
    render(<StorageCleanupSheet open onOpenChange={jest.fn()} />)
    await user.click(screen.getByTestId("storage-cleanup-deep"))
    await waitFor(() => expect(deep).toHaveBeenCalled())
    expect(quick).not.toHaveBeenCalled()
  })

  it("disables both options while a cleanup is running", () => {
    cleanup.isRunning = true
    render(<StorageCleanupSheet open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("storage-cleanup-quick")).toBeDisabled()
    expect(screen.getByTestId("storage-cleanup-deep")).toBeDisabled()
  })

  it("toasts an error when cleanup throws", async () => {
    quick.mockRejectedValue(new Error("boom"))
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(<StorageCleanupSheet open onOpenChange={onOpenChange} />)
    await user.click(screen.getByTestId("storage-cleanup-quick"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
