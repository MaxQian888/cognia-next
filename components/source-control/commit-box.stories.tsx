import type { Meta, StoryObj } from "@storybook/nextjs"

import { CommitBox } from "./commit-box"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useGitStore } from "@/stores/git/git-store"
import { makeGitActions } from "@/lib/storybook/fixtures/source-control"

const ROOT = "/repo"

// CommitBox reads the per-repo draft + amend flag from the git store. The
// commit button enables only with a non-empty draft AND staged files (or amend).
const meta = {
  title: "SourceControl/CommitBox",
  component: CommitBox,
  args: {
    rootDir: ROOT,
    stagedCount: 3,
    committing: false,
    actions: makeGitActions(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-80 rounded-md border">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    resetStore(useGitStore)
  },
} satisfies Meta<typeof CommitBox>

export default meta
type Story = StoryObj<typeof meta>

export const EmptyNoStaged: Story = {
  args: { stagedCount: 0 },
}

export const WithMessage: Story = {
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, {
      commitDraft: { [ROOT]: "feat(source-control): add stash panel" },
    })
  },
}

export const Committing: Story = {
  args: { committing: true },
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, { commitDraft: { [ROOT]: "chore: bump deps" } })
  },
}

export const AmendMode: Story = {
  args: { stagedCount: 0 },
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, { commitAmend: true })
  },
}
