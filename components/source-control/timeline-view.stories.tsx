import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TimelineView } from "./timeline-view"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useGitStore } from "@/stores/git/git-store"
import { makeHistory } from "@/lib/storybook/fixtures/source-control"

// TimelineView reads the commit pages from the git store (the backend fetch is
// unavailable in Storybook, so we seed the pages directly). The list/graph
// toggle is local state; the graph derives lanes from the seeded commits.
const history = makeHistory(12)

const meta = {
  title: "SourceControl/TimelineView",
  component: TimelineView,
  args: {
    open: true,
    onOpenChange: fn(),
    rootDir: "/repo",
    filePath: null,
  },
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, { timelineRepo: history })
  },
} satisfies Meta<typeof TimelineView>

export default meta
type Story = StoryObj<typeof meta>

export const RepoHistory: Story = {}

export const WithSelectedCommit: Story = {
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, { timelineRepo: history, selectedCommit: history[2].hash })
  },
}

export const FileHistory: Story = {
  args: { filePath: "components/source-control/diff-pane.tsx" },
  beforeEach: () => {
    resetStore(useGitStore)
    seedStore(useGitStore, {
      timelineScope: "file",
      timelineFile: history.slice(0, 4),
    })
  },
}

export const Empty: Story = {
  beforeEach: () => {
    resetStore(useGitStore)
  },
}
