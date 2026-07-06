import type { Meta, StoryObj } from "@storybook/nextjs"
import { Button } from "@/components/ui/button"

import { PanelFrame } from "./panel-frame"

// `PanelFrame` is the shared chrome (title bar + optional threshold dot + actions
// slot + edit-mode drag handle) every dashboard panel wraps its body in. Pure
// props-only; stories cover view vs edit mode, each threshold level and an
// actions slot.
const meta = {
  title: "Observability/PanelFrame",
  component: PanelFrame,
  args: {
    title: "Cost over time",
    children: (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Panel body
      </div>
    ),
  },
  decorators: [
    (Story) => (
      <div className="h-[220px] w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PanelFrame>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const EditMode: Story = {
  args: { editMode: true },
}

export const ThresholdOk: Story = {
  args: { level: "ok" },
}

export const ThresholdWarn: Story = {
  args: { level: "warn" },
}

export const ThresholdCrit: Story = {
  args: { level: "crit" },
}

export const WithActions: Story = {
  args: {
    title: "Recent traces",
    actions: (
      <Button variant="ghost" size="sm" className="h-6 text-xs">
        Expand
      </Button>
    ),
  },
}
