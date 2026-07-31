import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalTrackerConfig } from "./goal-tracker-config"
import { seedDb, clearDb } from "@/lib/storybook/seed-db"

// `GoalTrackerConfig` surfaces the built-in Goal Tracker character from Dexie so
// the user can confirm it's installed and inspect its system prompt. It
// distinguishes loading (undefined) from missing (null). `seedDb` runs the
// built-in seed; if the Goal Tracker character is part of it, the card renders,
// otherwise the "missing" notice shows.
const meta = {
  title: "Settings/Goals/GoalTrackerConfig",
  component: GoalTrackerConfig,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await seedDb(() => {})
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalTrackerConfig>

export default meta
type Story = StoryObj<typeof meta>

// Seeded database — resolves to either the tracker card or the missing notice.
export const Default: Story = {}

// Fully empty database (no built-in seed) — the "tracker missing" notice.
export const Missing: Story = {
  beforeEach: async () => {
    await clearDb()
  },
}
