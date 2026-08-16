import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentRuntimeSelector } from "./runtime-selector"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

const meta = {
  title: "Agent/Mode/RuntimeSelector",
  component: AgentRuntimeSelector,
  beforeEach: () => {
    resetStore(useAgentRuntimeStore)
    resetStore(useExternalAgentStore)
  },
} satisfies Meta<typeof AgentRuntimeSelector>

export default meta
type Story = StoryObj<typeof meta>

// Default runtime: bundled Claude SDK sidecar.
export const ClaudeSdk: Story = {}

// A stale external selection (the agent it named is gone) — the chip repairs
// itself back to the built-in runtime rather than sitting on a lane that
// cannot dispatch.
export const ExternalSelectionRepaired: Story = {
  decorators: [
    (Story) => {
      seedStore(useAgentRuntimeStore, { runtime: "external", externalAgentId: "missing" })
      return <Story />
    },
  ],
}

export const Disabled: Story = {
  args: { disabled: true },
}
