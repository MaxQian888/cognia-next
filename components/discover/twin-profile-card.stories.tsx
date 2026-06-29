import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinProfileCard } from "./twin-profile-card"
import { seedDb } from "@/lib/storybook/seed-db"
import type { TwinProfile } from "@/types/twin"

const TWIN_ID = "twin-1"

// Desktop twin summary card — reads the `twinProfile` Dexie row directly and
// projects it via `summarizeTwinProfile`. Distinguishes loading / empty /
// populated. Seed a row for the populated state; empty DB shows the empty copy.
const meta = {
  title: "Discover/TwinProfileCard",
  component: TwinProfileCard,
  args: { twinId: TWIN_ID },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinProfileCard>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const profile = {
        twinId: TWIN_ID,
        updatedAt: Date.now() - 60 * 60 * 1000,
        styleSamples: [{ text: "sample a" }, { text: "sample b" }, { text: "sample c" }],
        entities: [{ name: "Acme" }, { name: "Project Apollo" }],
        voiceSummary:
          "Concise and warm; favors bullet points, opens with the answer, avoids hedging.",
      } as unknown as TwinProfile
      await db.twinProfile.put(profile)
    })
  },
}
