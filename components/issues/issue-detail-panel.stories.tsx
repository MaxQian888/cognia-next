import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { statusCategoryOf } from "@/types/issues"
import type { IssueProject } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueDetailPanel } from "./issue-detail-panel"

const LABELS: LabelRow[] = [
  { id: "l1", scope: "issue", name: "bug", sortOrder: 0, createdAt: 0, updatedAt: 0 },
  { id: "l2", scope: "issue", name: "feature", sortOrder: 1, createdAt: 0, updatedAt: 0 },
]

const PROJECTS: IssueProject[] = [
  {
    id: "p1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    status: "in_progress",
    priority: "high",
    resources: [],
    createdAt: 0,
    updatedAt: 0,
  },
]

const LOCAL: UnifiedIssueItem = {
  unifiedId: "local:i1",
  kind: "local",
  sourceId: "i1",
  identifier: "MERC-42",
  title: "Dragging a card paints it under the columns",
  description:
    "The card is transformed in place inside components/issues/board/issue-board.tsx:175,\nso the column clips it.",
  status: "in_progress",
  statusCategory: statusCategoryOf("in_progress"),
  priority: "urgent",
  assignee: { kind: "agent", id: "a1", label: "Scout" },
  labelIds: ["l1"],
  issueProjectId: "p1",
  order: 0,
  createdAt: Date.parse("2026-08-01T00:00:00.000Z"),
  updatedAt: Date.parse("2026-08-20T00:00:00.000Z"),
  origin: { deepLinkHref: "/issues?id=i1" },
  capabilities: FULL_ISSUE_CAPABILITIES,
}

const meta = {
  title: "Issues/DetailPanel",
  component: IssueDetailPanel,
  parameters: { layout: "fullscreen" },
  args: {
    item: LOCAL,
    labelsById: new Map(LABELS.map((label) => [label.id, label])),
    projectNamesById: new Map([["p1", "Mercury"]]),
    labels: LABELS,
    projects: PROJECTS,
    assigneeOptions: [
      { key: "human:self", actor: { kind: "human", label: "Me" }, group: "human" as const },
      {
        key: "agent:a1",
        actor: { kind: "agent", id: "a1", label: "Scout" },
        group: "agent" as const,
      },
    ],
    onAction: fn(),
    onRequestDelete: fn(),
    onClose: fn(),
    onWritebackCompleted: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[40rem] w-96 border-l bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IssueDetailPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Editable: Story = {}

/** No action handler: every property renders without a trigger. */
export const ReadOnlyLocal: Story = {
  args: { onAction: undefined, onRequestDelete: undefined },
}

/** A GitHub mirror row: read-only, with a write-back path instead. */
export const Federated: Story = {
  args: {
    item: {
      ...LOCAL,
      unifiedId: "github:acme/mercury#42",
      kind: "github",
      sourceId: "acme/mercury#42",
      identifier: "acme/mercury#42",
      capabilities: { ...READ_ONLY_ISSUE_CAPABILITIES, canComment: true },
      origin: {
        tableName: "githubIssueMirror",
        deepLinkHref: "https://github.test/acme/mercury/issues/42",
        sourceLabel: "GitHub",
      },
    },
  },
}

/** A run holds the issue: the status menu locks. */
export const RunInFlight: Story = {
  args: { running: true },
}
