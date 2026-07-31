import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ChangesView } from "./changes-view"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useGitStore } from "@/stores/git/git-store"
import {
  makeCleanStatus,
  makeDirtyStatus,
  makeGitActions,
} from "@/lib/storybook/fixtures/source-control"

// The left pane: CommitBox over the Merge / Staged / Changes groups. Group
// expansion is read from the git store (reset to defaults before each story);
// the status itself is passed as a prop.
const meta = {
  title: "SourceControl/ChangesView",
  component: ChangesView,
  args: {
    rootDir: "/repo",
    status: makeDirtyStatus(),
    actions: makeGitActions(),
    committing: false,
    selectedPath: null,
    onSelectFile: fn(),
    onViewHistory: fn(),
    onViewBlame: fn(),
    onRestore: fn(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-80 border-r">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    resetStore(useGitStore)
  },
} satisfies Meta<typeof ChangesView>

export default meta
type Story = StoryObj<typeof meta>

export const DirtyTree: Story = {}

export const CleanTree: Story = { args: { status: makeCleanStatus() } }

export const FileSelected: Story = {
  args: { selectedPath: "components/source-control/diff-pane.tsx" },
}

export const StagedOnly: Story = {
  args: {
    status: makeCleanStatus({
      staged: makeDirtyStatus().staged,
      merge: [],
      changes: [],
    }),
  },
}
