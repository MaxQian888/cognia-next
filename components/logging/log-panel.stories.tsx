import type { Meta, StoryObj } from "@storybook/nextjs"

import { LogPanel } from "./log-panel"

// Full log-viewing orchestrator (toolbar + timeline + virtualized list + stats
// bar + detail panel). It subscribes to the in-memory log stream via
// `useLogStream`; in Storybook the buffer starts empty, so the panel renders
// its chrome with the empty list state. Sized + fullscreen per shell rules.
const meta = {
  title: "Logging/LogPanel",
  component: LogPanel,
  parameters: { layout: "fullscreen" },
  args: {
    showStats: true,
    showTimeline: true,
    includeAgentTrace: true,
    defaultAutoRefresh: false,
  },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LogPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const GroupedByTrace: Story = {
  args: { groupByTraceId: true },
}
