import type { Meta, StoryObj } from "@storybook/nextjs"
import { PlugIcon, SparklesIcon, WorkflowIcon } from "lucide-react"

import { FeaturePageHeader } from "./feature-page-header"
import { FeaturePageShell } from "./feature-page-shell"

function Pane({ label, tone }: { label: string; tone: string }) {
  return (
    <div className={`flex h-full items-center justify-center p-4 text-sm ${tone}`}>{label}</div>
  )
}

// The Canvas-style 3-pane layout every top-level feature route renders inside:
// a sticky header, optional left rail + right inspector, and a resizable center.
const meta = {
  title: "FeatureShell/FeaturePageShell",
  component: FeaturePageShell,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FeaturePageShell>

export default meta
type Story = StoryObj<typeof meta>

export const ThreePane: Story = {
  args: {
    storageId: "story-three-pane",
    header: (
      <FeaturePageHeader
        icon={<WorkflowIcon />}
        title="Workflows"
        description="Build and run repeatable automations"
      />
    ),
    leftPane: {
      content: <Pane label="Left rail" tone="text-muted-foreground" />,
      label: "Navigation",
    },
    rightPane: {
      content: <Pane label="Inspector" tone="text-muted-foreground" />,
      label: "Inspector",
    },
    children: <Pane label="Center content" tone="text-foreground" />,
  },
}

export const CenterOnly: Story = {
  args: {
    storageId: "story-center-only",
    children: <Pane label="Center content" tone="text-foreground" />,
  },
}

export const WithLeftRail: Story = {
  args: {
    storageId: "story-left-rail",
    header: (
      <FeaturePageHeader
        icon={<SparklesIcon />}
        title="Skills"
        description="Reusable capabilities for every agent"
      />
    ),
    leftPane: {
      content: <Pane label="Left rail" tone="text-muted-foreground" />,
      label: "Navigation",
    },
    children: <Pane label="Center content" tone="text-foreground" />,
  },
}

export const CompactHeader: Story = {
  args: {
    storageId: "story-compact",
    header: <FeaturePageHeader variant="compact" icon={<PlugIcon />} title="Plugin devtools" />,
    children: <Pane label="Workspace content" tone="text-foreground" />,
  },
}
