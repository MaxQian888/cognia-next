import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { LsCard } from "./ls-card"

function makePart(input: unknown, output: string): ToolUIPart {
  return {
    type: "tool-LS",
    toolCallId: "ls-1",
    state: "output-available",
    input,
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/LsCard",
  component: LsCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof LsCard>

export default meta
type Story = StoryObj<typeof meta>

// First output line is the resolved dir; remaining lines are entries.
export const Default: Story = {
  args: {
    part: makePart(
      { path: "components/chat" },
      [
        "/repo/components/chat",
        "message-parts/",
        "renderers/",
        "todo-list.tsx",
        "todo-list.test.tsx",
      ].join("\n")
    ),
  },
}

// Directory resolved but no entries — renders the "empty" message.
export const EmptyDirectory: Story = {
  args: {
    part: makePart({ path: "tmp/scratch" }, "/repo/tmp/scratch"),
  },
}
