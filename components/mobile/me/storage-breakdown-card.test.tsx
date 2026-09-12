/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { StorageBreakdownCard, type StorageBreakdownCardProps } from "./storage-breakdown-card"
import type { StorageHealth, StorageStats } from "@/lib/storage"

// next-intl is mocked globally in jest.setup (loads real en messages), so
// category labels resolve through settings.data.breakdown.categories.*.

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}))

function makeStats(overrides: Partial<StorageStats> = {}): StorageStats {
  return {
    total: { used: 1000, quota: 10000, usagePercent: 10 },
    byCategory: [
      { category: "skill", displayName: "Skills", itemCount: 2, totalSize: 400, sources: [] },
      { category: "chat", displayName: "Messages", itemCount: 5, totalSize: 600, sources: [] },
      { category: "vector", displayName: "Vector store", itemCount: 0, totalSize: 0, sources: [] },
    ],
    localStorage: { used: 0 },
    indexedDB: { used: 1000 },
    generatedAt: 0,
    ...overrides,
  }
}

const healthy: StorageHealth = { status: "healthy", usagePercent: 10, issues: [], recommendations: [] }

function renderCard(over: Partial<StorageBreakdownCardProps> = {}) {
  const props: StorageBreakdownCardProps = {
    stats: makeStats(),
    health: healthy,
    isLoading: false,
    formatBytes: (b: number) => `${b}B`,
    onClearCategory: jest.fn(async () => 5),
    ...over,
  }
  return { ...render(<StorageBreakdownCard {...props} />), props }
}

beforeEach(() => {
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("<StorageBreakdownCard />", () => {
  it("shows a skeleton while the initial fetch is in flight", () => {
    renderCard({ isLoading: true, stats: null })
    expect(screen.getByTestId("storage-breakdown-card")).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByTestId("storage-category-chat")).toBeNull()
  })

  it("renders non-empty categories largest first, with count, size and share", () => {
    renderCard()
    const rows = screen.getAllByTestId(/^storage-category-/)
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "storage-category-chat",
      "storage-category-skill",
    ])
    expect(screen.queryByTestId("storage-category-vector")).toBeNull()
    const chat = screen.getByTestId("storage-category-chat")
    expect(chat).toHaveTextContent("Messages")
    expect(chat).toHaveTextContent("5 items · 600B")
    expect(screen.getByTestId("storage-share-chat")).toHaveTextContent("60%")
    expect(screen.getByTestId("storage-share-skill")).toHaveTextContent("40%")
  })

  it("summarises the category count and used total in the heading", () => {
    renderCard()
    expect(screen.getByText("2 categories · 1000B")).toBeInTheDocument()
  })

  it("renders the empty copy with the health hint when nothing is stored", () => {
    renderCard({ stats: makeStats({ byCategory: [] }) })
    expect(screen.getByText(/Nothing stored yet/)).toBeInTheDocument()
    expect(screen.getByText(/10% of your quota used/)).toBeInTheDocument()
  })

  it("confirms before clearing, then reports the cleared count", async () => {
    const onClearCategory = jest.fn(async () => 5)
    renderCard({ onClearCategory })
    const user = userEvent.setup()
    await user.click(screen.getByTestId("storage-clear-chat"))
    expect(onClearCategory).not.toHaveBeenCalled()
    await user.click(await screen.findByTestId("storage-clear-confirm"))
    await waitFor(() => expect(onClearCategory).toHaveBeenCalledWith("chat"))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("5 rows cleared."))
  })

  it("cancelling the dialog clears nothing", async () => {
    const onClearCategory = jest.fn(async () => 0)
    renderCard({ onClearCategory })
    const user = userEvent.setup()
    await user.click(screen.getByTestId("storage-clear-skill"))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(onClearCategory).not.toHaveBeenCalled()
  })

  it("surfaces a clear failure as an error toast", async () => {
    renderCard({ onClearCategory: async () => { throw new Error("locked") } })
    const user = userEvent.setup()
    await user.click(screen.getByTestId("storage-clear-chat"))
    await user.click(await screen.findByTestId("storage-clear-confirm"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("locked"))
  })

  it("disables the clear buttons while the owner is busy", () => {
    renderCard({ disabled: true })
    expect(screen.getByTestId("storage-clear-chat")).toBeDisabled()
    expect(screen.getByTestId("storage-clear-skill")).toBeDisabled()
  })
})
