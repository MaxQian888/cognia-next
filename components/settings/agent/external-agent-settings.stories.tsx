import type { Meta, StoryObj } from "@storybook/nextjs"

import { ExternalAgentSettings } from "./external-agent-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

// `ExternalAgentSettings` is the full management surface for external agents:
// global toggles, rule-based delegation, the quick-start preset gallery, and
// the configured-agent list. It reads `useExternalAgentStore` and drives the
// `useExternalAgent` connection hook (which lazily imports the manager and
// degrades gracefully on the web preview, where no agent process can spawn).
const sampleAgents = {
  "agent-claude": {
    id: "agent-claude",
    name: "Claude Code",
    protocol: "acp",
    transport: "stdio",
    process: { command: "npx", args: ["@anthropic-ai/claude-code", "--stdio"] },
    description: "Local Claude Code via the ACP shim.",
    enabled: true,
  },
}

const meta = {
  title: "Settings/Agent/ExternalAgentSettings",
  component: ExternalAgentSettings,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useExternalAgentStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExternalAgentSettings>

export default meta
type Story = StoryObj<typeof meta>

// Enabled, no agents configured yet — preset gallery + "add an agent" prompt.
export const Default: Story = {}

// One configured agent (disconnected on the web preview).
export const WithAgent: Story = {
  beforeEach: () => {
    resetStore(useExternalAgentStore)
    seedStore(useExternalAgentStore, {
      enabled: true,
      agents: sampleAgents,
    } as never)
  },
}

// Master switch off — dependent controls are disabled.
export const Disabled: Story = {
  beforeEach: () => {
    resetStore(useExternalAgentStore)
    seedStore(useExternalAgentStore, { enabled: false } as never)
  },
}
