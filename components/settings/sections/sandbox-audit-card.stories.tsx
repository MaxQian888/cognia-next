import type { Meta, StoryObj } from "@storybook/nextjs"

import { SandboxAuditCard } from "./sandbox-audit-card"
import { clearDb, seedDb } from "@/lib/storybook/seed-db"
import { makeAutomationAuditRows } from "@/lib/storybook/fixtures/settings-system"

// Dexie-reading: reads the shared `automationAuditLog` table and shows the
// newest sandbox-surface rows. Default opens an empty IndexedDB (empty note);
// the populated story seeds rows (two of which are `surface: "sandbox"`).
const meta = {
  title: "Settings/Sections/SandboxAuditCard",
  component: SandboxAuditCard,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await clearDb()
  },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SandboxAuditCard>

export default meta
type Story = StoryObj<typeof meta>

// Empty IndexedDB → "no sandbox events" empty note.
export const Default: Story = {}

// Seeded audit rows — the two `sandbox` rows render (allow + deny).
export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.automationAuditLog.bulkPut(makeAutomationAuditRows())
    })
  },
}
