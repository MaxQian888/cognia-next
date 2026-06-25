import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { WriteCard } from "./write-card"

function makePart(input: unknown): ToolUIPart {
  return {
    type: "tool-Write",
    toolCallId: "write-1",
    state: "output-available",
    input,
    output: "File written",
  } as unknown as ToolUIPart
}

const CONTENT = `export const config = {
  name: "cognia",
  version: "1.0.0",
  features: ["chat", "workflows", "twin"],
}
`

const meta = {
  title: "Chat/MCP/WriteCard",
  component: WriteCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof WriteCard>

export default meta
type Story = StoryObj<typeof meta>

// Path header with line count + highlighted preview of the written content.
export const Default: Story = {
  args: {
    part: makePart({ file_path: "lib/config.ts", content: CONTENT }),
  },
}

// Content longer than the 4k preview cap — shows the "truncated" notice.
export const Truncated: Story = {
  args: {
    part: makePart({
      file_path: "data/seed.json",
      content: `${"x".repeat(4_100)}\n`,
    }),
  },
}
