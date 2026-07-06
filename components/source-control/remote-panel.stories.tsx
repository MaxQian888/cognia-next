import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RemotePanel } from "./remote-panel"
import { makeGitActions } from "@/lib/storybook/fixtures/source-control"

// The remote list is loaded from the backend (`git_remotes`, empty in
// Storybook), so this exercises the add form and the empty-list state.
const meta = {
  title: "SourceControl/RemotePanel",
  component: RemotePanel,
  args: {
    open: true,
    onOpenChange: fn(),
    rootDir: "/repo",
    actions: makeGitActions(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RemotePanel>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = { args: { open: false } }
