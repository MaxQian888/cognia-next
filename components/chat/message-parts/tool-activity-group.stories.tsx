import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"
import type { ToolUIPart } from "ai"

import {
  ToolActivityGroup,
  type ToolActivityChildOptions,
  type ToolActivityGroupEntry,
} from "./tool-activity-group"

const part = (
  type: string,
  state: ToolUIPart["state"],
  input: Record<string, unknown>,
  output?: unknown
): ToolUIPart =>
  ({
    type,
    toolCallId: `${type}-${Math.random().toString(36).slice(2, 7)}`,
    state,
    input,
    ...(output !== undefined ? { output } : {}),
  }) as unknown as ToolUIPart

const entries: ToolActivityGroupEntry[] = [
  {
    key: "e1",
    part: part("tool-Read", "output-available", { file_path: "/app/lib/claude/adapter.ts" }, "ok"),
  },
  {
    key: "e2",
    part: part("tool-Grep", "output-available", { pattern: "resolveSendOptions" }, "12 matches"),
  },
  {
    key: "e3",
    part: part(
      "tool-Edit",
      "output-available",
      { file_path: "/app/lib/claude/build-options.ts", old_string: "a", new_string: "a\nb\nc" },
      "edited"
    ),
  },
  {
    key: "e4",
    part: part("tool-Bash", "input-available", { command: "pnpm typecheck" }),
  },
]

// Every mode routes its children through renderChild; a minimal placeholder is
// enough to exercise the group chrome in the story. It reflects whichever
// open-state channel the group is driving so both are visible here.
const renderChild = (p: ToolUIPart, key: string, opts: ToolActivityChildOptions): ReactNode => (
  <button
    key={key}
    type="button"
    onClick={opts.onToggle}
    className="block w-full rounded-md border bg-muted/30 px-2.5 py-1.5 text-left text-sm"
    data-state={p.state}
  >
    <span className="font-mono text-xs text-muted-foreground">{p.type}</span>
    {opts.expanded || opts.forceOpen ? (
      <span className="ml-2 text-xs text-muted-foreground">— open</span>
    ) : null}
  </button>
)

const meta = {
  title: "Chat/MessageParts/ToolActivityGroup",
  component: ToolActivityGroup,
  parameters: { layout: "padded" },
  args: { entries, renderChild },
} satisfies Meta<typeof ToolActivityGroup>

export default meta
type Story = StoryObj<typeof meta>

// Simplified — collapsed by default; children get controlled open state.
export const Simplified: Story = {
  args: { mode: "simplified" },
}

// Standard — expanded by default; children get forceOpen + a remount key.
export const Standard: Story = {
  args: { mode: "standard" },
}
