import type { Meta, StoryObj } from "@storybook/nextjs"

import { TaskTagsDisplay } from "./task-tags-display"

// `TaskTagsDisplay` is a pure card that renders a task's tag pills, with an
// empty fallback. next-intl is provided by the Storybook preview.
const meta = {
  title: "Scheduler/TaskTagsDisplay",
  component: TaskTagsDisplay,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskTagsDisplay>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    tags: ["digest", "daily", "standup"],
  },
}

export const SingleTag: Story = {
  args: {
    tags: ["maintenance"],
  },
}

export const ManyTags: Story = {
  args: {
    tags: ["digest", "daily", "standup", "automation", "high-priority", "team", "ops"],
  },
}

export const Empty: Story = {
  args: {
    tags: [],
  },
}
