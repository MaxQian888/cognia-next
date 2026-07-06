import type { Meta, StoryObj } from "@storybook/nextjs"

import { ComputerUseToggle } from "./computer-use-toggle"

// Pure props — `currentValue` drives the label/tint and aria-pressed. Flipping
// OFF→ON triggers a biometric confirm (window.confirm on web) then writes the
// override; that path is exercised on click, the visual state is prop-driven.
const meta = {
  title: "Inbox/ComputerUseToggle",
  component: ComputerUseToggle,
  args: {
    conversationKey: "slack:adapter-1:C1",
    sessionId: "ses_1",
    adapterId: "adapter-1",
    currentValue: false,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ComputerUseToggle>

export default meta
type Story = StoryObj<typeof meta>

export const Off: Story = {}

export const On: Story = { args: { currentValue: true } }
