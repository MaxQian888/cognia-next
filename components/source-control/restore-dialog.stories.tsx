import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RestoreDialog } from "./restore-dialog"
import { makeGitActions } from "@/lib/storybook/fixtures/source-control"

// `path !== null` drives the open state. The ref datalist is fetched from the
// backend (empty in Storybook) so only the always-present "HEAD" option shows.
const meta = {
  title: "SourceControl/RestoreDialog",
  component: RestoreDialog,
  args: {
    rootDir: "/repo",
    path: "components/source-control/diff-pane.tsx",
    onOpenChange: fn(),
    actions: makeGitActions(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RestoreDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = { args: { path: null } }
