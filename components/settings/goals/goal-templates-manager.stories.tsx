import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalTemplatesManager } from "./goal-templates-manager"
import { seedDb } from "@/lib/storybook/seed-db"

// `GoalTemplatesManager` is a Dexie-backed CRUD list over goal templates
// (built-ins are clone-on-edit, user copies are deletable). On an empty
// database it shows the empty state; the inline editor opens via "add".
const meta = {
  title: "Settings/Goals/GoalTemplatesManager",
  component: GoalTemplatesManager,
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
} satisfies Meta<typeof GoalTemplatesManager>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
