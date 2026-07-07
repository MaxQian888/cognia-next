/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import type { ProviderLimits } from "@/types/subscription"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockSnapshots: ProviderLimits[]
const mockRefresh = jest.fn()
jest.mock("@/lib/subscription/limits/hooks", () => ({
  useAllConfiguredLimits: () => ({
    snapshots: mockSnapshots,
    refreshing: false,
    refresh: mockRefresh,
  }),
}))

let subChangeListener: (() => void) | null = null
const mockUnsub = jest.fn()
jest.mock("@/lib/subscription/core/subscription-events", () => ({
  subscribeSubscriptionChanged: (cb: () => void) => {
    subChangeListener = cb
    return mockUnsub
  },
}))

jest.mock("@/components/settings/subscription/limits-meters-card", () => ({
  MeterRow: ({ meter }: { meter: { id: string; usedPct: number | null } }) => (
    <div data-testid={`meter-${meter.id}`}>{meter.usedPct}</div>
  ),
}))

// Inline the popover so its content is always queryable without opening it.
jest.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const mockRequestOpenSettings = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: { requestOpenSettings: jest.Mock }) => unknown) =>
    selector({ requestOpenSettings: mockRequestOpenSettings }),
}))

import { StatusBarUsage } from "./status-bar-usage"

function snap(
  meters: ProviderLimits["meters"],
  extra: Partial<ProviderLimits> = {}
): ProviderLimits {
  return { provider: "anthropic", accountId: "acc1", fetchedAt: 0, meters, ...extra }
}

beforeEach(() => {
  mockSnapshots = []
  mockRefresh.mockReset()
  mockRefresh.mockResolvedValue(undefined)
  mockRequestOpenSettings.mockClear()
  mockUnsub.mockClear()
  subChangeListener = null
})

describe("StatusBarUsage", () => {
  it("returns null when there are no meters", () => {
    const { container } = render(<StatusBarUsage />)
    expect(container.firstChild).toBeNull()
  })

  it("refreshes on mount and subscribes to subscription changes", () => {
    render(<StatusBarUsage />)
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    act(() => subChangeListener?.())
    expect(mockRefresh).toHaveBeenCalledTimes(2)
  })

  it("unsubscribes on unmount", () => {
    const { unmount } = render(<StatusBarUsage />)
    unmount()
    expect(mockUnsub).toHaveBeenCalled()
  })

  it("shows the worst utilized meter as a percent chip", () => {
    mockSnapshots = [
      snap([
        { id: "session", kind: "window", usedPct: 40, status: "ok" },
        { id: "weekly", kind: "window", usedPct: 82, status: "warn" },
      ]),
    ]
    render(<StatusBarUsage />)
    // 82% is the worst.
    expect(screen.getByTestId("status-usage")).toHaveTextContent("82%")
  })

  it("renders a MeterRow per meter and opens subscription settings", () => {
    mockSnapshots = [
      snap([{ id: "session", kind: "window", usedPct: 40, status: "ok" }], {
        accountLabel: "Work",
      }),
    ]
    render(<StatusBarUsage />)
    expect(screen.getByTestId("meter-session")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("status-usage-open"))
    expect(mockRequestOpenSettings).toHaveBeenCalledWith("subscription")
  })

  it("keeps the first meter when it already is the worst, and falls back accountId to provider", () => {
    // Descending order → the reduce comparator's else-branch keeps `a`.
    // No accountId → MeterRow.accountId falls back to the provider string.
    mockSnapshots = [
      snap(
        [
          { id: "weekly", kind: "window", usedPct: 82, status: "warn" },
          { id: "session", kind: "window", usedPct: 40, status: "ok" },
        ],
        { accountId: undefined }
      ),
    ]
    render(<StatusBarUsage />)
    expect(screen.getByTestId("status-usage")).toHaveTextContent("82%")
    expect(screen.getByTestId("meter-weekly")).toBeInTheDocument()
  })

  it("renders the chip without a percent when no meter has usedPct", () => {
    mockSnapshots = [
      snap([{ id: "credit", kind: "balance", usedPct: null, status: "ok", remaining: 5 }]),
    ]
    render(<StatusBarUsage />)
    const chip = screen.getByTestId("status-usage")
    expect(chip).toBeInTheDocument()
    expect(chip).not.toHaveTextContent("%")
  })
})
