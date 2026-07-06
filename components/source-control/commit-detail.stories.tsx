import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CommitDetail } from "./commit-detail"
import { makeCommit, makeGitActions } from "@/lib/storybook/fixtures/source-control"

// The metadata header + reset/rewrite dropdown render from the `commit` prop.
// The changed-file list is fetched from the backend (empty in Storybook), so
// the file column shows its empty state and the diff pane shows "select file".
const meta = {
  title: "SourceControl/CommitDetail",
  component: CommitDetail,
  args: {
    rootDir: "/repo",
    commit: makeCommit({
      summary: "feat(source-control): add interactive rebase planner",
      body: "Lists commits in base..HEAD with per-row actions.\n\nApply runs `git rebase -i`.",
    }),
    actions: makeGitActions(),
    onViewBlame: fn(),
    onInteractiveRebase: fn(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[520px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CommitDetail>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const NoBody: Story = {
  args: { commit: makeCommit({ summary: "chore: bump dependencies", body: "" }) },
}

export const ReadOnly: Story = {
  name: "Without actions (read-only)",
  args: { actions: undefined, onViewBlame: undefined, onInteractiveRebase: undefined },
}
