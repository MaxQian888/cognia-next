import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginGovernancePane } from "./plugin-governance-pane"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Governance section — switches between cross-plugin aggregate views
// (permissions matrix, scheduled jobs, analytics, audit log, policy) based on
// `usePluginsStore.governanceView`. Each story seeds the view + the DB.

const meta = {
  title: "Plugins/Governance/PluginGovernancePane",
  component: PluginGovernancePane,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[600px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginGovernancePane>

export default meta
type Story = StoryObj<typeof meta>

const seedView = (governanceView: string) => async () => {
  resetStore(usePluginsStore)
  seedStore(usePluginsStore, { governanceView: governanceView as never })
  await seedDb(async (db) => {
    await db.plugins.bulkPut(samplePluginRows())
  })
  return () => resetStore(usePluginsStore)
}

export const Permissions: Story = { beforeEach: seedView("permissions") }
export const ScheduledJobs: Story = { beforeEach: seedView("scheduled") }
export const Analytics: Story = { beforeEach: seedView("analytics") }
export const AuditLog: Story = { beforeEach: seedView("audit") }
export const Policy: Story = { beforeEach: seedView("policy") }
