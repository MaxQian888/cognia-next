import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ExternalMemoryRow } from "./external-memory-row"
import type { ExternalMemoryFile } from "@/lib/memory/external/types"

function file(over: Partial<ExternalMemoryFile> = {}): ExternalMemoryFile {
  return {
    id: "claude-user",
    agent: "claude-code",
    scope: "user",
    absPath: "/Users/ada/.claude/CLAUDE.md",
    label: "CLAUDE.md",
    editable: true,
    exists: true,
    bytes: 4096,
    ...over,
  }
}

// One external agent-memory file in the `/memory` → external tab. The whole row
// is a button that opens the viewer/editor.
const meta = {
  title: "Memory/ExternalMemoryRow",
  component: ExternalMemoryRow,
  args: { file: file(), onOpen: fn() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[32rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExternalMemoryRow>

export default meta
type Story = StoryObj<typeof meta>

export const Editable: Story = {}

export const ReadOnly: Story = {
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

export const NotCreated: Story = {
  args: { file: file({ id: "claude-project", scope: "project", exists: false, bytes: undefined }) },
}
