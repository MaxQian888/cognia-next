import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ExternalAgentSelector } from "./selector"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"

const now = "2026-06-29T00:00:00.000Z"

const agent = (
  id: string,
  name: string,
  over: Partial<StoredExternalAgentConfig> = {}
): StoredExternalAgentConfig => ({
  id,
  name,
  protocol: "acp",
  transport: "stdio",
  enabled: true,
  createdAt: now,
  updatedAt: now,
  ...over,
})

const meta = {
  title: "Agent/ExternalAgent/Selector",
  component: ExternalAgentSelector,
  args: {
    selectedAgentId: null,
    onAgentChange: fn(),
    onOpenSettings: fn(),
  },
  beforeEach: () => {
    resetStore(useExternalAgentStore)
  },
} satisfies Meta<typeof ExternalAgentSelector>

export default meta
type Story = StoryObj<typeof meta>

// No configured agents → trigger shows the built-in fallback label.
export const BuiltInDefault: Story = {}

export const WithAgents: Story = {
  decorators: [
    (Story) => {
      seedStore(useExternalAgentStore, {
        agents: {
          a1: agent("a1", "Claude Code"),
          a2: agent("a2", "Codex", { protocol: "codex-app-server" }),
        },
        connectionStatus: { a1: "connected", a2: "disconnected" },
      })
      return <Story />
    },
  ],
  args: { selectedAgentId: "a1" },
}

// Globally disabled → the selector renders a disabled, tooltip-only button.
export const Disabled: Story = {
  decorators: [
    (Story) => {
      seedStore(useExternalAgentStore, { enabled: false })
      return <Story />
    },
  ],
}
