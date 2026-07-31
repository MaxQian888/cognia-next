import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { ChangeItem } from "./change-item"
import type { GitFileChange, GitFileStatus } from "@/types/git"

const change = (status: GitFileStatus, over: Partial<GitFileChange> = {}): GitFileChange => ({
  path: "src/components/chat/composer.tsx",
  origPath: null,
  status,
  staged: false,
  group: "changes",
  ...over,
})

const meta = {
  title: "SourceControl/ChangeItem",
  component: ChangeItem,
  args: {
    change: change("modified"),
    selected: false,
    onSelect: fn(),
    onStage: fn(),
    onUnstage: fn(),
    onDiscard: fn(),
    onCopyPath: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ChangeItem>

export default meta
type Story = StoryObj<typeof meta>

export const Modified: Story = {}
export const Added: Story = { args: { change: change("added") } }
export const Deleted: Story = { args: { change: change("deleted") } }
export const Untracked: Story = {
  args: { change: change("untracked"), onAddToGitignore: fn() },
}
export const Renamed: Story = {
  args: {
    change: change("renamed", {
      path: "src/components/chat/message-composer.tsx",
      origPath: "src/components/chat/composer.tsx",
    }),
  },
}
export const Selected: Story = { args: { selected: true } }

export const AllStatuses: Story = {
  render: (args) => (
    <div className="w-80 rounded-md border p-1">
      {(["modified", "added", "deleted", "renamed", "untracked", "conflicted"] as const).map(
        (s) => (
          <ChangeItem key={s} {...args} change={change(s, { path: `src/${s}-file.ts` })} />
        )
      )}
    </div>
  ),
}
