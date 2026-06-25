import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { ReadCard } from "./read-card"

function makePart(input: unknown, output: unknown): ToolUIPart {
  return {
    type: "tool-Read",
    toolCallId: "read-1",
    state: "output-available",
    input,
    output,
  } as unknown as ToolUIPart
}

const SOURCE = `import { cn } from "@/lib/utils"

export function Greeting({ name }: { name: string }) {
  return <h1 className={cn("text-xl")}>Hello, {name}!</h1>
}
`

const meta = {
  title: "Chat/MCP/ReadCard",
  component: ReadCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ReadCard>

export default meta
type Story = StoryObj<typeof meta>

// Plain string output (MCP text block) — highlighted from the file extension.
export const Default: Story = {
  args: {
    part: makePart({ file_path: "components/greeting.tsx" }, SOURCE),
  },
}

// Structured { lines, startLine } output plus offset/limit slice metadata.
export const WindowedLines: Story = {
  args: {
    part: makePart(
      { path: "lib/server.py", offset: 40, limit: 3 },
      { lines: ["def handler(req):", "    return ok(req.body)", ""], startLine: 40 }
    ),
  },
}

// No output yet — card shows just the path header, no code block.
export const PathOnly: Story = {
  args: {
    part: makePart({ file_path: "i18n/messages/en.json" }, ""),
  },
}
