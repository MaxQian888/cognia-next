import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConnectorQueueDetail } from "./connector-queue-detail"

// `ConnectorQueueDetail` aggregates the outbound-queue length and circuit
// breaker open/close timestamps from Dexie, plus a list of recent dispatches
// via `useUnifiedRecentRuns`. With an empty DB it renders a zero-length queue,
// "-" breaker timestamps, and an empty "No recent dispatches" section — the
// healthy idle state.
const meta = {
  title: "Scheduler/Details/ConnectorQueueDetail",
  component: ConnectorQueueDetail,
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
} satisfies Meta<typeof ConnectorQueueDetail>

export default meta
type Story = StoryObj<typeof meta>

// Empty queue, no breaker events, no recent dispatches.
export const Default: Story = {}
