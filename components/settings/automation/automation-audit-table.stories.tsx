import type { Meta, StoryObj } from "@storybook/nextjs"

import { AutomationAuditTable } from "./automation-audit-table"
import { clearDb, seedDb } from "@/lib/storybook/seed-db"
import { makeAutomationAuditRows } from "@/lib/storybook/fixtures/settings-system"

// Dexie-reading: lists `automationAuditLog` rows newest-first with surface +
// decision filters and CSV export. Default is an empty DB (empty note); the
// populated story seeds a spread of surfaces and decisions.
const meta = {
  title: "Settings/Automation/AutomationAuditTable",
  component: AutomationAuditTable,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await clearDb()
  },
  decorators: [
    (Story) => (
      <div className="w-[840px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AutomationAuditTable>

export default meta
type Story = StoryObj<typeof meta>

// Empty IndexedDB → "no audit rows" note.
export const Default: Story = {}

// Seeded rows across sandbox / computerUse / workflow / plugin surfaces.
export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.automationAuditLog.bulkPut(makeAutomationAuditRows())
    })
  },
}
