import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CommandEditorDialog } from "./command-editor-dialog"
import type { SlashCommand } from "@/lib/slash-commands/builtin"

// Create / edit a custom slash-command markdown file. Persistence is the
// desktop filesystem, or the workspace filesystem on a paired browser or
// phone. Which scopes are writable is passed in by the section, so the stories
// set it explicitly. `initial` pre-populates the form when editing.
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
  args: {
    open: true,
    onOpenChange: fn(),
    onSaved: fn(),
    projectWritable: true,
    globalWritable: true,
  },
} satisfies Meta<typeof CommandEditorDialog>

export default meta
type Story = StoryObj<typeof meta>

// Create mode: blank form.
export const Create: Story = {
  args: { initial: null },
}

// A paired browser or phone: the project scope is writable, the user-global one
// is not, and the scope picker says which is which instead of hiding either.
export const CompanionProjectOnly: Story = {
  args: {
    initial: null,
    cwd: "/home/max/projects/demo",
    projectWritable: true,
    globalWritable: false,
  },
}

// Nothing paired: neither scope can be written, so the whole form is read-only.
export const NoWritableScope: Story = {
  args: { initial: null, projectWritable: false, globalWritable: false },
}

// Edit mode: form pre-filled from an existing command.
export const Edit: Story = {
  args: { initial: existing, cwd: "/home/max/projects/demo" },
}

// Closed.
export const Closed: Story = {
  args: { open: false },
}
