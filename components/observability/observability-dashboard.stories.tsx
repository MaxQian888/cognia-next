import type { Meta, StoryObj } from "@storybook/nextjs"

import { ObservabilityDashboard } from "./observability-dashboard"
import { resetStore } from "@/lib/storybook/seed-stores"
import { seedDb } from "@/lib/storybook/seed-db"
import { useObservabilityStore } from "@/stores/observability/observability-store"
import { makeWindowSpans } from "@/lib/storybook/fixtures/observability"

// `ObservabilityDashboard` is the live wrapper: it reads windowed spans from
// Dexie over the selected time range (default "1h" relative preset) and wires
// them to the toolbar, the draggable panel grid and the trace drawer. Stories
// reset the persisted store and seed spans within the last hour so the grid
// populates; the empty story seeds none to show the zero-data dashboard.
const meta = {
  title: "Observability/Dashboard",
  component: ObservabilityDashboard,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useObservabilityStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[760px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ObservabilityDashboard>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    resetStore(useObservabilityStore)
    await seedDb(async (db) => {
      await db.agentTraces.bulkPut(makeWindowSpans())
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    resetStore(useObservabilityStore)
    await seedDb(async () => {})
  },
}
