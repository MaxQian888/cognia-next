import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinSourcesTab } from "./twin-sources-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeTwinSource } from "@/lib/storybook/fixtures/twin"

// Dexie-backed: `useLiveQuery(listTwinSourcesByTwin)` reads the `twinSources`
// table. Default renders the empty state; the seeded story inserts rows.
const TWIN_ID = "twin-1"

const meta = {
  title: "Twin/Tabs/SourcesTab",
  component: TwinSourcesTab,
  parameters: { layout: "fullscreen" },
  args: { twinId: TWIN_ID },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinSourcesTab>

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
        makeTwinSource({ twinId: TWIN_ID, title: "onboarding.md", status: "parsed" }),
        makeTwinSource({
          twinId: TWIN_ID,
          title: "support-threads.json",
          kind: "chat",
          format: "chatgpt-export",
          status: "parsing",
        }),
        makeTwinSource({
          twinId: TWIN_ID,
          title: "broken.pdf",
          kind: "document",
          format: "pdf",
          status: "failed",
          errorMessage: "Encrypted PDF could not be parsed.",
        }),
      ])
    })
  },
}
