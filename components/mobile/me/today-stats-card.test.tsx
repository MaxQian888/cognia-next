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
    }
    return map[key] ?? key
  },
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
jest.mock("@/lib/db/backup-history", () => ({
  getLatestSuccessful: () => getLatestSuccessfulMock(),
}))

beforeEach(() => {
  listSessionsMock.mockReset().mockResolvedValue([])
  draftsCountMock.mockReset().mockResolvedValue(0)
  getLatestSuccessfulMock.mockReset().mockResolvedValue(undefined)
})

describe("<TodayStatsCard />", () => {
  it("renders three tiles linked to the right routes", async () => {
    render(
      <TodayStatsCard
        loaders={{
          sessionCount: async () => 12,
          pendingDrafts: async () => 3,
          lastBackupMs: async () => Date.now() - 2 * 3_600_000,
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("stat-tile-sessions")).toHaveTextContent("12")
    })
    expect(screen.getByTestId("stat-tile-drafts")).toHaveTextContent("3")
    expect(screen.getByTestId("stat-tile-backup")).toHaveTextContent(/2h/)
    expect(screen.getByTestId("stat-tile-sessions")).toHaveAttribute("href", "/")
    expect(screen.getByTestId("stat-tile-drafts")).toHaveAttribute(
      "href",
      "/discover?tab=twinDrafts"
    )
    expect(screen.getByTestId("stat-tile-backup")).toHaveAttribute("href", "/settings?section=data")
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
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("stat-tile-sessions")).toHaveTextContent("0")
    })
    expect(screen.getByTestId("stat-tile-drafts")).toHaveTextContent("0")
    expect(screen.getByTestId("stat-tile-backup")).toHaveTextContent("Never")
  })
})
