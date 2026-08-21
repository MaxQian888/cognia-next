import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import type { IssueProjectProgress } from "@/lib/issues/project-progress"
import type { IssueProject } from "@/types/issues"
import type { LabelRow } from "@/types/labels"
import { IssueRail } from "./issue-rail"

const PROJECTS: IssueProject[] = [
  {
    id: "p1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    icon: "🚀",
    status: "in_progress",
    priority: "high",
    resources: [],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "p2",
    projectId: "w1",
    key: "VEN",
    name: "Venus, with a name long enough to truncate",
    status: "planned",
    priority: "medium",
    resources: [],
    createdAt: 0,
    updatedAt: 0,
  },
]

const PROGRESS = new Map<string, IssueProjectProgress>([
  ["p1", { total: 12, completed: 5, canceled: 1, started: 6, denominator: 11, ratio: 5 / 11 }],
  ["p2", { total: 0, completed: 0, canceled: 0, started: 0, denominator: 0, ratio: 0 }],
])

const LABELS: LabelRow[] = [
  { id: "l1", scope: "issue", name: "bug", sortOrder: 0, createdAt: 0, updatedAt: 0 },
  { id: "l2", scope: "issue", name: "feature", sortOrder: 1, createdAt: 0, updatedAt: 0 },
  {
    id: "github:regression",
    scope: "issue",
    name: "regression",
    builtin: true,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  },
]

const meta = {
  title: "Issues/Rail",
  component: IssueRail,
  parameters: { layout: "fullscreen" },
  args: {
    viewId: "all",
    viewCounts: { all: 12, assigned: 3, created: 5, "my-agents": 2 },
    onSelectView: fn(),
    projects: PROJECTS,
    projectProgress: PROGRESS,
    activeProjectIds: [],
    onToggleProject: fn(),
    labels: LABELS,
    labelCounts: new Map([
      ["l1", 4],
      ["l2", 2],
      ["github:regression", 1],
    ]),
    activeLabelIds: [],
    onToggleLabel: fn(),
    onManageLabels: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[32rem] w-64 border-r bg-muted/20">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IssueRail>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

/** What a fresh workspace looks like before anything has been created. */
export const Empty: Story = {
  args: {
    viewCounts: { all: 0, assigned: 0, created: 0, "my-agents": 0 },
    projects: [],
    projectProgress: new Map(),
    labels: [],
    labelCounts: new Map(),
  },
}

export const Filtering: Story = {
  args: {
    viewId: "assigned",
    activeProjectIds: ["p1"],
    activeLabelIds: ["l1"],
  },
}

/** No management handler: the section header control must not render. */
export const WithoutLabelManagement: Story = {
  args: { onManageLabels: undefined },
}
