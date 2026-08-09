import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"
import { SpawnTaskCard } from "./spawn-task-card"

const part = {
  type: "tool-spawn_task",
  toolCallId: "story-call",
  state: "output-available",
  input: {},
  output: {
    ok: true,
    taskSessionId: "story-task",
    title: "Fix retry cleanup",
    tldr: "Move the cleanup into a focused sidechat task.",
    situation: "The terminal stream event retains an abort controller.",
    codeLocations: ["hooks/chat/use-stream.ts:42"],
    solution: "Clear it in the terminal event handler.",
    caveats: ["Preserve retry behavior."],
    mode: "aside",
  },
} as unknown as ToolUIPart

const meta = {
  title: "Chat/MessageParts/McpRenderers/SpawnTaskCard",
  component: SpawnTaskCard,
  parameters: { layout: "padded" },
  args: { part, sessionId: "story-parent" },
} satisfies Meta<typeof SpawnTaskCard>

export default meta
type Story = StoryObj<typeof meta>

export const Staged: Story = {}
