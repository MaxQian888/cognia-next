import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentRuntimeSelector } from "./runtime-selector"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useAgentRuntimeStore } from "@/stores/agent"

const meta = {
  title: "Agent/Mode/RuntimeSelector",
  component: AgentRuntimeSelector,
  beforeEach: () => {
    resetStore(useAgentRuntimeStore)
  },
} satisfies Meta<typeof AgentRuntimeSelector>

export default meta
type Story = StoryObj<typeof meta>

// Default runtime: bundled Claude SDK sidecar.
export const ClaudeSdk: Story = {}

// External runtime with no configured agent record → "unconfigured" label.
export const ExternalUnconfigured: Story = {
  decorators: [
    (Story) => {
      seedStore(useAgentRuntimeStore, { runtime: "external", externalAgentId: null })
      return <Story />
    },
  ],
}

export const Disabled: Story = {
  args: { disabled: true },
}
