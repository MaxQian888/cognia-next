import type { Meta, StoryObj } from "@storybook/nextjs"

import { SchedulerSkeleton } from "./scheduler-skeleton"

// `SchedulerSkeleton` is a pure layout-matching loading placeholder with three
// variants (full page / sidebar-only / dashboard-only).
const meta = {
  title: "Scheduler/SchedulerSkeleton",
  component: SchedulerSkeleton,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[520px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerSkeleton>

export default meta
type Story = StoryObj<typeof meta>

export const Full: Story = {
  args: {
    variant: "full",
  },
}

export const Sidebar: Story = {
  args: {
    variant: "sidebar",
  },
}

export const Dashboard: Story = {
  args: {
    variant: "dashboard",
  },
}
