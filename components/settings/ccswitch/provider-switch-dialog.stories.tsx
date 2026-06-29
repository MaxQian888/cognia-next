import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ProviderSwitchDialog } from "./provider-switch-dialog"
import type { CcswitchProvider } from "@/types/ccswitch"

// Confirmation dialog for propagating a CCSwitch provider to other agents
// (Claude Code / Codex / Gemini / OpenCode). Planning + apply are Tauri-backed;
// in the browser the agent checkboxes render and the plan resolves empty.
const provider: CcswitchProvider = {
  id: "prov-anthropic",
  name: "Anthropic (work)",
  kind: "claude",
  baseUrl: "https://api.anthropic.com",
  model: "claude-opus-4",
}

const meta = {
  title: "Settings/CcSwitch/ProviderSwitchDialog",
  component: ProviderSwitchDialog,
  parameters: { layout: "centered" },
  args: { provider, open: true, onOpenChange: fn(), onApplied: fn() },
} satisfies Meta<typeof ProviderSwitchDialog>

export default meta
type Story = StoryObj<typeof meta>

// Open with no agents pre-selected.
export const Open: Story = {}

// Open with Claude Code + Codex pre-selected.
export const WithInitialAgents: Story = {
  args: { initialAgents: ["claude-code", "codex"] },
}

// Closed.
export const Closed: Story = {
  args: { open: false },
}
