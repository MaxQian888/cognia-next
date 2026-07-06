import type { Meta, StoryObj } from "@storybook/nextjs"

import { ExecutionMonitorPanel } from "./execution-monitor-panel"
import { __resetExecutionBrokerForTesting, getExecutionBroker } from "@/lib/execution/broker"

// Single "what is running right now" surface: broker legs + active workflow
// runs + scheduler executions, with per-leg cancel. The Running story registers
// a few broker legs; the Empty story resets the broker.
const meta = {
  title: "Execution/ExecutionMonitorPanel",
  component: ExecutionMonitorPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[520px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExecutionMonitorPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {
  beforeEach: async () => {
    __resetExecutionBrokerForTesting()
    const broker = getExecutionBroker()
    await broker.acquire({
      kind: "chat",
      label: "Chat turn — refactor renderer",
      sessionId: "ses_1",
    })
    await broker.acquire({ kind: "subagent", label: "Subagent — search the codebase" })
    await broker.acquire({ kind: "connector", label: "WeCom auto-reply" })
  },
}

export const Empty: Story = {
  beforeEach: () => {
    __resetExecutionBrokerForTesting()
  },
}
