import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import type { IssueProject } from "@/types/issues"
import { ProjectInspector } from "./project-inspector"

const PROJECT: IssueProject = {
  id: "p1",
  projectId: "w1",
  key: "MERC",
  name: "Mercury",
  icon: "🚀",
  description: "Ship the redesigned tracker.\n\nShared with agents as context.",
  status: "in_progress",
  priority: "high",
  lead: { kind: "human", label: "Ada" },
  startDate: Date.parse("2026-07-01T00:00:00.000Z"),
  targetDate: Date.parse("2026-09-01T00:00:00.000Z"),
  resources: [
    { kind: "github-repo", repoFullName: "acme/mercury", addedAt: 0 },
    { kind: "workspace-root", rootId: "root-1", addedAt: 0 },
  ],
  createdAt: 0,
  updatedAt: 0,
}

const meta = {
  title: "Issues/ProjectInspector",
  component: ProjectInspector,
  parameters: { layout: "fullscreen" },
  args: {
    project: PROJECT,
    progress: { total: 12, completed: 5, canceled: 1, started: 6, denominator: 11, ratio: 5 / 11 },
    onPatch: fn(),
    onClose: fn(),
    onAddResource: fn(),
    onRemoveResource: fn(),
    onRequestDelete: fn(),
    onOpenIssues: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[40rem] w-96 border-l bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProjectInspector>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

/** Everything optional left unset — the panel must still be legible. */
export const Bare: Story = {
  args: {
    project: {
      ...PROJECT,
      icon: undefined,
      description: undefined,
      lead: undefined,
      startDate: undefined,
      targetDate: undefined,
      resources: [],
    },
    progress: undefined,
  },
}
