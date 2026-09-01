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

// The default lane, described by the engine that will really serve the turn.
export const BuiltinAnthropic: Story = { args: { providerId: "anthropic" } }

// Same lane, different engine. The row used to claim the Anthropic SDK sidecar
// here too, which was wrong for every non-anthropic provider.
export const BuiltinAiSdk: Story = { args: { providerId: "deepseek" } }

// A stale external selection (the agent it named is gone). The chip repairs
// itself back to the builtin runtime rather than sitting on a lane that cannot
// dispatch.
export const ExternalSelectionRepaired: Story = {
  decorators: [
    (Story) => {
      seedStore(useAgentRuntimeStore, {
        runtimeRef: { kind: "external", agentId: "missing" },
      })
      return <Story />
    },
  ],
}

export const Disabled: Story = {
  args: { disabled: true },
}
