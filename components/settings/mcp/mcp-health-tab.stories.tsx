import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpHealthTab } from "./mcp-health-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeMcpAuditRow } from "@/lib/storybook/fixtures/settings-mcp"

// Reads the inbound bridge status (desktop-only — shows the "desktop only" note
// in the Storybook browser since isTauri() is false) and the bridge audit log
// from Dexie via effects. Seed `mcpAuditLog` rows to populate the table.
const meta = {
  title: "Settings/MCP/McpHealthTab",
  component: McpHealthTab,
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpHealthTab>

export default meta
type Story = StoryObj<typeof meta>

// Empty DB → bridge "desktop only" note + empty audit table.
export const Default: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const WithAuditLog: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.mcpAuditLog.bulkPut([
        makeMcpAuditRow({ tool: "wiki_search", allowed: true, latencyMs: 28 }),
        makeMcpAuditRow({ tool: "tools/list", scope: "n/a", allowed: true, latencyMs: 9 }),
        makeMcpAuditRow({
          tool: "wiki_write",
          allowed: false,
          latencyMs: 4,
          reason: "scope OFF",
        }),
      ])
    })
  },
}
