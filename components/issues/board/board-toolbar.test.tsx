/**
 * @jest-environment jsdom
 */

// The mock echoes back the key passed to `t()`, WITHOUT its namespace. So
// `useTranslations("issues.toolbar")` + `t("facet.source")` reads as
// "facet.source", and `useTranslations("issues")` + `t("priority.urgent")`
// reads as "priority.urgent". Assertions below use those exact strings.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import userEvent from "@testing-library/user-event"
import { render, screen } from "@testing-library/react"
import { EMPTY_ISSUE_FILTER } from "@/lib/issues/board-model"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssueBoardToolbar } from "./board-toolbar"

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const kind = over.kind ?? "local"
  return {
    unifiedId: `${kind}:s${seq}`,
    kind,
    sourceId: `s${seq}`,
    identifier: `MERC-${seq}`,
    title: `Issue ${seq}`,
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

type Props = React.ComponentProps<typeof IssueBoardToolbar>

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    items: [],
    filter: EMPTY_ISSUE_FILTER,
    onFilterChange: jest.fn(),
    layout: "board",
    onLayoutChange: jest.fn(),
    groupBy: "status",
    onGroupByChange: jest.fn(),
    sort: "manual",
    onSortChange: jest.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  seq = 0
})

describe("IssueBoardToolbar", () => {
  it("renders search, filter, display and the layout toggle", () => {
    render(<IssueBoardToolbar {...baseProps()} />)
    expect(screen.getByTestId("issue-toolbar-search")).toBeInTheDocument()
    expect(screen.getByTestId("issue-toolbar-filter")).toBeInTheDocument()
    expect(screen.getByTestId("issue-toolbar-display")).toBeInTheDocument()
    expect(screen.getByTestId("issue-layout-board")).toBeInTheDocument()
  })

  it("pushes the search text up as a filter change", async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<IssueBoardToolbar {...props} />)
    await user.type(screen.getByTestId("issue-toolbar-search"), "m")
    expect(props.onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ query: "m" }))
  })

  it("shows no count badge when nothing is filtered", () => {
    render(<IssueBoardToolbar {...baseProps()} />)
    expect(screen.getByTestId("issue-toolbar-filter")).toHaveTextContent(/^filter$/)
  })

  it("counts engaged facets on the trigger", () => {
    render(
      <IssueBoardToolbar
        {...baseProps({ filter: { ...EMPTY_ISSUE_FILTER, query: "x", priorities: ["high"] } })}
      />
    )
    expect(screen.getByTestId("issue-toolbar-filter")).toHaveTextContent("2")
  })

  it("switches layout through the toggle group", async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<IssueBoardToolbar {...props} />)
    await user.click(screen.getByTestId("issue-layout-list"))
    expect(props.onLayoutChange).toHaveBeenCalledWith("list")
  })

  it("toggles a priority facet from the filter menu", async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<IssueBoardToolbar {...props} />)
    await user.click(screen.getByTestId("issue-toolbar-filter"))
    await user.click(await screen.findByText("priority.urgent"))
    expect(props.onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ priorities: ["urgent"] })
    )
  })

  it("offers a label facet only for labels actually present", async () => {
    const user = userEvent.setup()
    render(<IssueBoardToolbar {...baseProps()} />)
    await user.click(screen.getByTestId("issue-toolbar-filter"))
    expect(screen.queryByText("facet.labels")).not.toBeInTheDocument()
  })

  it("lists the labels that are present, by name", async () => {
    const user = userEvent.setup()
    render(
      <IssueBoardToolbar
        {...baseProps({ items: [item({ labelIds: ["l1"] })] })}
        labelsById={
          new Map([
            [
              "l1",
              {
                id: "l1",
                scope: "issue" as const,
                name: "bug",
                sortOrder: 0,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          ])
        }
      />
    )
    await user.click(screen.getByTestId("issue-toolbar-filter"))
    expect(await screen.findByText("bug")).toBeInTheDocument()
  })

  it("hides the source facet until more than one source is present", async () => {
    const user = userEvent.setup()
    const { unmount } = render(<IssueBoardToolbar {...baseProps({ items: [item()] })} />)
    await user.click(screen.getByTestId("issue-toolbar-filter"))
    expect(screen.queryByText("facet.source")).not.toBeInTheDocument()
    unmount()

    render(<IssueBoardToolbar {...baseProps({ items: [item(), item({ kind: "github" })] })} />)
    await user.click(screen.getByTestId("issue-toolbar-filter"))
    expect(await screen.findByText("facet.source")).toBeInTheDocument()
  })

  it("offers a clear action only once something is filtered", async () => {
    const user = userEvent.setup()
    const { unmount } = render(<IssueBoardToolbar {...baseProps()} />)
    await user.click(screen.getByTestId("issue-toolbar-filter"))
    expect(screen.queryByTestId("issue-toolbar-clear-filters")).not.toBeInTheDocument()
    unmount()

    const props = baseProps({ filter: { ...EMPTY_ISSUE_FILTER, priorities: ["low"] } })
    render(<IssueBoardToolbar {...props} />)
    await user.click(screen.getByTestId("issue-toolbar-filter"))
    await user.click(await screen.findByTestId("issue-toolbar-clear-filters"))
    expect(props.onFilterChange).toHaveBeenCalledWith(EMPTY_ISSUE_FILTER)
  })

  it("changes grouping from the display menu", async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<IssueBoardToolbar {...props} />)
    await user.click(screen.getByTestId("issue-toolbar-display"))
    await user.click(await screen.findByText("groupBy.priority"))
    expect(props.onGroupByChange).toHaveBeenCalledWith("priority")
  })

  it("changes sorting from the display menu", async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<IssueBoardToolbar {...props} />)
    await user.click(screen.getByTestId("issue-toolbar-display"))
    await user.click(await screen.findByText("sort.updated"))
    expect(props.onSortChange).toHaveBeenCalledWith("updated")
  })
})
