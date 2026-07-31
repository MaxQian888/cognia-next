import type { Meta, StoryObj } from "@storybook/nextjs"
import { DownloadIcon, FilterIcon, PlusIcon, RefreshCwIcon, WorkflowIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FeaturePageHeader } from "./feature-page-header"

const meta = {
  title: "FeatureShell/FeaturePageHeader",
  component: FeaturePageHeader,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FeaturePageHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Management: Story = {
  args: {
    icon: <WorkflowIcon />,
    title: "Workflows",
    description: "Build, organize, and run repeatable automations",
    context: "Root folder",
    status: <span className="text-emerald-600">Ready</span>,
    summary: <span>12 workflows · 3 active</span>,
    primaryAction: {
      id: "create",
      label: "New workflow",
      icon: PlusIcon,
    },
    secondaryActions: [
      { id: "refresh", label: "Refresh", icon: RefreshCwIcon },
      { id: "export", label: "Export", icon: DownloadIcon },
    ],
    overflowLabel: "More workflow actions",
    controls: (
      <div className="flex min-w-max items-center gap-2">
        <Input className="h-8 w-72" placeholder="Search workflows" />
        <Button variant="outline" size="sm">
          <FilterIcon />
          Filters
        </Button>
      </div>
    ),
  },
}

export const Compact: Story = {
  args: {
    variant: "compact",
    icon: <WorkflowIcon />,
    title: "Workflow editor",
    status: <span className="text-xs text-muted-foreground">Saved</span>,
    actions: (
      <Button size="sm">
        <PlusIcon />
        Run
      </Button>
    ),
  },
}

export const LongLocalizedContent: Story = {
  args: {
    icon: <WorkflowIcon />,
    title: "自动化工作流与重复任务管理",
    description: "创建、组织并运行可重复使用的自动化流程，同时保留完整的运行上下文",
    context: "企业级自动化工作区",
    primaryAction: {
      id: "create",
      label: "创建新工作流",
      icon: PlusIcon,
    },
    overflowLabel: "更多工作流操作",
    secondaryActions: [{ id: "refresh", label: "刷新全部工作流", icon: RefreshCwIcon }],
  },
}

export const DisabledAndLoadingActions: Story = {
  args: {
    icon: <WorkflowIcon />,
    title: "Plugins",
    description: "Manage installed extensions and runtime capabilities",
    primaryAction: {
      id: "install",
      label: "Install plugin",
      icon: PlusIcon,
    },
    secondaryActions: [
      {
        id: "checking",
        label: "Checking for updates",
        icon: RefreshCwIcon,
        disabled: true,
      },
    ],
    overflowActions: [
      {
        id: "export",
        label: "Export diagnostics",
        icon: DownloadIcon,
      },
    ],
    overflowLabel: "More plugin actions",
  },
}

export const NarrowContainer: Story = {
  args: Management.args,
  decorators: [
    (Story) => (
      <div className="w-[360px] resize-x overflow-auto border">
        <Story />
      </div>
    ),
  ],
}

export const ReducedMotion: Story = {
  args: Management.args,
  parameters: {
    chromatic: { prefersReducedMotion: "reduce" },
  },
}
