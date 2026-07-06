import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CommandEditorDialog } from "./command-editor-dialog"
import type { SlashCommand } from "@/lib/slash-commands/builtin"

// Create / edit a custom slash-command markdown file. Persistence is Tauri
// (`@tauri-apps/plugin-fs`); in the browser the form shows a read-only banner.
// `initial` pre-populates the form when editing.
const existing: SlashCommand = {
  name: "review",
  description: "Review the current diff and summarise risks",
  scope: "user",
  argumentHint: "<paths>",
  model: "claude-opus-4",
  allowedTools: ["Read", "Grep"],
  template: "Review the staged changes:\n\n$ARGUMENTS",
  filePath: "/home/max/.claude/commands/review.md",
}

const meta = {
  title: "Settings/SlashCommands/CommandEditorDialog",
  component: CommandEditorDialog,
  parameters: { layout: "centered" },
  args: { open: true, onOpenChange: fn(), onSaved: fn() },
} satisfies Meta<typeof CommandEditorDialog>

export default meta
type Story = StoryObj<typeof meta>

// Create mode: blank form (web shows the read-only banner).
export const Create: Story = {
  args: { initial: null },
}

// Edit mode: form pre-filled from an existing command.
export const Edit: Story = {
  args: { initial: existing, cwd: "/home/max/projects/demo" },
}

// Closed.
export const Closed: Story = {
  args: { open: false },
}
