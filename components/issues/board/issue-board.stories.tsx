import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { statusCategoryOf, type IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueBoard } from "./issue-board"

// The board is the surface where drag actually has to be watched: a card must
// leave its column, ride above every other column, and land on a marked spot.
// jsdom can prove the overlay is portaled; only a browser proves it looks right.

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
]

const POPULATED: UnifiedIssueItem[] = [
  item({ status: "backlog", title: "Audit the export pipeline", priority: "low" }),
  item({
    status: "todo",
    title: "Ship the redesigned board",
    priority: "urgent",
    labelIds: ["l1"],
  }),
  item({
    status: "todo",
    title: "Rename every identifier that leaked the old prefix",
    priority: "medium",
    assignee: { kind: "human", label: "Me" },
  }),
  item({
    status: "in_progress",
    title: "Wire the run adapter",
    assignee: { kind: "agent", id: "a1", label: "Scout" },
  }),
  item({ status: "in_review", title: "Review the drop reducer", labelIds: ["l2"] }),
  item({ status: "done", title: "Delete the old toolbar", priority: "high" }),
  item({
    kind: "github",
    sourceId: "o/r#42",
    status: "todo",
    title: "Crash on empty workspace",
    labelIds: ["github:bug"],
  }),
]

const meta = {
  title: "Issues/Board",
  component: IssueBoard,
  parameters: { layout: "fullscreen" },
  args: {
    labelsById: new Map(LABELS.map((label) => [label.id, label])),
    projectNamesById: new Map([["p1", "Mercury"]]),
    onSelect: fn(),
    onDrop: fn(),
    onAddIssue: fn(),
    onToggleColumnCollapsed: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[36rem] w-full bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IssueBoard>

export default meta
type Story = StoryObj<typeof meta>

/** Every column empty, so all six render as collapsed strips. */
export const Empty: Story = {
  args: { items: [] },
}

export const Populated: Story = {
  args: { items: POPULATED },
}

/** Drag a card here: it must ride above the columns and never clip. */
export const AllColumnsOpen: Story = {
  args: {
    items: POPULATED,
    columnCollapse: {
      backlog: false,
      todo: false,
      in_progress: false,
      in_review: false,
      done: false,
      canceled: false,
    },
  },
}

/** A running issue: `in_progress` refuses it in both directions. */
export const RunInFlight: Story = {
  args: {
    items: POPULATED,
    runningIds: new Set(["local:s4"]),
  },
}

/** A container with a name, so the card's project chip renders. */
export const WithProjectChips: Story = {
  args: {
    items: POPULATED.map((candidate) => ({ ...candidate, issueProjectId: "p1" })),
  },
}

export const SelectedCard: Story = {
  args: { items: POPULATED, selectedId: "local:s2" },
}
