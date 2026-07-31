import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { GlobCard } from "./glob-card"

function makePart(input: unknown, output: unknown): ToolUIPart {
  return {
    type: "tool-Glob",
    toolCallId: "glob-1",
    state: "output-available",
    input,
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/GlobCard",
  component: GlobCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof GlobCard>

export default meta
type Story = StoryObj<typeof meta>

// Pattern + scope header, matches from a newline-delimited string output.
export const Default: Story = {
  args: {
    part: makePart(
      { pattern: "**/*.stories.tsx", path: "components" },
      [
        "components/chat/todo-list.stories.tsx",
        "components/chat/renderers/diff-block.stories.tsx",
        "components/chat/message-parts/mcp-renderers/read-card.stories.tsx",
      ].join("\n")
    ),
  },
}

// Structured { matches } output.
export const StructuredMatches: Story = {
  args: {
    part: makePart(
      { pattern: "src-tauri/**/*.rs" },
      { matches: ["src-tauri/src/lib.rs", "src-tauri/src/ocr/mod.rs"] }
    ),
  },
}

// Pattern with zero matches — renders the "no matches" message.
export const NoMatches: Story = {
  args: {
    part: makePart({ pattern: "**/*.elm" }, ""),
  },
}
