/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}))

import {
  ConversationListEmptyState,
  ConversationNarrowedEmptyState,
} from "./conversation-list-empty-state"

describe("ConversationListEmptyState", () => {
  it("offers a new chat when the list is empty", () => {
    const onCreate = jest.fn()
    render(<ConversationListEmptyState archived={false} team={false} onCreate={onCreate} />)
    expect(screen.getByText("desktop.channelList.emptyDm")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /desktop.channelList.newChat/ }))
    expect(onCreate).toHaveBeenCalled()
  })

  it("words a team's empty list as a team conversation", () => {
    render(<ConversationListEmptyState archived={false} team onCreate={jest.fn()} />)
    expect(screen.getByText("desktop.channelList.emptyTeam")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /desktop.channelList.newConversation/ })
    ).toBeInTheDocument()
  })

  it("names the empty archive and leads back to the active list", () => {
    const onShowActive = jest.fn()
    render(<ConversationListEmptyState archived team={false} onShowActive={onShowActive} />)
    expect(screen.getByText("desktop.channelList.emptyArchivedTitle")).toBeInTheDocument()
    expect(screen.getByText("desktop.channelList.emptyArchivedHint")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("channel-list-empty-show-active"))
    expect(onShowActive).toHaveBeenCalled()
  })

  it("draws no action without a handler and takes the host's sizing", () => {
    render(<ConversationListEmptyState archived team={false} className="flex-1" />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByTestId("channel-list-empty-state")).toHaveClass("flex-1")
  })
})

describe("ConversationNarrowedEmptyState", () => {
  const base = {
    onClearFilters: jest.fn(),
    onClearSearch: jest.fn(),
    onSearchEverywhere: jest.fn(),
    onWiden: jest.fn(),
  }

  beforeEach(() => jest.clearAllMocks())

  it("offers every way out of a search that found nothing", () => {
    render(
      <ConversationNarrowedEmptyState
        {...base}
        query="deploy"
        activeFilters={1}
        widenings={[
          { key: "content", patch: { content: true } },
          { key: "archived", patch: { includeArchived: true } },
          { key: "workspaces", patch: { workspace: "all" } },
        ]}
      />
    )
    expect(
      screen.getByText('desktop.channelList.emptySearch:{"query":"deploy"}')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("channel-list-empty-widen-archived"))
    expect(base.onWiden).toHaveBeenCalledWith({ includeArchived: true })
    fireEvent.click(screen.getByTestId("channel-list-empty-search-everywhere"))
    expect(base.onSearchEverywhere).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("channel-list-empty-clear-filters"))
    expect(base.onClearFilters).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("channel-list-empty-clear-search"))
    expect(base.onClearSearch).toHaveBeenCalled()
  })

  it("offers only clearing the filters when no search is running", () => {
    render(<ConversationNarrowedEmptyState {...base} query="" activeFilters={2} widenings={[]} />)
    expect(screen.getByText('desktop.channelList.emptyFiltered:{"count":2}')).toBeInTheDocument()
    expect(screen.queryByTestId("channel-list-empty-search-everywhere")).toBeNull()
    expect(screen.queryByTestId("channel-list-empty-clear-search")).toBeNull()
    expect(screen.getByTestId("channel-list-empty-clear-filters")).toBeInTheDocument()
  })
})
