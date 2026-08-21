import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { buildIssueGroups } from "@/lib/issues/board-model"
import { statusCategoryOf, type IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueList } from "./issue-list"

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const kind = over.kind ?? "local"
  const sourceId = over.sourceId ?? `s${seq}`
  const status: IssueStatus = over.status ?? "todo"
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    identifier: `MERC-${seq}`,
    title: `Issue ${seq}`,
    status,
    statusCategory: statusCategoryOf(status),
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
  { id: "l2", scope: "issue", name: "feature", sortOrder: 1, createdAt: 0, updatedAt: 0 },
  { id: "l3", scope: "issue", name: "chore", sortOrder: 2, createdAt: 0, updatedAt: 0 },
]

const ITEMS: UnifiedIssueItem[] = [
  item({
    status: "todo",
    title: "Ship the redesigned board",
    priority: "urgent",
    labelIds: ["l1"],
  }),
  item({
    status: "todo",
    title: "A title long enough to need truncating against whatever space the row actually has",
    priority: "medium",
    assignee: { kind: "human", label: "Me" },
    issueProjectId: "p1",
    labelIds: ["l1", "l2", "l3"],
  }),
  item({
    status: "in_progress",
    title: "Wire the run adapter",
    assignee: { kind: "agent", id: "a1", label: "Scout" },
  }),
  item({ status: "done", title: "Delete the old toolbar", priority: "high" }),
  item({ kind: "github", sourceId: "o/r#42", status: "todo", title: "Crash on empty workspace" }),
]

const meta = {
  title: "Issues/List",
  component: IssueList,
  parameters: { layout: "fullscreen" },
  args: {
    groups: buildIssueGroups(ITEMS, "status"),
    groupBy: "status" as const,
    labelsById: new Map(LABELS.map((label) => [label.id, label])),
    projectNamesById: new Map([["p1", "Mercury"]]),
    onSelect: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[32rem] w-full bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IssueList>

export default meta
type Story = StoryObj<typeof meta>

export const Comfortable: Story = {}

export const Compact: Story = {
  args: { density: "compact" },
}

export const Selection: Story = {
  args: {
    onToggleCheck: fn(),
    checkedIds: new Set(["local:s1", "local:s2"]),
    cursorId: "local:s3",
  },
}

export const GroupedByPriority: Story = {
  args: {
    groups: buildIssueGroups(ITEMS, "priority"),
    groupBy: "priority",
  },
}

export const Ungrouped: Story = {
  args: {
    groups: buildIssueGroups(ITEMS, "none"),
    groupBy: "none",
  },
}

export const Running: Story = {
  args: { runningIds: new Set(["local:s3"]) },
}

export const Empty: Story = {
  args: { groups: [] },
}
