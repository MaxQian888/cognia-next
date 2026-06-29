import type { Meta, StoryObj } from "@storybook/nextjs"

import { BrowserAgentIndicator } from "./browser-agent-indicator"

// Presentational badge showing who is driving the browser preview (human vs the
// agent), with the agent's last raw action appended when present.
const meta = {
  title: "Browser/BrowserAgentIndicator",
  component: BrowserAgentIndicator,
  args: { driver: "human", lastAction: null },
  parameters: { layout: "centered" },
} satisfies Meta<typeof BrowserAgentIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const Human: Story = {}

export const AgentDriving: Story = {
  args: { driver: "agent", lastAction: "click e3" },
}
