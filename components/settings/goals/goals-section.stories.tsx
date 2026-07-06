import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalsSection } from "./goals-section"
import { seedDb } from "@/lib/storybook/seed-db"

// `GoalsSection` is a thin launcher into the standalone `/goals` console plus
// the inline Goal Tracker config card (which reads the built-in Goal Tracker
// character from Dexie). `seedDb` opens a fresh database and lets the built-in
// seed run so the tracker card resolves its loading state.
const meta = {
  title: "Settings/Goals/GoalsSection",
  component: GoalsSection,
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
} satisfies Meta<typeof GoalsSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
