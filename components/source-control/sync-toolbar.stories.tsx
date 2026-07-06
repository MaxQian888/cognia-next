import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SyncToolbar } from "./sync-toolbar"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useGitStore } from "@/stores/git/git-store"
import { makeCleanStatus, makeGitActions } from "@/lib/storybook/fixtures/source-control"

// SyncToolbar reads the git store for op spinners, merge state, and the
// branch/upstream pair that decides push-vs-publish. Each story reseeds.
const meta = {
  title: "SourceControl/SyncToolbar",
  component: SyncToolbar,
  args: {
    actions: makeGitActions(),
    onOpenStash: fn(),
    onOpenTimeline: fn(),
    onOpenRemotes: fn(),
    onOpenTags: fn(),
    onOpenCompare: fn(),
    onRefresh: fn(),
  },
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, { status: makeCleanStatus() })
  },
} satisfies Meta<typeof SyncToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Tracked: Story = {}

export const NeedsPublish: Story = {
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, {
      status: makeCleanStatus({ branch: "feature/no-upstream", upstream: null }),
    })
  },
}

export const Syncing: Story = {
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, {
      status: makeCleanStatus(),
      ops: { ...useGitStore.getState().ops, sync: true },
    })
  },
}

export const Merging: Story = {
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, { status: makeCleanStatus({ isMerging: true }) })
  },
}

export const SequencerInProgress: Story = {
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, {
      status: makeCleanStatus(),
      repoState: {
        isRepo: true,
        rootDir: "/repo",
        detachedHead: false,
        operationInProgress: "rebase",
      },
    })
  },
}
