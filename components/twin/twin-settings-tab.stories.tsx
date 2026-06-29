import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinSettingsTab } from "./twin-settings-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeTwinSource } from "@/lib/storybook/fixtures/twin"

// Dexie-backed settings tab: reads source/chunk counts, the twin profile, and
// the shared runtime settings row (falls back to defaults). Renders with zeroed
// counts on an empty DB.
const TWIN_ID = "twin-1"

const meta = {
  title: "Twin/Tabs/SettingsTab",
  component: TwinSettingsTab,
  parameters: { layout: "fullscreen" },
  args: { twinId: TWIN_ID },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinSettingsTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const WithSources: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.twinSources.bulkPut([
        makeTwinSource({ twinId: TWIN_ID, chunkCount: 24 }),
        makeTwinSource({ twinId: TWIN_ID, chunkCount: 11 }),
      ])
    })
  },
}
