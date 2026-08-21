import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { EMPTY_ISSUE_FILTER } from "@/lib/issues/board-model"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
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
    order: seq,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

const LABELS: LabelRow[] = [
  { id: "l1", scope: "issue", name: "bug", sortOrder: 0, createdAt: 0, updatedAt: 0 },
]

const meta = {
  title: "Issues/FilterBar",
  component: IssueFilterBar,
  parameters: { layout: "fullscreen" },
  args: {
    items: [
      item({ labelIds: ["l1"], assignee: { kind: "human", label: "Me" }, issueProjectId: "p1" }),
      item({ kind: "github", issueProjectId: "p2" }),
    ],
    filter: EMPTY_ISSUE_FILTER,
    onFilterChange: fn(),
    layout: "board" as const,
    onLayoutChange: fn(),
    groupBy: "status" as const,
    onGroupByChange: fn(),
    sort: "manual" as const,
    onSortChange: fn(),
    density: "comfortable" as const,
    onDensityChange: fn(),
    labelsById: new Map(LABELS.map((label) => [label.id, label])),
    projectNamesById: new Map([
      ["p1", "Mercury"],
      ["p2", "Venus"],
    ]),
  },
  decorators: [
    (Story) => (
      <div className="w-full bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IssueFilterBar>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

/** The whole point of the chip row: an engaged filter is visible. */
export const Filtering: Story = {
  args: {
    filter: {
      query: "auth",
      labelIds: ["l1"],
      priorities: ["urgent"],
      assignees: ["human:self"],
      sources: ["github"],
      issueProjectIds: ["p1"],
    },
  },
}

export const SingleChip: Story = {
  args: { filter: { ...EMPTY_ISSUE_FILTER, query: "regression" } },
}

export const ListLayout: Story = {
  args: { layout: "list", density: "compact" },
}
