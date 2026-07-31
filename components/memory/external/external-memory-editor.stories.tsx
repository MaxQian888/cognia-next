import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ExternalMemoryEditor } from "./external-memory-editor"
import type { ExternalMemoryFile } from "@/lib/memory/external/types"

function file(over: Partial<ExternalMemoryFile> = {}): ExternalMemoryFile {
  return {
    id: "claude-user",
    agent: "claude-code",
    scope: "user",
    absPath: "/Users/ada/.claude/CLAUDE.md",
    label: "CLAUDE.md",
    editable: true,
    // exists:false → the editor starts from an empty buffer instead of loading
    // from disk (which isn't available in Storybook), so the dialog renders the
    // editor surface cleanly.
    exists: false,
    ...over,
  }
}

// View / guarded-edit dialog for one external agent-memory file. Read-only by
// default; editable files unlock an edit mode gated by a backup confirmation.
const meta = {
  title: "Memory/ExternalMemoryEditor",
  component: ExternalMemoryEditor,
  args: {
    file: file(),
    open: true,
    onOpenChange: fn(),
    allowedRoots: ["/Users/ada/.claude"],
    onSaved: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ExternalMemoryEditor>

export default meta
type Story = StoryObj<typeof meta>

export const EditableEmpty: Story = {}

export const ReadOnlyFile: Story = {
  args: {
    file: file({
      id: "codex",
      agent: "codex",
      scope: "managed",
      editable: false,
      label: "AGENTS.md",
    }),
  },
}

export const Closed: Story = {
  args: { open: false },
}
