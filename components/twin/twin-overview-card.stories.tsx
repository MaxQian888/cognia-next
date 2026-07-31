import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinOverviewCard } from "./twin-overview-card"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeTwinSource } from "@/lib/storybook/fixtures/twin"

// Dexie-backed dashboard: reads `twinSources` + `twinChunks` + profile via
// `useLiveQuery`. Default renders the empty (no-sources) state; the seeded
// story populates the sources breakdown.
const TWIN_ID = "twin-1"

const meta = {
  title: "Twin/OverviewCard",
  component: TwinOverviewCard,
  parameters: { layout: "fullscreen" },
  args: { twinId: TWIN_ID },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinOverviewCard>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const WithSources: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.twinSources.bulkPut([
        makeTwinSource({ twinId: TWIN_ID, kind: "document", format: "markdown", chunkCount: 18 }),
        makeTwinSource({ twinId: TWIN_ID, kind: "chat", format: "chatgpt-export", chunkCount: 42 }),
        makeTwinSource({ twinId: TWIN_ID, kind: "code", format: "git-repo", chunkCount: 9 }),
      ])
    })
  },
}
