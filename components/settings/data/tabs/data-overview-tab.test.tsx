/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { DataOverviewTab } from "./data-overview-tab"

let mockSnapshot: unknown = null
jest.mock("@/lib/storage/retention", () => ({ getStorageRetentionSnapshot: () => mockSnapshot }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/hooks/data/use-backup-history", () => ({
  useBackupHistory: () => [],
  useLatestSuccessfulBackup: () => null,
  clearBackupHistory: jest.fn(),
  deleteBackupHistory: jest.fn(),
}))
jest.mock("@/hooks/storage", () => ({
  useStorageBreakdown: () => ({
    stats: null,
    health: null,
    isLoading: false,
    refresh: jest.fn(),
    formatBytes: String,
  }),
  useStorageCleanup: () => ({ clearCategory: jest.fn(), isRunning: false }),
}))
jest.mock("@/components/data/shared/storage-usage-display", () => ({
  StorageUsageDisplay: () => null,
}))
jest.mock("@/components/data/import/reminder-banner", () => ({ ReminderBanner: () => null }))
jest.mock("@/components/data/storage/local-persistence-visibility-panel", () => ({
  LocalPersistenceVisibilityPanel: () => null,
}))

beforeEach(() => {
  mockSnapshot = null
})

it("shows unknown when this runtime has no sweep evidence", async () => {
  render(<DataOverviewTab />)
  expect(await screen.findByText("retentionHealth.unknown")).toBeInTheDocument()
  expect(screen.getByText("retentionHealth.title").closest("details")).not.toHaveAttribute("open")
})

it("renders failed and partial stages in passive details without error content", async () => {
  mockSnapshot = {
    completedAt: 1000,
    results: [
      {
        id: "mediaGenerationJobs",
        removed: 1,
        status: "partial",
        reason: "file-delete-failed",
        stages: [{ id: "files", removed: 0, status: "failed", reason: "prune-failed" }],
      },
    ],
  }
  render(<DataOverviewTab />)
  expect(await screen.findByText(/retentionHealth\.status\.partial/)).toBeInTheDocument()
  expect(screen.getByText(/retentionHealth\.status\.failed/)).toBeInTheDocument()
  expect(screen.getByText(/retentionHealth\.reasons\.file-delete-failed/)).toBeInTheDocument()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})
