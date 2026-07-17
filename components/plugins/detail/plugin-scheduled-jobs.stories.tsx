import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginScheduledJobs, type PluginScheduledJobView } from "./plugin-scheduled-jobs"

// Table of plugin-contributed scheduled jobs (cron / next-run / last-run /
// status) with sortable columns and a status filter. The `jobsOverride` prop
// bypasses the Dexie live query, so every variant here is fully prop-driven.

const now = Date.parse("2025-06-20T12:00:00.000Z")

const makeJob = (over: Partial<PluginScheduledJobView> = {}): PluginScheduledJobView => ({
  id: "job-1",
  pluginId: "com.acme.web-tools",
  cron: "0 */6 * * *",
  handler: "refreshIndex",
  status: "active",
  lastRunAt: now - 6 * 3_600_000,
  nextRunAt: now + 6 * 3_600_000,
  ...over,
})

const JOBS: PluginScheduledJobView[] = [
  makeJob(),
  makeJob({
    id: "job-2",
    handler: "syncCache",
    cron: "*/15 * * * *",
    status: "paused",
    nextRunAt: undefined,
  }),
  makeJob({
    id: "job-3",
    pluginId: "com.acme.ocr",
    handler: "reindexDocs",
    cron: "0 3 * * *",
    status: "disabled",
    nextRunAt: now + 86_400_000,
  }),
]

// `PluginScheduledJobs` takes all-optional props (default `{}`), so anchor the
// story args to an explicit type rather than relying on component-props
// inference.
type Args = { jobsOverride?: PluginScheduledJobView[]; pluginId?: string }

const meta: Meta<Args> = {
  title: "Plugins/Detail/PluginScheduledJobs",
  component: PluginScheduledJobs,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[760px] max-w-full">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<Args>

// Mixed active / paused / errored jobs across two plugins.
export const AllJobs: Story = {
  args: { jobsOverride: JOBS },
}

// Scoped to a single plugin via `pluginId`.
export const ScopedToPlugin: Story = {
  args: { jobsOverride: JOBS, pluginId: "com.acme.web-tools" },
}

// No jobs → the empty state.
export const Empty: Story = {
  args: { jobsOverride: [] },
}
