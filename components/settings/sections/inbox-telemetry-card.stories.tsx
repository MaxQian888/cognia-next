import type { Meta, StoryObj } from "@storybook/nextjs"

import { InboxTelemetryCard } from "./inbox-telemetry-card"
import { clearDb } from "@/lib/storybook/seed-db"

// Dexie-reading: reads the `inboxTelemetryEvents` ring buffer and exports it as
// CSV / JSON. With an empty IndexedDB the row count is 0 and the export buttons
// are disabled — the meaningful empty state for this exporter card.
const meta = {
  title: "Settings/Sections/InboxTelemetryCard",
  component: InboxTelemetryCard,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await clearDb()
  },
  decorators: [
    (Story) => (
      <div className="w-[520px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InboxTelemetryCard>

export default meta
type Story = StoryObj<typeof meta>

// Empty buffer → "0 rows", export disabled.
export const Default: Story = {}
