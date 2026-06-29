import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LoadUnpackedButton } from "./load-unpacked-button"

// "Load unpacked" trigger button (devtools install path). Clicking opens a
// directory picker + pre-install flow that runs on the host; in this Storybook
// the button just renders in its idle state.

const meta = {
  title: "Plugins/Dialogs/LoadUnpackedButton",
  component: LoadUnpackedButton,
  args: { onInstalled: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof LoadUnpackedButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
