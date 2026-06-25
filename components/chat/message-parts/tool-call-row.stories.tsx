import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import type { ToolUIPart } from "ai"

import { ToolCallRow } from "./tool-call-row"

const editPart: ToolUIPart = {
  type: "tool-Edit",
  toolCallId: "call-edit",
  state: "output-available",
  input: {
    file_path: "/Users/dev/app/components/chat/message-parts/tool-call-row.tsx",
    old_string: "const open = false",
    new_string: "const open = controlled ? expanded : internalOpen\nconst extra = true",
  },
  output: "Applied edit",
} as unknown as ToolUIPart

const runningBash: ToolUIPart = {
  type: "tool-Bash",
  toolCallId: "call-bash",
  state: "input-available",
  input: { command: "pnpm test:coverage" },
} as unknown as ToolUIPart

const failedGrep: ToolUIPart = {
  type: "tool-Grep",
  toolCallId: "call-grep",
  state: "output-error",
  input: { pattern: "useUnknownHook" },
  errorText: "ripgrep exited with code 2: regex parse error: unclosed group",
} as unknown as ToolUIPart

const meta = {
  title: "Chat/MessageParts/ToolCallRow",
  component: ToolCallRow,
  parameters: { layout: "padded" },
  args: { onToggle: fn() },
} satisfies Meta<typeof ToolCallRow>

export default meta
type Story = StoryObj<typeof meta>

// Completed Edit — diff result chip (+2 −1), uncontrolled toggle.
export const CompletedEdit: Story = {
  args: { part: editPart },
}

// In-flight Bash — pulsing "running" glyph, controlled-open showing ToolBody.
export const RunningExpanded: Story = {
  args: { part: runningBash, expanded: true },
}

// Errored Grep — red error glyph + first error line as the chip.
export const Errored: Story = {
  args: { part: failedGrep },
}
