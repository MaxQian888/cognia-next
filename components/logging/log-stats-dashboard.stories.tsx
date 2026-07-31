import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LogStatsDashboard } from "./log-stats-dashboard"
import { makeLogStream } from "@/lib/storybook/fixtures/logging"

// Pure: Recharts analytics over `logs` (level pie, volume area, module bar,
// top errors). Empty `logs` renders the no-data placeholder.
const meta = {
  title: "Logging/LogStatsDashboard",
  component: LogStatsDashboard,
  parameters: { layout: "fullscreen" },
  args: {
    logs: makeLogStream(160),
    logRate: 24,
    onSearchFilter: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-full overflow-auto">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LogStatsDashboard>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

export const Empty: Story = { args: { logs: [], logRate: 0 } }
