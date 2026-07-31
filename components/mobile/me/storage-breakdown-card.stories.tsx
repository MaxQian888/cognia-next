import type { Meta, StoryObj } from "@storybook/nextjs"

import { StorageBreakdownCard } from "./storage-breakdown-card"
import { seedDb } from "@/lib/storybook/seed-db"

// `StorageBreakdownCard` reads per-category sizes + health from `StorageManager`
// (which walks the real, empty Storybook IndexedDB). With a fresh DB it resolves
// the healthy / empty-breakdown branch; the skeleton shows only during the
// initial in-flight fetch.
const meta = {
  title: "Mobile/Me/StorageBreakdownCard",
  component: StorageBreakdownCard,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StorageBreakdownCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
