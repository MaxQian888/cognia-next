import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CompareRefsSheet } from "./compare-refs-sheet"

// The ref pickers + changed-file list are backend-driven (empty in Storybook),
// so this exercises the sheet chrome and the "pick both refs" empty state.
const meta = {
  title: "SourceControl/CompareRefsSheet",
  component: CompareRefsSheet,
  args: {
    open: true,
    onOpenChange: fn(),
    rootDir: "/repo",
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CompareRefsSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = { args: { open: false } }
