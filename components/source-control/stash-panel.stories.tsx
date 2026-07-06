import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { StashPanel } from "./stash-panel"
import { makeGitActions, makeStash } from "@/lib/storybook/fixtures/source-control"

// The Sheet portals to the body; `layout: fullscreen` keeps the preview frame
// from adding padding around the right-side drawer.
const meta = {
  title: "SourceControl/StashPanel",
  component: StashPanel,
  args: {
    open: true,
    onOpenChange: fn(),
    stashes: [makeStash(0), makeStash(1), makeStash(2)],
    actions: makeGitActions(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof StashPanel>

export default meta
type Story = StoryObj<typeof meta>

export const WithStashes: Story = {}

export const Empty: Story = { args: { stashes: [] } }

export const SingleStash: Story = {
  args: { stashes: [makeStash(0, { message: "WIP: half-finished diff viewer" })] },
}
