import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkspaceReview } from "./workspace-review"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useGitStore } from "@/stores/git/git-store"
import { fileDiffKey } from "@/types/git"
import { makeDiff, makeDirtyStatus, makeGitActions } from "@/lib/storybook/fixtures/source-control"

const status = makeDirtyStatus()
const selected = { path: "components/source-control/diff-pane.tsx", staged: false }

// The diff pane reads its diff from the store cache; seed one per reviewable
// file so stepping through files works without a backend.
function seedDiffs() {
  resetStore(useGitStore)
  const entries = [
    ...status.merge.map((c) => ({ path: c.path, staged: false })),
    ...status.staged.map((c) => ({ path: c.path, staged: true })),
    ...status.changes.map((c) => ({ path: c.path, staged: false })),
  ]
  const diffCache = Object.fromEntries(
    entries.map((e) => [fileDiffKey(e.path, e.staged), makeDiff({ path: e.path })])
  )
  seedStore(useGitStore, { diffCache, diffCacheOrder: Object.keys(diffCache), status })
}

const meta = {
  title: "Artifacts/Workspace/WorkspaceReview",
  component: WorkspaceReview,
  args: {
    rootPath: "/repo",
    status,
    actions: makeGitActions(),
    committing: false,
    selected,
    onSelect: fn(),
    layout: "desktop",
    onSendToChat: fn(),
    onOpenInEditor: fn(),
  },
  parameters: { layout: "fullscreen" },
  beforeEach: () => seedDiffs(),
} satisfies Meta<typeof WorkspaceReview>

export default meta
type Story = StoryObj<typeof meta>

/** A wide dock: list and diff side by side. */
export const Wide: Story = {
  decorators: [
    (Story) => (
      <div className="h-[560px] w-[960px]">
        <Story />
      </div>
    ),
  ],
}

/** The dock at its 480px floor: one pane at a time, opened on a revealed file. */
export const NarrowDock: Story = {
  args: { focus: { id: "reveal-1", file: selected } },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-[480px]">
        <Story />
      </div>
    ),
  ],
}

/** A phone: the list first, touch density. */
export const Phone: Story = {
  args: { layout: "mobile" },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-[390px]">
        <Story />
      </div>
    ),
  ],
}
