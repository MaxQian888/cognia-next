import type { Meta, StoryObj } from "@storybook/nextjs"

import { ScheduledTasksSection } from "./scheduled-tasks-section"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"

// `ScheduledTasksSection` is the single-page scheduler settings surface: runtime
// status digest, defaults for new tasks, system-scheduler health (desktop-only),
// webhook signing signal, permission toggles, the confirmation grid, and limits.
// Most of it reads `useSchedulerStore` (permission policy, status, tasks); reset
// the store so each story starts from the initial policy.
const meta = {
  title: "Settings/ScheduledTasksSection",
  component: ScheduledTasksSection,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSchedulerStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] overflow-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScheduledTasksSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
