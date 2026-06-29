import type { Meta, StoryObj } from "@storybook/nextjs"

import { TeamsSection } from "./teams-section"
import { seedDb } from "@/lib/storybook/seed-db"

// `TeamsSection` manages agent teams. It reads teams, characters, and MCP
// servers from Dexie via `useLiveQuery`. `seedDb` resets to a fresh database and
// waits for the built-in seed (which includes starter teams/characters), so the
// list renders populated rather than empty.
const meta = {
  title: "Settings/TeamsSection",
  component: TeamsSection,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await seedDb(() => {})
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TeamsSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
