/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { StorageUsageCard, type StorageUsageCardProps } from "./storage-usage-card"
import type { StorageHealth, StorageStats } from "@/lib/storage"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

const MB = 1024 * 1024

function makeStats(): StorageStats {
  return {
    total: { used: 10 * MB, quota: 100 * MB, usagePercent: 10 },
    byCategory: [
      { category: "chat", displayName: "Messages", itemCount: 5, totalSize: 6 * MB, sources: [] },
      { category: "skill", displayName: "Skills", itemCount: 2, totalSize: 4 * MB, sources: [] },
      { category: "vector", displayName: "Vectors", itemCount: 0, totalSize: 0, sources: [] },
    ],
    localStorage: { used: 0 },
    indexedDB: { used: 10 * MB },
    generatedAt: 0,
  }
}

const healthy: StorageHealth = { status: "healthy", usagePercent: 10, issues: [], recommendations: [] }

function renderCard(over: Partial<StorageUsageCardProps> = {}) {
  const props: StorageUsageCardProps = {
    usage: { totalBytes: 25 * MB, quotaBytes: 100 * MB, backupBytes: 0, backups: [] },
    stats: makeStats(),
    health: healthy,
    persisted: true,
    isLoading: false,
    refreshing: false,
    onRefresh: jest.fn(),
    onRequestPersistence: jest.fn(async () => "persisted" as const),
    ...over,
  }
  return { ...render(<StorageUsageCard {...props} />), props }
}

beforeEach(() => {
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("<StorageUsageCard />", () => {
  it("shows a skeleton until the first read lands", () => {
    renderCard({ isLoading: true, usage: null })
    expect(screen.getByTestId("storage-usage-card")).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByTestId("storage-usage-bar")).toBeNull()
  })

  it("headlines the origin estimate against the quota with a health badge", () => {
    renderCard()
    expect(screen.getByTestId("storage-used")).toHaveTextContent("25.0 MB")
    expect(screen.getByText("of 100.0 MB")).toBeInTheDocument()
    expect(screen.getByTestId("storage-percent")).toHaveTextContent("25% used")
    expect(screen.getByTestId("storage-health-badge")).toHaveTextContent("Healthy")
    const bar = screen.getByRole("progressbar")
    expect(bar).toHaveAttribute("aria-valuenow", "25")
  })

  it("splits the filled part of the bar into category segments and a legend", () => {
    renderCard()
    const chat = screen.getByTestId("storage-usage-segment-chat")
    const skill = screen.getByTestId("storage-usage-segment-skill")
    // 60% and 40% of the 25%-wide fill.
    expect(chat.style.width).toBe("15%")
    expect(skill.style.width).toBe("10%")
    expect(screen.queryByTestId("storage-usage-segment-vector")).toBeNull()
    const legend = screen.getByTestId("storage-usage-legend")
    expect(legend).toHaveTextContent("Messages")
    expect(legend).toHaveTextContent("60%")
    expect(legend).toHaveTextContent("Skills")
  })

  it("falls back to the Dexie total and drops the progressbar when the shell has no quota", () => {
    renderCard({ usage: { totalBytes: null, quotaBytes: null, backupBytes: 0, backups: [] } })
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.getByTestId("storage-used")).toHaveTextContent("10.0 MB")
    expect(screen.getByText(/This shell does not expose storage estimates/)).toBeInTheDocument()
    // Segments still draw, now filling the whole track.
    expect(screen.getByTestId("storage-usage-segment-chat").style.width).toBe("60%")
  })

  it("explains an empty device instead of drawing an empty legend", () => {
    renderCard({ stats: { ...makeStats(), byCategory: [] } })
    expect(screen.queryByTestId("storage-usage-legend")).toBeNull()
    expect(screen.getByText(/Nothing stored on this device yet/)).toBeInTheDocument()
  })

  it("shows the persisted chip without a request button", () => {
    renderCard({ persisted: true })
    expect(screen.getByTestId("storage-persisted")).toHaveAttribute("data-persisted", "true")
    expect(screen.getByText(/Protected from eviction/i)).toBeInTheDocument()
    expect(screen.queryByTestId("storage-request-persistence")).toBeNull()
  })

  it("hides the persistence chip until the probe answers", () => {
    renderCard({ persisted: null })
    expect(screen.queryByTestId("storage-persisted")).toBeNull()
  })

  it("offers the request inline when not persisted and toasts the grant", async () => {
    const onRequestPersistence = jest.fn(async () => "persisted" as const)
    renderCard({ persisted: false, onRequestPersistence })
    expect(screen.getByText(/May be evicted/i)).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByTestId("storage-request-persistence"))
    await waitFor(() => expect(onRequestPersistence).toHaveBeenCalled())
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("toasts an error when the request is denied or unsupported", async () => {
    renderCard({ persisted: false, onRequestPersistence: async () => "denied" as const })
    const user = userEvent.setup()
    await user.click(screen.getByTestId("storage-request-persistence"))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    renderCard({ persisted: false, onRequestPersistence: async () => "unsupported" as const })
    await user.click(screen.getAllByTestId("storage-request-persistence")[1]!)
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2))
  })

  it("routes refresh to the owner and spins while refreshing", () => {
    const { props } = renderCard()
    fireEvent.click(screen.getByTestId("storage-refresh"))
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    renderCard({ refreshing: true })
    const [, spinning] = screen.getAllByTestId("storage-refresh")
    expect(spinning).toBeDisabled()
    expect(spinning!.querySelector("svg")).toHaveClass("animate-spin")
  })

  it("disables every control while the owner is busy", () => {
    renderCard({ disabled: true, persisted: false })
    expect(screen.getByTestId("storage-refresh")).toBeDisabled()
    expect(screen.getByTestId("storage-request-persistence")).toBeDisabled()
  })

  it("is one grouped surface under a small-caps heading, not a desktop card", () => {
    const { container } = renderCard()
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1)
  })
})
