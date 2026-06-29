import type { Meta, StoryObj } from "@storybook/nextjs"

import { DelegationRulesSection } from "./delegation-rules-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

// `DelegationRulesSection` is a CRUD editor over the external-agent store's
// delegation rules. With no configured agents it shows the "add an agent first"
// empty state; with agents + rules it shows the priority-ordered rule list.
const sampleAgents = {
  "agent-claude": {
    id: "agent-claude",
    name: "Claude Code",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
  },
  "agent-codex": {
    id: "agent-codex",
    name: "Codex CLI",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
  },
}

const sampleRules = [
  {
    id: "rule-1",
    name: "Route refactors to Claude",
    condition: "keyword",
    matcher: "refactor",
    targetAgentId: "agent-claude",
    priority: 1,
    enabled: true,
  },
  {
    id: "rule-2",
    name: "Catch-all to Codex",
    condition: "always",
    matcher: "",
    targetAgentId: "agent-codex",
    priority: 2,
    enabled: false,
  },
]

const meta = {
  title: "Settings/Agent/DelegationRulesSection",
  component: DelegationRulesSection,
  parameters: { layout: "padded" },
  args: { disabled: false },
  beforeEach: () => {
    resetStore(useExternalAgentStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DelegationRulesSection>

export default meta
type Story = StoryObj<typeof meta>

// No agents configured — "add an agent first" empty state.
export const Empty: Story = {}

// Two agents + two rules (one disabled) showing the priority-ordered list.
export const WithRules: Story = {
  beforeEach: () => {
    resetStore(useExternalAgentStore)
    seedStore(useExternalAgentStore, {
      enabled: true,
      agents: sampleAgents,
      delegationRules: sampleRules,
    } as never)
  },
}

// The whole section disabled (master external-agents switch off).
export const Disabled: Story = {
  args: { disabled: true },
  beforeEach: () => {
    resetStore(useExternalAgentStore)
    seedStore(useExternalAgentStore, {
      agents: sampleAgents,
      delegationRules: sampleRules,
    } as never)
  },
}
