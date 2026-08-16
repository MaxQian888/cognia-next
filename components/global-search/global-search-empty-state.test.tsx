/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Command } from "cmdk"

import { recordRecentItem, recordRecentQuery } from "@/lib/global-search/recents"
import type { GlobalSearchGroup } from "@/lib/global-search/types"

import { GlobalSearchEmptyState } from "./global-search-empty-state"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({
    relativeTime: () => "rel",
    dateTime: () => "abs",
  }),
  useNow: () => new Date(1_750_000_000_000),
}))

const suggestions: GlobalSearchGroup[] = [
  {
    kind: "action",
    providerId: "a",
    items: [
      {
        id: "action:new",
        kind: "action",
        title: "New chat",
        score: 1,
        action: { type: "command", id: "new-chat" },
      },
    ],
    bestScore: 1,
    total: 1,
    truncated: false,
    coverage: "complete",
  },
  {
    kind: "session",
    providerId: "s",
    items: [
      {
        id: "session:1",
        kind: "session",
        title: "Recent chat",
        score: 1,
        action: { type: "open-session", sessionId: "1" },
      },
    ],
    bestScore: 1,
    total: 1,
    truncated: false,
    coverage: "complete",
  },
]

function renderEmpty(props: Partial<React.ComponentProps<typeof GlobalSearchEmptyState>> = {}) {
  const handlers = {
    onPickQuery: jest.fn(),
    onPickRecent: jest.fn(),
    onSelect: jest.fn(),
  }
  render(
    <Command shouldFilter={false}>
      <Command.List>
        <GlobalSearchEmptyState suggestions={suggestions} {...handlers} {...props} />
      </Command.List>
    </Command>
  )
  return handlers
}

describe("GlobalSearchEmptyState", () => {
  beforeEach(() => window.localStorage.clear())

  it("renders suggestions only when there are no recents", () => {
    const { onSelect } = renderEmpty()
    expect(screen.queryByTestId("global-search-recent-queries")).toBeNull()
    expect(screen.queryByTestId("global-search-recent-items")).toBeNull()
    expect(screen.getByText("kinds.action")).toBeInTheDocument()
    expect(screen.getByText("Recent chat")).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("renders recent queries and items with pick / remove / clear", async () => {
    const user = userEvent.setup()
    recordRecentQuery("deploy")
    recordRecentQuery("notes")
    recordRecentItem({
      id: "workflow:w1",
      kind: "workflow",
      title: "Release",
      subtitle: "weekly",
      score: 1,
      action: { type: "navigate", href: "/w" },
    })
    const { onPickQuery, onPickRecent, onSelect } = renderEmpty()
    expect(screen.getByTestId("global-search-recent-queries")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /^deploy$/ }))
    expect(onPickQuery).toHaveBeenCalledWith("deploy")
    await user.click(screen.getByRole("button", { name: "recents.remove: notes" }))
    expect(screen.queryByText("notes")).toBeNull()

    expect(screen.getByText("Release")).toBeInTheDocument()
    expect(screen.getByText("weekly")).toBeInTheDocument()
    expect(screen.getByText("kinds.workflow")).toBeInTheDocument()
    await user.click(screen.getByText("Release"))
    expect(onPickRecent).toHaveBeenCalledWith(expect.objectContaining({ id: "workflow:w1" }))
    await user.click(screen.getByRole("button", { name: "recents.remove: Release" }))
    expect(screen.queryByText("Release")).toBeNull()
    // Removing the item must not select it.
    expect(onPickRecent).toHaveBeenCalledTimes(1)

    await user.click(screen.getByText("New chat"))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "action:new" }))

    await user.click(screen.getByRole("button", { name: "recents.clear" }))
    expect(screen.queryByTestId("global-search-recent-queries")).toBeNull()
  })
})
