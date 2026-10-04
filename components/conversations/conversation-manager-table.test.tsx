/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// The row is its own suite; here only what the table hands each one.
const mockRowProps = jest.fn()
jest.mock("./conversation-manager-row", () => ({
  ConversationManagerRow: (props: { session: ChatSession }) => {
    mockRowProps(props)
    return (
      <tr data-testid={`row-${props.session.id}`}>
        <td />
      </tr>
    )
  },
}))

import type { ConversationManagerTableProps } from "./conversation-manager-table"
import { ConversationManagerTable } from "./conversation-manager-table"

const session = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, title: id, kind: "direct", createdAt: 1, updatedAt: 1, ...over }) as ChatSession

function setup(over: Partial<ConversationManagerTableProps> = {}) {
  const props: ConversationManagerTableProps = {
    rows: [session("a", { projectId: "p1" }), session("b", { archivedAt: 5 })],
    totalInView: 2,
    selectedCount: 0,
    isSelected: (id) => id === "a",
    onToggleSelect: jest.fn(),
    onSelectAll: jest.fn(),
    onClearSelection: jest.fn(),
    sortBy: "recent",
    onSortBy: jest.fn(),
    decorations: { iconFor: () => undefined, accentFor: () => undefined, metadataFor: () => [] },
    workspaceNameById: new Map([["p1", "Cognia"]]),
    folders: [],
    usage: new Map(),
    runStatusById: new Map(),
    unreadCountById: new Map([
      ["a", 2],
      ["b", 4],
    ]),
    contentOnlyIds: new Set(["b"]),
    now: new Date(0),
    rowActions: {} as ConversationManagerTableProps["rowActions"],
    extraActions: {},
    onOpen: jest.fn(),
    ...over,
  }
  render(<ConversationManagerTable {...props} />)
  return props
}

beforeEach(() => mockRowProps.mockReset())

describe("ConversationManagerTable", () => {
  it("draws one row per conversation with its own facts", () => {
    setup()
    expect(screen.getByTestId("row-a")).toBeInTheDocument()
    expect(screen.getByTestId("row-b")).toBeInTheDocument()
    const [a, b] = mockRowProps.mock.calls.map(([props]) => props)
    expect(a).toMatchObject({
      selected: true,
      workspaceName: "Cognia",
      unread: 2,
      contentMatch: false,
    })
    // An archived row carries no unread state, whatever the store holds.
    expect(b).toMatchObject({
      selected: false,
      workspaceName: undefined,
      unread: 0,
      contentMatch: true,
    })
  })

  it("marks the sorted column and toggles activity between newest and oldest", () => {
    const props = setup()
    const activity = screen.getByTestId("conversation-table-sort-activity")
    expect(activity.closest("th")).toHaveAttribute("aria-sort", "descending")
    expect(screen.getByTestId("conversation-table-sort-title").closest("th")).toHaveAttribute(
      "aria-sort",
      "none"
    )
    fireEvent.click(activity)
    expect(props.onSortBy).toHaveBeenCalledWith("oldest")
    fireEvent.click(screen.getByTestId("conversation-table-sort-title"))
    expect(props.onSortBy).toHaveBeenCalledWith("title")
    fireEvent.click(screen.getByTestId("conversation-table-sort-created"))
    expect(props.onSortBy).toHaveBeenCalledWith("created")
  })

  it("reads oldest-first as an ascending activity column", () => {
    setup({ sortBy: "oldest" })
    expect(screen.getByTestId("conversation-table-sort-activity").closest("th")).toHaveAttribute(
      "aria-sort",
      "ascending"
    )
  })

  it("selects every row in the view from the header", () => {
    const props = setup()
    const all = screen.getByTestId("conversation-table-select-all")
    expect(all).toHaveAttribute("data-state", "unchecked")
    fireEvent.click(all)
    expect(props.onSelectAll).toHaveBeenCalled()
  })

  it("shows a partial selection as indeterminate", () => {
    setup({ selectedCount: 1 })
    expect(screen.getByTestId("conversation-table-select-all")).toHaveAttribute(
      "data-state",
      "indeterminate"
    )
  })

  it("clears from the header when the whole view is selected", () => {
    const props = setup({ selectedCount: 2 })
    const all = screen.getByTestId("conversation-table-select-all")
    expect(all).toHaveAttribute("data-state", "checked")
    fireEvent.click(all)
    expect(props.onClearSelection).toHaveBeenCalled()
    expect(props.onSelectAll).not.toHaveBeenCalled()
  })

  it("cannot select all from an empty view", () => {
    setup({ rows: [], totalInView: 0 })
    expect(screen.getByTestId("conversation-table-select-all")).toBeDisabled()
  })
})
