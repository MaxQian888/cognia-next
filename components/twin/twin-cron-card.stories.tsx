import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinCronCard } from "./twin-cron-card"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeTwin } from "@/lib/storybook/fixtures/twin"

// Dexie-backed: reads the live `twins` row (`getTwin`) plus scheduler tasks.
// Needs a twin row to render the cron settings; seed one.
const TWIN_ID = "twin-1"

const meta = {
  title: "Twin/CronCard",
  component: TwinCronCard,
  parameters: { layout: "padded" },
  args: { twinId: TWIN_ID },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinCronCard>

export default meta
type Story = StoryObj<typeof meta>

export const NoCron: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.twins.put(makeTwin({ id: TWIN_ID, name: "Support Engineer" }))
    })
  },
}

export const WithCron: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.twins.put(
        makeTwin({
          id: TWIN_ID,
          name: "Support Engineer",
          cron: {
            enabled: true,
            ingestSchedule: "0 3 * * *",
            distillSchedule: "0 4 * * 0",
            timezone: "Asia/Shanghai",
          },
        })
      )
    })
  },
}
