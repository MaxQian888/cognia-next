import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { KindFilterChips } from "./kind-filter-chips"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

// `KindFilterChips` is a pure multi-select kind filter where "all" is mutually
// exclusive with any specific selection. next-intl is provided by the preview.
const COUNTS: Record<ScheduledItemKind, number> = {
  app: 8,
  workflow: 5,
  backup: 2,
  plugin: 3,
  system: 4,
  connector: 1,
}

const meta = {
  title: "Scheduler/KindFilterChips",
  component: KindFilterChips,
  parameters: { layout: "centered" },
  args: {
    onToggle: fn(),
    onClear: fn(),
    countsByKind: COUNTS,
  },
} satisfies Meta<typeof KindFilterChips>

export default meta
type Story = StoryObj<typeof meta>

export const AllSelected: Story = {
  args: {
    selected: new Set<ScheduledItemKind>(),
  },
}

export const SingleKind: Story = {
  args: {
    selected: new Set<ScheduledItemKind>(["workflow"]),
  },
}

export const MultipleKinds: Story = {
  args: {
    selected: new Set<ScheduledItemKind>(["app", "plugin", "system"]),
  },
}

export const ZeroCounts: Story = {
  args: {
    selected: new Set<ScheduledItemKind>(),
    countsByKind: { app: 0, workflow: 0, backup: 0, plugin: 0, system: 0, connector: 0 },
  },
}
