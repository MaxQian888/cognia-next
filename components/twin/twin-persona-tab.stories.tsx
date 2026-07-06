import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinPersonaTab } from "./twin-persona-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeEntity, makePlaybook, makeStyleSample } from "@/lib/storybook/fixtures/twin"

// Dexie-backed: `useLiveQuery(getTwinProfile)` reads the `twinProfile` row
// (id === twinId). Default renders the no-profile empty state; the seeded
// story populates the persona subtabs.
const TWIN_ID = "twin-1"

const meta = {
  title: "Twin/Tabs/PersonaTab",
  component: TwinPersonaTab,
  parameters: { layout: "fullscreen" },
  args: { twinId: TWIN_ID },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinPersonaTab>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const WithProfile: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.twinProfile.put({
        id: TWIN_ID,
        twinId: TWIN_ID,
        styleSamples: [makeStyleSample({ pinned: true }), makeStyleSample()],
        playbooks: [makePlaybook({ confidence: 0.9 }), makePlaybook({ confidence: 0.6 })],
        entities: [makeEntity({ role: "person" }), makeEntity({ role: "project" })],
        decisions: [],
        voiceSummary: "Professional, concise, reassuring tone across customer comms.",
        updatedAt: Date.now(),
      })
    })
  },
}
