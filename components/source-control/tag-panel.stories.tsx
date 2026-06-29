import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TagPanel } from "./tag-panel"
import { makeGitActions } from "@/lib/storybook/fixtures/source-control"

// The tag list is loaded from the backend (`git_tags`, empty in Storybook), so
// this exercises the create form and the empty-list state of the Sheet.
const meta = {
  title: "SourceControl/TagPanel",
  component: TagPanel,
  args: {
    open: true,
    onOpenChange: fn(),
    rootDir: "/repo",
    actions: makeGitActions(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TagPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = { args: { open: false } }
