/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

import { TodayStatsCard } from "./today-stats-card"

jest.mock("next/link", () => {
  const Link = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  return { __esModule: true, default: Link }
})

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      sessions: "Chats",
      drafts: "Drafts",
      backup: "Last backup",
      backupNever: "Never",
      backupStale: "Overdue",
      backupFailed: "Last backup failed",
      storage: "Storage",
    }
    return map[key] ?? key
  },
}))

jest.mock("@/lib/storage/usage", () => ({
  getStorageUsage: jest.fn(async () => ({
    totalBytes: 1024,
    quotaBytes: null,
    backupBytes: null,
    backups: [],
  })),
  formatBytes: (b: number | null | undefined) =>
    b === null || b === undefined ? "—" : `${b}B`,
}))

const listSessionsMock = jest.fn(() => Promise.resolve([]) as Promise<unknown[]>)
jest.mock("@/lib/db/sessions", () => ({
  listSessions: () => listSessionsMock(),
}))

const draftsCountMock = jest.fn(() => Promise.resolve(0))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    twinDrafts: {
      where: () => ({ equals: () => ({ count: () => draftsCountMock() }) }),
    },
  }),
}))

const getLatestSuccessfulMock = jest.fn(
  () => Promise.resolve(undefined) as Promise<{ completedAt: number } | undefined>
)
const listBackupHistoryMock = jest.fn(
  () => Promise.resolve([]) as Promise<Array<{ success: boolean; completedAt: number }>>
)
jest.mock("@/lib/db/backup-history", () => ({
  getLatestSuccessful: () => getLatestSuccessfulMock(),
  listBackupHistory: (...a: unknown[]) => listBackupHistoryMock(...(a as [])),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: { backupReminderDays: 7 } }) },
}))

beforeEach(() => {
  listSessionsMock.mockReset().mockResolvedValue([])
  draftsCountMock.mockReset().mockResolvedValue(0)
  getLatestSuccessfulMock.mockReset().mockResolvedValue(undefined)
  listBackupHistoryMock.mockReset().mockResolvedValue([])
})

describe("<TodayStatsCard />", () => {
  it("renders four tiles linked to the right routes", async () => {
    render(
      <TodayStatsCard
        loaders={{
          sessionCount: async () => 12,
          pendingDrafts: async () => 3,
          lastBackupMs: async () => Date.now() - 2 * 3_600_000,
          storageBytes: async () => 2048,
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("stat-tile-sessions")).toHaveTextContent("12")
    })
    expect(screen.getByTestId("stat-tile-drafts")).toHaveTextContent("3")
    expect(screen.getByTestId("stat-tile-backup")).toHaveTextContent(/2h/)
    expect(screen.getByTestId("stat-tile-storage")).toHaveTextContent("2048B")
    expect(screen.getByTestId("stat-tile-sessions")).toHaveAttribute("href", "/")
    expect(screen.getByTestId("stat-tile-drafts")).toHaveAttribute(
      "href",
      "/discover?tab=twinDrafts"
    )
    // Regression: the backup tile used to dead-link to the desktop-only
    // `/settings?section=data` route, which mobile redirects away.
    expect(screen.getByTestId("stat-tile-backup")).toHaveAttribute("href", "/me/backup")
    expect(screen.getByTestId("stat-tile-storage")).toHaveAttribute("href", "/me/storage")
  })

  it('shows "Never" when no backup is recorded', async () => {
    render(
      <TodayStatsCard
        loaders={{
          sessionCount: async () => 0,
          pendingDrafts: async () => 0,
          lastBackupMs: async () => null,
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("stat-tile-backup")).toHaveTextContent("Never")
    })
  })

  it("uses the production loaders when none are passed", async () => {
    listSessionsMock.mockResolvedValueOnce([{ id: "s1" }, { id: "s2" }])
    draftsCountMock.mockResolvedValueOnce(5)
    getLatestSuccessfulMock.mockResolvedValueOnce({ completedAt: Date.now() - 30_000 })
    render(<TodayStatsCard />)
    await waitFor(() => {
      expect(screen.getByTestId("stat-tile-sessions")).toHaveTextContent("2")
    })
    expect(screen.getByTestId("stat-tile-drafts")).toHaveTextContent("5")
    expect(screen.getByTestId("stat-tile-backup")).toHaveTextContent(/now|m|h|d/)
  })

  it.each([
    ["now", 5_000, /now/],
    ["minutes", 90_000, /\b2m/],
    ["hours", 90 * 60 * 1000, /\b2h/],
    ["days", 5 * 86_400_000, /\b5d/],
  ])("formats %s for the backup tile", async (_label, ageMs, re) => {
    render(
      <TodayStatsCard
        loaders={{
          sessionCount: async () => 0,
          pendingDrafts: async () => 0,
          lastBackupMs: async () => Date.now() - ageMs,
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("stat-tile-backup")).toHaveTextContent(re)
    })
  })

  it("flags a failed last backup attempt in red while keeping the last-success time", async () => {
    render(
      <TodayStatsCard
        loaders={{
          sessionCount: async () => 0,
          pendingDrafts: async () => 0,
          backupHealth: async () => ({
            status: "failed",
            lastSuccessAt: Date.now() - 2 * 3_600_000,
          }),
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("stat-tile-backup")).toHaveAttribute("data-status", "failed")
    })
    const tile = screen.getByTestId("stat-tile-backup")
    expect(tile).toHaveTextContent(/2h/)
    expect(tile).toHaveTextContent("Last backup failed")
    expect(tile.querySelector(".text-destructive")).not.toBeNull()
  })

  it("flags a stale backup in amber", async () => {
    render(
      <TodayStatsCard
        loaders={{
          sessionCount: async () => 0,
          pendingDrafts: async () => 0,
          backupHealth: async () => ({
            status: "stale",
            lastSuccessAt: Date.now() - 10 * 86_400_000,
          }),
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("stat-tile-backup")).toHaveAttribute("data-status", "stale")
    })
    const tile = screen.getByTestId("stat-tile-backup")
    expect(tile).toHaveTextContent(/10d/)
    expect(tile.querySelector(".text-amber-600")).not.toBeNull()
  })

  it("leaves a healthy backup tile neutral (no accent)", async () => {
    render(
      <TodayStatsCard
        loaders={{
          sessionCount: async () => 0,
          pendingDrafts: async () => 0,
          backupHealth: async () => ({ status: "ok", lastSuccessAt: Date.now() - 60_000 }),
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("stat-tile-backup")).toHaveAttribute("data-status", "ok")
    })
    const tile = screen.getByTestId("stat-tile-backup")
    expect(tile.querySelector(".text-destructive")).toBeNull()
    expect(tile.querySelector(".text-amber-600")).toBeNull()
  })

  it("shows zeros when loaders reject", async () => {
    render(
      <TodayStatsCard
        loaders={{
          sessionCount: async () => {
            throw new Error("boom")
          },
          pendingDrafts: async () => {
            throw new Error("boom")
          },
          lastBackupMs: async () => {
            throw new Error("boom")
          },
          storageBytes: async () => {
            throw new Error("boom")
          },
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("stat-tile-sessions")).toHaveTextContent("0")
    })
    expect(screen.getByTestId("stat-tile-drafts")).toHaveTextContent("0")
    expect(screen.getByTestId("stat-tile-backup")).toHaveTextContent("Never")
    expect(screen.getByTestId("stat-tile-storage")).toHaveTextContent("—")
  })
})
