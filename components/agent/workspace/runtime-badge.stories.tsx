import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { RuntimeBadge } from "./runtime-badge"
import type { TeammateRuntime } from "@/types/agent/agent-team"

const RUNTIMES: TeammateRuntime[] = ["claude", "codex", "claude-code", "gemini-cli", "cursor-cli"]

const meta = {
  title: "Agent/RuntimeBadge",
  component: RuntimeBadge,
  args: { runtime: "claude" },
} satisfies Meta<typeof RuntimeBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Claude: Story = {}

export const AllRuntimes: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {RUNTIMES.map((r) => (
        <RuntimeBadge key={r} runtime={r} />
      ))}
    </div>
  ),
}

export const IconOnly: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {RUNTIMES.map((r) => (
        <RuntimeBadge key={r} runtime={r} iconOnly />
      ))}
    </div>
  ),
}
