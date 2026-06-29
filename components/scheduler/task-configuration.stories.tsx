import type { Meta, StoryObj } from "@storybook/nextjs"

import { TaskConfiguration } from "./task-configuration"
import {
  makeScheduledTask,
  makeExecutionConfig,
  FIXTURE_NOW,
} from "@/lib/storybook/fixtures/scheduler"

// `TaskConfiguration` is a pure, props-only read-only card summarizing a task's
// trigger, timezone, retry/timeout, overlap policy, and any optional lifecycle
// limits (end date, max runs, auto-pause, catch-up window, jitter). Stories
// vary the trigger kind and which optional limits are configured.
const meta = {
  title: "Scheduler/TaskConfiguration",
  component: TaskConfiguration,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[520px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskConfiguration>

export default meta
type Story = StoryObj<typeof meta>

// A weekday cron task with the default execution config.
export const CronTask: Story = {
  args: {
    task: makeScheduledTask({
      trigger: { type: "cron", cronExpression: "0 9 * * 1-5", timezone: "America/New_York" },
    }),
  },
}

// An interval trigger — schedule shows the cadence in minutes.
export const IntervalTask: Story = {
  args: {
    task: makeScheduledTask({
      trigger: { type: "interval", intervalMs: 15 * 60_000, timezone: "UTC" },
    }),
  },
}

// A one-time task scheduled for a specific instant.
export const OnceTask: Story = {
  args: {
    task: makeScheduledTask({
      trigger: { type: "once", runAt: new Date(FIXTURE_NOW + 2 * 86_400_000) },
    }),
  },
}

// An event-driven task — schedule column shows the event type.
export const EventTask: Story = {
  args: {
    task: makeScheduledTask({
      trigger: { type: "event", eventType: "workflow.completed" },
    }),
  },
}

// Every optional lifecycle limit configured — exercises all conditional rows.
export const WithLifecycleLimits: Story = {
  args: {
    task: makeScheduledTask({
      runCount: 7,
      endAt: new Date(FIXTURE_NOW + 30 * 86_400_000),
      trigger: { type: "cron", cronExpression: "0 2 * * *", timezone: "UTC", jitterMs: 45_000 },
      config: makeExecutionConfig({
        maxRetries: 5,
        timeout: 120_000,
        maxRuns: 100,
        pauseAfterConsecutiveFailures: 3,
        catchupWindowMs: 30 * 60_000,
      }),
    }),
  },
}
