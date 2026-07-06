import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { InteractiveRebaseDialog } from "./interactive-rebase-dialog"
import { makeGitActions } from "@/lib/storybook/fixtures/source-control"

// `base !== null` drives the open state. The commit rows are fetched from the
// backend (`git rebase -i` preview), which is unavailable in Storybook, so the
// dialog shows its title/description and a disabled Apply.
const meta = {
  title: "SourceControl/InteractiveRebaseDialog",
  component: InteractiveRebaseDialog,
  args: {
    rootDir: "/repo",
    base: "HEAD~5",
    onOpenChange: fn(),
    actions: makeGitActions(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof InteractiveRebaseDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = { args: { base: null } }
