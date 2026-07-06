import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginDetail } from "./plugin-detail"

// `PluginDetail` reads a `pluginScheduledJobs` row from Dexie by `jobId` and
// shows its cron/handler/args plus a deep link into plugin settings and recent
// runs. With no seeded job the live query resolves to `undefined`, so the panel
// renders its "plugin job not found" fallback.
const meta = {
  title: "Scheduler/Details/PluginDetail",
  component: PluginDetail,
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
} satisfies Meta<typeof PluginDetail>

export default meta
type Story = StoryObj<typeof meta>

// Job id with no backing row → "not found" fallback.
export const NotFound: Story = {
  args: {
    jobId: "plugin-job-missing",
  },
}
