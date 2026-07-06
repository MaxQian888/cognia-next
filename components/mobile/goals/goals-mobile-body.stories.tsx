import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalsMobileBody } from "./goals-mobile-body"
import { seedDb } from "@/lib/storybook/seed-db"

// Mobile Goals view. Reads the workspace goals live from Dexie, shows a
// status stat strip (active / paused / done), and opens `GoalDetailSheet` on
// tap. With an empty DB it renders zeroed stats + an empty state — the
// deterministic case in the Storybook browser.
const meta = {
  title: "Mobile/Goals/GoalsMobileBody",
  component: GoalsMobileBody,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalsMobileBody>

export default meta
type Story = StoryObj<typeof meta>

/** No goals synced — zeroed stat tiles + empty state. */
export const Empty: Story = {}
