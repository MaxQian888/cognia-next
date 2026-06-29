import type { Meta, StoryObj } from "@storybook/nextjs"

import { VersionHistory } from "./version-history"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeVersion } from "@/lib/storybook/fixtures/eval"

// Immutable dataset snapshots, newest-first (`useEvalDatasetVersions`). Each row
// shows version, short content hash, case count, and an optional tag.
const meta = {
  title: "Eval/VersionHistory",
  component: VersionHistory,
  parameters: { layout: "padded" },
  args: { datasetId: "ds-1" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VersionHistory>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.evalDatasetVersions.bulkPut([
        makeVersion({ id: "ver-3", version: 3, tag: "prod", casesHash: "aa11bb22cc33dd44" }),
        makeVersion({ id: "ver-2", version: 2, casesHash: "ee55ff66aa77bb88" }),
        makeVersion({ id: "ver-1", version: 1, casesHash: "1122334455667788" }),
      ])
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
