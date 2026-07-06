/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { StorageBreakdownCard } from "./storage-breakdown-card"
import type { StorageHealth, StorageStats } from "@/lib/storage"

// next-intl is mocked globally in jest.setup (loads real en messages), so
// category labels resolve through settings.data.breakdown.categories.*.

const breakdown = {
  stats: null as StorageStats | null,
  health: null as StorageHealth | null,
  isLoading: true,
  refresh: jest.fn(async () => {}),
  formatBytes: (b: number) => `${b}B`,
}
jest.mock("@/hooks/storage/use-storage-breakdown", () => ({
  useStorageBreakdown: () => breakdown,
}))

const clearCategory = jest.fn(async () => 5)
const cleanup = { clearCategory, isRunning: false }
jest.mock("@/hooks/storage/use-storage-cleanup", () => ({
  useStorageCleanup: () => cleanup,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}))

function makeStats(overrides: Partial<StorageStats> = {}): StorageStats {
  return {
    total: { used: 1000, quota: 10000, usagePercent: 10 },
    byCategory: [
      { category: "chat", displayName: "Messages", itemCount: 5, totalSize: 600, sources: [] },
      { category: "skill", displayName: "Skills", itemCount: 2, totalSize: 400, sources: [] },
      { category: "vector", displayName: "Vector store", itemCount: 0, totalSize: 0, sources: [] },
    ],
    localStorage: { used: 0 },
    indexedDB: { used: 1000 },
    generatedAt: 0,
    ...overrides,
  }
}

const healthy: StorageHealth = { status: "healthy", usagePercent: 10, issues: [], recommendations: [] }

beforeEach(() => {
  breakdown.stats = null
  breakdown.health = null
  breakdown.isLoading = true
  breakdown.refresh.mockClear()
  clearCategory.mockClear().mockResolvedValue(5)
  cleanup.isRunning = false
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("<StorageBreakdownCard />", () => {
  it("shows a skeleton while the initial fetch is in flight", () => {
    render(<StorageBreakdownCard />)
    expect(screen.getByTestId("storage-breakdown-card")).toBeInTheDocument()
    expect(screen.queryByTestId("storage-category-chat")).toBeNull()
  })

  it("renders only non-empty categories with a healthy badge", () => {
    breakdown.stats = makeStats()
    breakdown.health = healthy
    breakdown.isLoading = false
    render(<StorageBreakdownCard />)
    expect(screen.getByText("Messages")).toBeInTheDocument()
    expect(screen.getByText("Skills")).toBeInTheDocument()
    expect(screen.queryByTestId("storage-category-vector")).toBeNull()
    expect(screen.getByTestId("storage-health-badge")).toHaveTextContent("Healthy")
  })

  it("renders an empty hint when every category is zero", () => {
    breakdown.stats = makeStats({
      byCategory: [
        { category: "chat", displayName: "Messages", itemCount: 0, totalSize: 0, sources: [] },
      ],
    })
    breakdown.health = healthy
    breakdown.isLoading = false
    render(<StorageBreakdownCard />)
    expect(screen.getByText(/Nothing stored yet/i)).toBeInTheDocument()
  })

  it.each([
    ["warning", "Filling up"],
    ["critical", "Almost full"],
  ] as const)("shows the %s health badge", (status, label) => {
    breakdown.stats = makeStats()
    breakdown.health = { status, usagePercent: 92, issues: [], recommendations: [] }
    breakdown.isLoading = false
    render(<StorageBreakdownCard />)
    expect(screen.getByTestId("storage-health-badge")).toHaveTextContent(label)
  })

  it("clears a category after confirming and toasts the freed rows", async () => {
    breakdown.stats = makeStats()
    breakdown.health = healthy
    breakdown.isLoading = false
    const user = userEvent.setup()
    render(<StorageBreakdownCard />)
    await user.click(screen.getByTestId("storage-clear-chat"))
    await user.click(screen.getByTestId("storage-clear-confirm"))
    await waitFor(() => expect(clearCategory).toHaveBeenCalledWith("chat"))
    expect(breakdown.refresh).toHaveBeenCalled()
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it("hides the badge and uses the default description when health is unknown", () => {
    // total.used = 0 exercises the zero-share path; health = null hides the badge.
    breakdown.stats = makeStats({ total: { used: 0, quota: 10000, usagePercent: 0 } })
    breakdown.health = null
    breakdown.isLoading = false
    render(<StorageBreakdownCard />)
    expect(screen.queryByTestId("storage-health-badge")).toBeNull()
    expect(screen.getByText("Messages")).toBeInTheDocument()
  })

  it("cancelling the confirm dialog does not clear the category", async () => {
    breakdown.stats = makeStats()
    breakdown.health = healthy
    breakdown.isLoading = false
    const user = userEvent.setup()
    render(<StorageBreakdownCard />)
    await user.click(screen.getByTestId("storage-clear-skill"))
    await user.click(screen.getByText("Cancel"))
    await waitFor(() => expect(screen.queryByTestId("storage-clear-confirm")).toBeNull())
    expect(clearCategory).not.toHaveBeenCalled()
  })

  it("refreshes on demand", async () => {
    breakdown.stats = makeStats()
    breakdown.health = healthy
    breakdown.isLoading = false
    const user = userEvent.setup()
    render(<StorageBreakdownCard />)
    await user.click(screen.getByTestId("storage-breakdown-refresh"))
    expect(breakdown.refresh).toHaveBeenCalled()
  })
})
