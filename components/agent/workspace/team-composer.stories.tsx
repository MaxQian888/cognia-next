import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TeamComposer } from "./team-composer"
import { buildMentionableTargets } from "@/lib/agent-team/runtime-targets"
import { buildTeammate } from "@/lib/storybook/fixtures/agent-team"

const mentionables = buildMentionableTargets([
  buildTeammate({ id: "tm-coder", name: "Coder", role: "teammate", config: { runtime: "codex" } }),
])

const meta = {
  title: "Agent/Workspace/TeamComposer",
  component: TeamComposer,
  parameters: { layout: "fullscreen" },
  args: {
    mentionables,
    onSend: fn(),
    onStop: fn(),
  },
} satisfies Meta<typeof TeamComposer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// Streaming banner with a stop button above the textarea.
export const Streaming: Story = {
  args: { isStreaming: true },
}

export const Disabled: Story = {
  args: { disabled: true },
}
