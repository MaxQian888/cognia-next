import type { Meta, StoryObj } from "@storybook/nextjs"

import { HandlerBadge } from "./handler-badge"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgent } from "@/types/agent/sub-agent"

// HandlerBadge reads only `name` + `lastActivityAt` off each runtime SubAgent.
// Seed a minimal record (cast to SubAgent) so the badge picks the tracked one.
type RuntimeSeed = Record<string, Pick<SubAgent, "name" | "lastActivityAt">>

const seedRuntime = (subAgents: RuntimeSeed) => () => {
  useSubagentRuntimeStore.getState().clearRuntime()
  useSubagentRuntimeStore.setState({
    subAgents: subAgents as unknown as Record<string, SubAgent>,
  })
}

const meta = {
  title: "Chat/MessageParts/HandlerBadge",
  component: HandlerBadge,
  parameters: { layout: "padded" },
  args: { defaultLabel: "Copilot" },
} satisfies Meta<typeof HandlerBadge>

export default meta
type Story = StoryObj<typeof meta>

// No tracked subagent active → falls back to the default label (muted style).
export const Default: Story = {
  beforeEach: seedRuntime({}),
}

// A tracked specialist is the most recently active → badge shows its name.
export const Handover: Story = {
  beforeEach: seedRuntime({
    a: { name: "workflow-designer", lastActivityAt: new Date(Date.now() - 5000) },
    b: { name: "workflow-debugger", lastActivityAt: new Date() },
  }),
}
