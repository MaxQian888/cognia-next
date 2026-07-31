import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CommitGraphView } from "./commit-graph-view"
import { makeHistory, makeRef } from "@/lib/storybook/fixtures/source-control"

// Pure layout component: `assignLanes` derives the SVG lane graph from the
// commits' parent chains, so the merge commit in `makeHistory` produces a fork.
const history = makeHistory(10)

const refs = [
  makeRef("main", { kind: "head", targetHash: history[0].hash }),
  makeRef("origin/main", { kind: "remoteBranch", targetHash: history[1].hash }),
  makeRef("v1.2.0", { kind: "tag", targetHash: history[3].hash }),
]

const meta = {
  title: "SourceControl/CommitGraphView",
  component: CommitGraphView,
  args: {
    commits: history,
    refs,
    selectedCommit: null,
    onSelect: fn(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem] rounded-md border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CommitGraphView>

export default meta
type Story = StoryObj<typeof meta>

export const WithRefs: Story = {}

export const SelectedCommit: Story = { args: { selectedCommit: history[2].hash } }

export const NoRefs: Story = { args: { refs: [] } }

export const Empty: Story = { args: { commits: [], refs: [] } }
