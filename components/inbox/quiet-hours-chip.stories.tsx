import type { Meta, StoryObj } from "@storybook/nextjs"

import { QuietHoursChip } from "./quiet-hours-chip"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeAdapterInstance, makeConversationOverride } from "@/lib/storybook/fixtures/inbox"

const ADAPTER_ID = "story-adapter"
const CONVERSATION_KEY = "slack:story-adapter:C1"

// The chip resolves the effective quiet window (conversation override beats
// adapter-level) and renders nothing when neither is configured. The active /
// inactive state depends on the current wall-clock vs the window.
const meta = {
  title: "Inbox/QuietHoursChip",
  component: QuietHoursChip,
  args: { adapterId: ADAPTER_ID, conversationKey: CONVERSATION_KEY },
  parameters: { layout: "padded" },
} satisfies Meta<typeof QuietHoursChip>

export default meta
type Story = StoryObj<typeof meta>

// A wide 00:00–23:59 window is effectively always active.
export const ActiveWindow: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.adapterInstances.put(
        makeAdapterInstance({
          id: ADAPTER_ID,
          quietHours: { from: "00:00", to: "23:59", tz: "UTC" },
        })
      )
    })
  },
}

// Conversation override quiet hours take precedence over the adapter window.
export const OverrideWindow: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.adapterInstances.put(
        makeAdapterInstance({
          id: ADAPTER_ID,
          quietHours: { from: "09:00", to: "17:00", tz: "UTC" },
        })
      )
      await db.conversationOverrides.put(
        makeConversationOverride({
          conversationKey: CONVERSATION_KEY,
          quietHours: { from: "22:00", to: "07:00", tz: "UTC" },
        })
      )
    })
  },
}

// No quiet window configured anywhere → renders nothing.
export const Hidden: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.adapterInstances.put(makeAdapterInstance({ id: ADAPTER_ID }))
    })
  },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <QuietHoursChip {...args} />
    </div>
  ),
}
