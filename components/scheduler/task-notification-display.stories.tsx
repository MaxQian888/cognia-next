import type { Meta, StoryObj } from "@storybook/nextjs"

import { TaskNotificationDisplay } from "./task-notification-display"
import { makeNotificationConfig } from "@/lib/storybook/fixtures/scheduler"

// `TaskNotificationDisplay` is a pure read-only card summarizing a task's
// notification channels and "notify on" mode. Stories exercise each derived
// mode (always / failure-only / success-only / never) plus the undefined case.
const meta = {
  title: "Scheduler/TaskNotificationDisplay",
  component: TaskNotificationDisplay,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskNotificationDisplay>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    notification: makeNotificationConfig(),
  },
}

export const AllChannels: Story = {
  args: {
    notification: makeNotificationConfig({
      onComplete: true,
      onError: true,
      channels: ["desktop", "toast", "webhook"],
    }),
  },
}

export const FailureOnly: Story = {
  args: {
    notification: makeNotificationConfig({
      onComplete: false,
      onError: true,
      channels: ["desktop"],
    }),
  },
}

export const SuccessOnly: Story = {
  args: {
    notification: makeNotificationConfig({
      onComplete: true,
      onError: false,
      channels: ["toast"],
    }),
  },
}

export const Disabled: Story = {
  args: {
    notification: makeNotificationConfig({
      onComplete: false,
      onError: false,
      channels: [],
    }),
  },
}

export const Undefined: Story = {
  args: {
    notification: undefined,
  },
}
