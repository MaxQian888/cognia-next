/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { StorageOverview } from "./storage-overview"
import type { StorageOverview as Overview } from "@/hooks/storage/use-storage-overview"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/components/mobile/me/storage-cleanup-sheet", () => ({
  StorageCleanupSheet: ({ open, onCleaned }: { open: boolean; onCleaned?: () => void }) =>
    open ? (
      <div data-testid="cleanup-sheet-stub">
        <button type="button" onClick={onCleaned} data-testid="cleanup-sheet-done" />
      </div>
    ) : null,
}))

const MB = 1024 * 1024
const overview: Overview = {
  usage: {
    totalBytes: 25 * MB,
    quotaBytes: 100 * MB,
    backupBytes: 3 * MB,
    backups: [
      {
        id: "bh_1",
        completedAt: 1_700_000_000_000,
        type: "manual",
        success: true,
        encryption: "passphrase",
        sizeBytes: 3 * MB,
        filename: "cognia.zip",
        schemaVersion: 3,
      },
    ],
  },
  stats: {
    total: { used: 10 * MB, quota: 100 * MB, usagePercent: 10 },
    byCategory: [
      { category: "chat", displayName: "Messages", itemCount: 5, totalSize: 10 * MB, sources: [] },
    ],
    localStorage: { used: 0 },
    indexedDB: { used: 10 * MB },
    generatedAt: 0,
  },
  health: { status: "healthy", usagePercent: 10, issues: [], recommendations: [] },
  persisted: true,
  isLoading: false,
  refreshing: false,
  isBusy: false,
  refresh: jest.fn(async () => {}),
  requestPersistence: jest.fn(async () => "persisted" as const),
  clearCategory: jest.fn(async () => 1),
  formatBytes: (b: number) => `${b}B`,
}
jest.mock("@/hooks/storage/use-storage-overview", () => ({
  useStorageOverview: () => overview,
}))

beforeEach(() => {
  ;(overview.refresh as jest.Mock).mockClear()
  overview.isBusy = false
})

describe("<StorageOverview />", () => {
  it("lays out hero, breakdown and manage blocks from one data source", () => {
    render(<StorageOverview />)
    expect(screen.getByTestId("storage-usage-card")).toBeInTheDocument()
    expect(screen.getByTestId("storage-breakdown-card")).toBeInTheDocument()
    expect(screen.getByTestId("storage-manage")).toBeInTheDocument()
    // The hero spans both columns of the wide grid, and the split keys on
    // the container's width rather than the viewport's.
    expect(screen.getByTestId("storage-overview")).toHaveClass("@container")
    expect(screen.getByTestId("storage-overview-grid")).toHaveClass("@2xl:grid-cols-2")
    expect(screen.getByTestId("storage-usage-card").parentElement).toHaveClass("@2xl:col-span-2")
  })

  it("links to /me/backup with the on-disk backup total instead of a second file list", () => {
    render(<StorageOverview />)
    const row = screen.getByTestId("storage-backups-row")
    expect(row).toHaveAttribute("href", "/me/backup")
    expect(row).toHaveTextContent("1 file · 3.0 MB")
    expect(screen.queryByText("cognia.zip")).toBeNull()
  })

  it("opens the cleanup sheet from the manage row and refreshes after a clean", async () => {
    render(<StorageOverview />)
    expect(screen.queryByTestId("cleanup-sheet-stub")).toBeNull()
    fireEvent.click(screen.getByTestId("storage-cleanup-cta"))
    expect(screen.getByTestId("cleanup-sheet-stub")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("cleanup-sheet-done"))
    await waitFor(() => expect(overview.refresh).toHaveBeenCalledTimes(1))
  })

  it("disables the cleanup row while busy", () => {
    overview.isBusy = true
    render(<StorageOverview />)
    // A disabled MeRow renders as a static div: no button, no link.
    expect(screen.getByTestId("storage-cleanup-cta").tagName).not.toBe("BUTTON")
  })
})
