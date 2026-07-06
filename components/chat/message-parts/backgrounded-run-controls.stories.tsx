import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { BackgroundedRunControls } from "./backgrounded-run-controls"

const meta = {
  title: "Chat/MessageParts/BackgroundedRunControls",
  component: BackgroundedRunControls,
  parameters: { layout: "padded" },
  args: {
    isRunning: true,
    variant: "icon",
    onAbort: fn(),
    abortAria: "Abort run",
    abortLabel: "Cancel",
    collectLabel: "Collect",
    collectAria: "Collect output",
  },
} satisfies Meta<typeof BackgroundedRunControls>

export default meta
type Story = StoryObj<typeof meta>

// Compact ghost icon used in the chat transcript card.
export const IconRunning: Story = {}

// Labeled buttons used in the desktop Job Center — collect + cancel.
export const LabeledRunning: Story = {
  args: { variant: "labeled", onCollect: fn() },
}

// Finished run: abort is hidden, only collect remains in the labeled variant.
export const LabeledFinished: Story = {
  args: { variant: "labeled", isRunning: false, onCollect: fn() },
}

// Abort in flight — button disabled while the abort settles.
export const Aborting: Story = {
  args: { variant: "labeled", onCollect: fn(), aborting: true },
}
