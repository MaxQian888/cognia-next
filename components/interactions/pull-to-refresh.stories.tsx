import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PullToRefresh } from "./pull-to-refresh"

// Wraps a scrollable list and fires `onRefresh` when pulled down from the top.
// Drag the content downward to reveal the spinner row.
const meta = {
  title: "Interactions/PullToRefresh",
  component: PullToRefresh,
  args: { onRefresh: fn(), silent: true },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[420px] w-[360px] border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PullToRefresh>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: (
      <ul className="divide-y">
        {Array.from({ length: 20 }, (_, i) => (
          <li key={i} className="px-4 py-3 text-sm">
            List item {i + 1}
          </li>
        ))}
      </ul>
    ),
  },
}
