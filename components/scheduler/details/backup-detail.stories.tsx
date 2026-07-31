import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { BackupDetail } from "./backup-detail"

// `BackupDetail` reads the backup auto-schedule from the settings store and
// fans recent backup runs in through `useUnifiedRecentRuns` (Dexie-backed).
// With no seeded settings it falls back to `DEFAULT_BACKUP_AUTO_SCHEDULE` and
// renders the configuration block plus an empty "No recent runs" section —
// the resilient default state the panel shows on a fresh install.
const meta = {
  title: "Scheduler/Details/BackupDetail",
  component: BackupDetail,
  parameters: { layout: "fullscreen" },
  args: {
    onSelectRun: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl border rounded-md bg-card">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BackupDetail>

export default meta
type Story = StoryObj<typeof meta>

// Default configuration with no recorded runs.
export const Default: Story = {}
