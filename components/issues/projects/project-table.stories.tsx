import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import type { IssueProjectProgress } from "@/lib/issues/project-progress"
import type { IssueProject } from "@/types/issues"
import { ProjectTable } from "./project-table"

const PROJECTS: IssueProject[] = [
  {
    id: "p1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    icon: "🚀",
    status: "in_progress",
    priority: "high",
    lead: { kind: "human", label: "Ada" },
    startDate: Date.parse("2026-07-01T00:00:00.000Z"),
    targetDate: Date.parse("2026-09-01T00:00:00.000Z"),
    resources: [],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "p2",
    projectId: "w1",
    key: "VEN",
    name: "Venus, with a name long enough to have to truncate in its cell",
    status: "planned",
    priority: "medium",
    resources: [],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "p3",
    projectId: "w1",
    key: "MARS",
    name: "Mars",
    icon: "🎯",
    status: "completed",
    priority: "low",
    lead: { kind: "team", id: "t1", label: "Platform" },
    resources: [],
    createdAt: 0,
    updatedAt: 0,
  },
]

const PROGRESS = new Map<string, IssueProjectProgress>([
  ["p1", { total: 12, completed: 5, canceled: 1, started: 6, denominator: 11, ratio: 5 / 11 }],
  ["p2", { total: 0, completed: 0, canceled: 0, started: 0, denominator: 0, ratio: 0 }],
  ["p3", { total: 8, completed: 7, canceled: 1, started: 0, denominator: 7, ratio: 1 }],
])

const meta = {
  title: "Issues/ProjectTable",
  component: ProjectTable,
  parameters: { layout: "fullscreen" },
  args: {
    projects: PROJECTS,
    progressById: PROGRESS,
    onSelect: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[24rem] w-full bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProjectTable>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Selected: Story = {
  args: { selectedId: "p1" },
}

/** No progress rows at all: every cell must still render something. */
export const WithoutProgress: Story = {
  args: { progressById: new Map() },
}
