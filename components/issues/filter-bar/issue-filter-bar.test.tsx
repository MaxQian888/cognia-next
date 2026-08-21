/** @jest-environment jsdom */

// The mock echoes the key WITHOUT its namespace, so `useTranslations("issues.toolbar")`
// + `t("facet.source")` reads as "facet.source".
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import userEvent from "@testing-library/user-event"
import { render, screen } from "@testing-library/react"
import { EMPTY_ISSUE_FILTER } from "@/lib/issues/board-model"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssueFilterBar } from "./issue-filter-bar"

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

type Props = React.ComponentProps<typeof IssueFilterBar>

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
    density: "comfortable",
    onDensityChange: jest.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  seq = 0
})

describe("IssueFilterBar", () => {
  it("renders search, filter, display and the layout toggle", () => {
    render(<IssueFilterBar {...baseProps()} />)
    expect(screen.getByTestId("issue-toolbar-search")).toBeInTheDocument()
    expect(screen.getByTestId("issue-toolbar-filter")).toBeInTheDocument()
    expect(screen.getByTestId("issue-toolbar-display")).toBeInTheDocument()
    expect(screen.getByTestId("issue-layout-board")).toBeInTheDocument()
  })

  it("pushes the search text up as a filter change", async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<IssueFilterBar {...props} />)
    await user.type(screen.getByTestId("issue-toolbar-search"), "m")
    expect(props.onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ query: "m" }))
  })

  it("counts engaged facets on the trigger", () => {
    render(
      <IssueFilterBar
        {...baseProps({ filter: { ...EMPTY_ISSUE_FILTER, query: "x", priorities: ["high"] } })}
      />
    )
    expect(screen.getByTestId("issue-toolbar-filter")).toHaveTextContent("2")
  })

  it("switches layout through the toggle group", async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<IssueFilterBar {...props} />)
    await user.click(screen.getByTestId("issue-layout-list"))
    expect(props.onLayoutChange).toHaveBeenCalledWith("list")
  })

  describe("chips", () => {
    it("shows nothing until a filter is engaged", () => {
      render(<IssueFilterBar {...baseProps()} />)
      expect(screen.queryByTestId("issue-filter-chips")).not.toBeInTheDocument()
    })

    it("makes an engaged filter visible, which a count badge alone never did", () => {
      render(
        <IssueFilterBar {...baseProps({ filter: { ...EMPTY_ISSUE_FILTER, query: "auth" } })} />
      )
      expect(screen.getByTestId("issue-filter-chip-query:auth")).toBeInTheDocument()
    })

    it("removes just that value when a chip is dismissed", async () => {
      const user = userEvent.setup()
      const props = baseProps({
        filter: { ...EMPTY_ISSUE_FILTER, priorities: ["urgent", "low"] },
      })
      render(<IssueFilterBar {...props} />)
      await user.click(screen.getByTestId("issue-filter-chip-remove-priorities:urgent"))
      expect(props.onFilterChange).toHaveBeenCalledWith(
        expect.objectContaining({ priorities: ["low"] })
      )
    })
  })

  describe("filter menu", () => {
    it("toggles a priority facet", async () => {
      const user = userEvent.setup()
      const props = baseProps()
      render(<IssueFilterBar {...props} />)
      await user.click(screen.getByTestId("issue-toolbar-filter"))
      await user.click(await screen.findByText("priority.urgent"))
      expect(props.onFilterChange).toHaveBeenCalledWith(
        expect.objectContaining({ priorities: ["urgent"] })
      )
    })

    it("offers a source facet only once more than one source is present", async () => {
      const user = userEvent.setup()
      render(<IssueFilterBar {...baseProps({ items: [item()] })} />)
      await user.click(screen.getByTestId("issue-toolbar-filter"))
      expect(screen.queryByText("facet.source")).not.toBeInTheDocument()
    })

    it("offers it once a federated row arrives", async () => {
      const user = userEvent.setup()
      render(<IssueFilterBar {...baseProps({ items: [item(), item({ kind: "github" })] })} />)
      await user.click(screen.getByTestId("issue-toolbar-filter"))
      expect(await screen.findByText("facet.source")).toBeInTheDocument()
    })

    it("derives label options from the items actually present", async () => {
      const user = userEvent.setup()
      render(<IssueFilterBar {...baseProps({ items: [item({ labelIds: ["l1"] })] })} />)
      await user.click(screen.getByTestId("issue-toolbar-filter"))
      expect(await screen.findByText("facet.labels")).toBeInTheDocument()
    })
  })

  describe("display menu", () => {
    it("changes grouping", async () => {
      const user = userEvent.setup()
      const props = baseProps()
      render(<IssueFilterBar {...props} />)
      await user.click(screen.getByTestId("issue-toolbar-display"))
      await user.click(await screen.findByText("groupBy.priority"))
      expect(props.onGroupByChange).toHaveBeenCalledWith("priority")
    })

    it("changes sort", async () => {
      const user = userEvent.setup()
      const props = baseProps()
      render(<IssueFilterBar {...props} />)
      await user.click(screen.getByTestId("issue-toolbar-display"))
      await user.click(await screen.findByText("sort.title"))
      expect(props.onSortChange).toHaveBeenCalledWith("title")
    })

    it("changes density", async () => {
      const user = userEvent.setup()
      const props = baseProps()
      render(<IssueFilterBar {...props} />)
      await user.click(screen.getByTestId("issue-toolbar-display"))
      await user.click(await screen.findByTestId("issue-density-compact"))
      expect(props.onDensityChange).toHaveBeenCalledWith("compact")
    })
  })
})
