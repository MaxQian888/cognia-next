import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiffPane } from "./diff-pane"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useGitStore } from "@/stores/git/git-store"
import { fileDiffKey } from "@/types/git"
import { makeDiff, makeGitActions } from "@/lib/storybook/fixtures/source-control"

const ROOT = "/repo"
const PATH = "src/lib/greet.ts"

// DiffPane reads the diff from the store's LRU cache during render and only
// fetches on a cache miss. Seeding the cache renders the Monaco diff without a
// backend; leaving it empty shows the "select a file" fallback.
function seedDiff(staged: boolean) {
  resetStore(useGitStore)
  const key = fileDiffKey(PATH, staged)
  seedStore(useGitStore, {
    diffCache: { [key]: makeDiff({ path: PATH }) },
    diffCacheOrder: [key],
  })
}

const meta = {
  title: "SourceControl/DiffPane",
  component: DiffPane,
  args: {
    rootDir: ROOT,
    path: PATH,
    staged: false,
    actions: makeGitActions(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[520px] w-full">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => seedDiff(false),
} satisfies Meta<typeof DiffPane>

export default meta
type Story = StoryObj<typeof meta>

export const Unstaged: Story = {}

export const Staged: Story = {
  args: { staged: true },
  beforeEach: () => seedDiff(true),
}

export const NoCachedDiff: Story = {
  beforeEach: () => {
    resetStore(useGitStore)
  },
}
