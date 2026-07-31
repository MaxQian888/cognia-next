import type { Meta, StoryObj } from "@storybook/nextjs"

import { SchedulerDashboardViewToggle } from "./scheduler-dashboard-view-toggle"

// `SchedulerDashboardViewToggle` is a thin overview/calendar/timeline toggle.
// It reads/writes the active view via `useSchedulerDashboardView`, which is
// backed by the settings store and defaults to "overview" when unset — so the
// toggle renders fine without seeding. next-intl + next-themes come from the
// preview.
const meta = {
  title: "Scheduler/SchedulerDashboardViewToggle",
  component: SchedulerDashboardViewToggle,
  parameters: { layout: "centered" },
} satisfies Meta<typeof SchedulerDashboardViewToggle>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Constrained: Story = {
  args: {
    className: "w-fit",
  },
  decorators: [
    (Story) => (
      <div className="w-40">
        <Story />
      </div>
    ),
  ],
}
