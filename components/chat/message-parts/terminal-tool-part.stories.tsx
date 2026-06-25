import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { TerminalToolPart } from "./terminal-tool-part"

const bashPart = (state: ToolUIPart["state"], extra: Record<string, unknown> = {}): ToolUIPart =>
  ({
    type: "tool-Bash",
    toolCallId: "call-1",
    state,
    input: { command: "pnpm test -- terminal-tool-part" },
    ...extra,
  }) as unknown as ToolUIPart

const meta = {
  title: "Chat/MessageParts/TerminalToolPart",
  component: TerminalToolPart,
  parameters: { layout: "padded" },
} satisfies Meta<typeof TerminalToolPart>

export default meta
type Story = StoryObj<typeof meta>

// Running — live terminal view streaming stdout while the call is in flight.
export const Running: Story = {
  args: {
    part: bashPart("input-available", {
      output: { stdout: "PASS  terminal-tool-part.test.tsx\n", stderr: "" },
    }),
  },
}

// Completed — falls back to the structured ToolBody once the result lands.
export const Completed: Story = {
  args: {
    part: bashPart("output-available", {
      output: "Tests:       8 passed, 8 total\nTime:        2.1 s\n",
    }),
  },
}
